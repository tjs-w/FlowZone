import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build, type BuildOptions } from "esbuild";

import {
  CALLFLOW_SHARED_FLOWZONE_LICENSE_IDS,
  createCallFlowLicenseArtifacts,
  type CallFlowBundleMetafile,
} from "./callflow-license-approvals.js";
import { runFlowZoneBuildPipeline } from "./flowzone-build-pipeline.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const unsupportedOptions = process.argv.slice(2).filter((option) => option !== "--check");
if (unsupportedOptions.length > 0) {
  throw new Error(`Unsupported build option: ${unsupportedOptions[0]}.`);
}
const temporaryRoot = checkOnly ? await mkdtemp(join(tmpdir(), "flowzone-build-")) : root;
const CALLFLOW_BROWSER_BUDGET_BYTES = Math.floor(1.25 * 1024 * 1024);
const CALLFLOW_RUNTIME_BUDGET_BYTES = 5 * 1024 * 1024;

const CALLFLOW_BUILD_CONFIGURATION = {
  bundle: true,
  charset: "utf8",
  sourcemap: false,
} as const satisfies BuildOptions;

interface CompiledBuild {
  readonly destinations: readonly string[];
}

function extractElkLicenseNotices(source: string): string[] {
  const notices = [...source.matchAll(/\/\*{3,}[\s\S]*?\*+\//g)]
    .map((match) => match[0])
    .filter(
      (notice) =>
        /Copyright \(c\) (?:2017|2021) Kiel University and others\./.test(notice) &&
        notice.includes("SPDX-License-Identifier: EPL-2.0 OR GPL-3.0-or-later"),
    );
  if (notices.length !== 2) {
    throw new Error("The pinned ELK bundle must contain its two expected license notices.");
  }
  return notices;
}

function callFlowOutputs(elkLicenseNoticeBanner: string) {
  return [
    {
      source: resolve(root, "packages/callflow-node/src/cli.ts"),
      destination: "server/dist/callflow.cjs",
      options: {
        platform: "node",
        format: "cjs",
        target: "node22",
        minify: true,
      } satisfies BuildOptions,
    },
    {
      source: resolve(root, "packages/callflow-node/src/layout-worker.ts"),
      destination: "server/dist/callflow-layout-worker.cjs",
      options: {
        platform: "node",
        format: "cjs",
        target: "node22",
        minify: true,
        banner: { js: elkLicenseNoticeBanner },
      } satisfies BuildOptions,
    },
    {
      source: resolve(root, "packages/callflow-ui/src/index.tsx"),
      destination: "web/dist/callflow.js",
      options: {
        platform: "browser",
        format: "iife",
        target: "es2022",
        minify: true,
      } satisfies BuildOptions,
    },
  ] as const;
}

async function callFlowServerLicenseMetafile(): Promise<CallFlowBundleMetafile> {
  // CallFlow runs inside the shared FlowZone server. Bundle its internal plugin
  // entry separately for an exact dependency inventory while attributing those
  // byte-contributing inputs to the actual shared server artifact.
  const result = await build({
    absWorkingDir: root,
    ...CALLFLOW_BUILD_CONFIGURATION,
    entryPoints: [resolve(root, "packages/callflow-flowzone/src/plugin.ts")],
    legalComments: "eof",
    logLevel: "silent",
    metafile: true,
    outfile: resolve(temporaryRoot, ".callflow-license-inventory/server.cjs"),
    platform: "node",
    format: "cjs",
    target: "node22",
    minify: false,
    external: ["@flowzone/mcp-server"],
    write: false,
  });
  return { bundle: "server/dist/server.cjs", metafile: result.metafile };
}

async function compile(): Promise<CompiledBuild> {
  const flowZone = await runFlowZoneBuildPipeline({ outputRoot: temporaryRoot, root });
  const elkLicenseNoticeBanner = extractElkLicenseNotices(
    await readFile(resolve(root, "node_modules/elkjs/lib/elk.bundled.js"), "utf8"),
  ).join("\n");
  const outputs = callFlowOutputs(elkLicenseNoticeBanner);
  const callFlowMetafiles: CallFlowBundleMetafile[] = [];
  for (const output of outputs) {
    const result = await build({
      ...output.options,
      absWorkingDir: root,
      ...CALLFLOW_BUILD_CONFIGURATION,
      entryPoints: [output.source],
      legalComments: "eof",
      logLevel: "info",
      metafile: true,
      outfile: resolve(temporaryRoot, output.destination),
    });
    callFlowMetafiles.push({ bundle: output.destination, metafile: result.metafile });
    if (output.destination === "server/dist/callflow.cjs") {
      const cliPath = resolve(temporaryRoot, output.destination);
      const cli = await readFile(cliPath, "utf8");
      await writeFile(cliPath, cli.replace(/[ \t]+$/gm, ""));
    }
  }
  callFlowMetafiles.push(await callFlowServerLicenseMetafile());
  const sharedServerBundle = flowZone.bundles.find(
    (bundle) => bundle.bundle === "server/dist/server.cjs",
  );
  if (!sharedServerBundle) {
    throw new Error("The shared FlowZone server metafile is unavailable for licensing.");
  }
  callFlowMetafiles.push({
    ...sharedServerBundle,
    includePackageIds: CALLFLOW_SHARED_FLOWZONE_LICENSE_IDS,
  });

  const licenseDirectory = resolve(temporaryRoot, "licenses/callflow");
  await rm(licenseDirectory, { force: true, recursive: true });
  await mkdir(licenseDirectory, { recursive: true });
  for (const artifact of await createCallFlowLicenseArtifacts(root, callFlowMetafiles)) {
    await writeFile(resolve(licenseDirectory, artifact.path), artifact.content);
  }
  return {
    destinations: [
      ...flowZone.destinations,
      ...outputs.map((output) => output.destination),
      "web/dist/callflow.css",
    ],
  };
}

async function listRelativeFiles(directory: string, relativePath = ""): Promise<string[]> {
  const entries = await readdir(resolve(directory, relativePath), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const path = relativePath ? join(relativePath, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...(await listRelativeFiles(directory, path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Generated license artifact is not a regular file: ${path}.`);
  }
  return files;
}

async function assertArtifactParity(destinations: readonly string[]): Promise<void> {
  for (const destination of destinations) {
    const expected = await readFile(resolve(root, destination));
    const actual = await readFile(resolve(temporaryRoot, destination));
    if (!expected.equals(actual)) {
      throw new Error(`${destination} differs from a clean build. Run bun run build.`);
    }
  }
  const licenseDirectory = "licenses/callflow";
  const [expectedLicenseFiles, actualLicenseFiles] = await Promise.all([
    listRelativeFiles(resolve(root, licenseDirectory)),
    listRelativeFiles(resolve(temporaryRoot, licenseDirectory)),
  ]);
  if (JSON.stringify(expectedLicenseFiles) !== JSON.stringify(actualLicenseFiles)) {
    throw new Error(`${licenseDirectory} differs from a clean dependency inventory.`);
  }
  for (const path of expectedLicenseFiles) {
    const expected = await readFile(resolve(root, licenseDirectory, path));
    const actual = await readFile(resolve(temporaryRoot, licenseDirectory, path));
    if (!expected.equals(actual)) {
      throw new Error(`${licenseDirectory}/${path} differs from a clean dependency inventory.`);
    }
  }
}

async function assertCallFlowBudgets(): Promise<void> {
  const runtimeBytes = await Promise.all([
    stat(resolve(temporaryRoot, "server/dist/server.cjs")),
    stat(resolve(temporaryRoot, "server/dist/callflow.cjs")),
    stat(resolve(temporaryRoot, "server/dist/callflow-layout-worker.cjs")),
  ]).then((values) => values.reduce((total, value) => total + value.size, 0));
  const browserBytes = await Promise.all([
    stat(resolve(root, "web/callflow.html")),
    stat(resolve(temporaryRoot, "web/dist/callflow.js")),
    stat(resolve(temporaryRoot, "web/dist/callflow.css")),
  ]).then((values) => values.reduce((total, value) => total + value.size, 0));

  if (runtimeBytes > CALLFLOW_RUNTIME_BUDGET_BYTES) {
    throw new Error(
      `The shared FlowZone MCP server and CallFlow CLI bundles are ${runtimeBytes} bytes; the combined limit is 5 MiB.`,
    );
  }
  if (browserBytes > CALLFLOW_BROWSER_BUDGET_BYTES) {
    throw new Error(`CallFlow browser payload is ${browserBytes} bytes; the limit is 1.25 MiB.`);
  }
}

try {
  const compiled = await compile();
  await assertCallFlowBudgets();
  if (checkOnly) await assertArtifactParity(compiled.destinations);
} finally {
  if (checkOnly) await rm(temporaryRoot, { force: true, recursive: true });
}

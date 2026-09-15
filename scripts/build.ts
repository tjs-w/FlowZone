import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build, type BuildOptions } from "esbuild";

import {
  createCallFlowLicenseArtifacts,
  type CallFlowBundleMetafile,
} from "./callflow-license-approvals.js";
import { runLegacyBuildPipeline } from "./legacy-build-pipeline.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const callFlowOnly = process.argv.includes("--callflow-only");
if (checkOnly && process.argv.includes("--write")) {
  throw new Error("Build check mode cannot write artifacts.");
}
const temporaryRoot = checkOnly ? await mkdtemp(join(tmpdir(), "flowzone-build-")) : root;
const CALLFLOW_BROWSER_BUDGET_BYTES = Math.floor(1.25 * 1024 * 1024);
const CALLFLOW_SERVER_BUDGET_BYTES = 5 * 1024 * 1024;
const LOCKED_FLOWZONE_INPUT_CLOSURE_DIGEST =
  "9c3a70c00e2b044e13a15ab15468a09de940414456b600010f6b1ca80cdd6b78";

const CALLFLOW_BUILD_CONFIGURATION = {
  bundle: true,
  charset: "utf8",
  sourcemap: false,
} as const satisfies BuildOptions;

interface CompiledBuild {
  readonly callFlowDestinations: readonly string[];
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
      source: resolve(root, "packages/callflow-mcp/src/main.ts"),
      destination: "plugins/callflow/server/dist/server.cjs",
      options: {
        platform: "node",
        format: "cjs",
        target: "node22",
        minify: false,
      } satisfies BuildOptions,
    },
    {
      source: resolve(root, "packages/callflow-node/src/cli.ts"),
      destination: "plugins/callflow/server/dist/callflow.cjs",
      options: {
        platform: "node",
        format: "cjs",
        target: "node22",
        minify: true,
      } satisfies BuildOptions,
    },
    {
      source: resolve(root, "packages/callflow-node/src/layout-worker.ts"),
      destination: "plugins/callflow/server/dist/layout-worker.cjs",
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
      destination: "plugins/callflow/web/dist/callflow.js",
      options: {
        platform: "browser",
        format: "iife",
        target: "es2022",
        minify: true,
      } satisfies BuildOptions,
    },
  ] as const;
}

async function compile(): Promise<CompiledBuild> {
  if (!callFlowOnly) {
    await runLegacyBuildPipeline({
      checkOnly,
      expectedInputClosureDigest: LOCKED_FLOWZONE_INPUT_CLOSURE_DIGEST,
      outputRoot: temporaryRoot,
      root,
    });
  }

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
    if (output.destination === "plugins/callflow/server/dist/callflow.cjs") {
      const cliPath = resolve(temporaryRoot, output.destination);
      const cli = await readFile(cliPath, "utf8");
      await writeFile(cliPath, cli.replace(/[ \t]+$/gm, ""));
    }
  }

  const licenseDirectory = resolve(temporaryRoot, "plugins/callflow/licenses");
  await rm(licenseDirectory, { force: true, recursive: true });
  await mkdir(licenseDirectory, { recursive: true });
  for (const artifact of await createCallFlowLicenseArtifacts(root, callFlowMetafiles)) {
    await writeFile(resolve(licenseDirectory, artifact.path), artifact.content);
  }
  return { callFlowDestinations: outputs.map((output) => output.destination) };
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
  const expectedCallFlowCss = await readFile(
    resolve(root, "plugins/callflow/web/dist/callflow.css"),
  );
  const actualCallFlowCss = await readFile(
    resolve(temporaryRoot, "plugins/callflow/web/dist/callflow.css"),
  );
  if (!expectedCallFlowCss.equals(actualCallFlowCss)) {
    throw new Error(
      "plugins/callflow/web/dist/callflow.css differs from a clean build. Run bun run build.",
    );
  }
  const licenseDirectory = "plugins/callflow/licenses";
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
  const serverBytes = await Promise.all([
    stat(resolve(temporaryRoot, "plugins/callflow/server/dist/server.cjs")),
    stat(resolve(temporaryRoot, "plugins/callflow/server/dist/callflow.cjs")),
    stat(resolve(temporaryRoot, "plugins/callflow/server/dist/layout-worker.cjs")),
  ]).then((values) => values.reduce((total, value) => total + value.size, 0));
  const browserBytes = await Promise.all([
    stat(resolve(root, "plugins/callflow/web/callflow.html")),
    stat(resolve(temporaryRoot, "plugins/callflow/web/dist/callflow.js")),
    stat(resolve(temporaryRoot, "plugins/callflow/web/dist/callflow.css")),
  ]).then((values) => values.reduce((total, value) => total + value.size, 0));

  if (serverBytes > CALLFLOW_SERVER_BUDGET_BYTES) {
    throw new Error(
      `CallFlow server bundles are ${serverBytes} bytes; the combined limit is 5 MiB.`,
    );
  }
  if (browserBytes > CALLFLOW_BROWSER_BUDGET_BYTES) {
    throw new Error(`CallFlow browser payload is ${browserBytes} bytes; the limit is 1.25 MiB.`);
  }
}

try {
  const compiled = await compile();
  await assertCallFlowBudgets();
  if (checkOnly) await assertArtifactParity(compiled.callFlowDestinations);
} finally {
  if (checkOnly) await rm(temporaryRoot, { force: true, recursive: true });
}

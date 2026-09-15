import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build, type BuildOptions } from "esbuild";

import {
  CALLFLOW_LICENSE_APPROVALS,
  CALLFLOW_SHARED_FLOWZONE_LICENSE_IDS,
  createCallFlowLicenseArtifacts,
  type CallFlowBundleMetafile,
} from "./callflow-license-approvals.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const licenseDirectory = resolve(root, "licenses/callflow");

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

const expectedManifestPins = [
  {
    path: "package.json",
    workspace: "",
    dependencies: {
      "@modelcontextprotocol/ext-apps": "1.7.5",
      "@modelcontextprotocol/sdk": "1.30.0",
      "@openai/apps-sdk-ui": "0.2.2",
      "@xyflow/react": "12.11.6",
      elkjs: "0.12.0",
      react: "19.2.8",
      "react-dom": "19.2.8",
      zod: "4.4.3",
    },
  },
  {
    path: "packages/callflow-contracts/package.json",
    workspace: "packages/callflow-contracts",
    dependencies: { zod: "4.4.3" },
  },
  {
    path: "packages/callflow-node/package.json",
    workspace: "packages/callflow-node",
    dependencies: { elkjs: "0.12.0", zod: "4.4.3" },
  },
  {
    path: "packages/callflow-flowzone/package.json",
    workspace: "packages/callflow-flowzone",
    dependencies: { zod: "4.4.3" },
  },
  {
    path: "packages/callflow-ui/package.json",
    workspace: "packages/callflow-ui",
    dependencies: {
      "@modelcontextprotocol/ext-apps": "1.7.5",
      "@modelcontextprotocol/sdk": "1.30.0",
      "@openai/apps-sdk-ui": "0.2.2",
      "@xyflow/react": "12.11.6",
      react: "19.2.8",
      "react-dom": "19.2.8",
    },
  },
] as const;

interface LicenseBundleSpec {
  readonly source: string;
  readonly destination: string;
  readonly includePackageIds?: readonly string[];
  readonly options: BuildOptions;
}

const bundles: readonly LicenseBundleSpec[] = [
  {
    source: "packages/callflow-flowzone/src/plugin.ts",
    destination: "server/dist/server.cjs",
    options: {
      platform: "node",
      format: "cjs",
      target: "node22",
      minify: false,
      external: ["@flowzone/mcp-server"],
    },
  },
  {
    source: "packages/callflow-node/src/cli.ts",
    destination: "server/dist/callflow.cjs",
    options: { platform: "node", format: "cjs", target: "node22", minify: true },
  },
  {
    source: "packages/callflow-node/src/layout-worker.ts",
    destination: "server/dist/callflow-layout-worker.cjs",
    options: { platform: "node", format: "cjs", target: "node22", minify: true },
  },
  {
    source: "packages/callflow-ui/src/index.tsx",
    destination: "web/dist/callflow.js",
    options: { platform: "browser", format: "iife", target: "es2022", minify: true },
  },
  {
    source: "server/src/main.ts",
    destination: "server/dist/server.cjs",
    includePackageIds: CALLFLOW_SHARED_FLOWZONE_LICENSE_IDS,
    options: { platform: "node", format: "cjs", target: "node22", minify: false },
  },
];

async function listRelativeFiles(directory: string, relative = ""): Promise<string[]> {
  const entries = await readdir(resolve(directory, relative), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = relative ? join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...(await listRelativeFiles(directory, path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Shipped license artifact is not a regular file: ${path}.`);
  }
  return files;
}

const metafiles: CallFlowBundleMetafile[] = [];
for (const bundle of bundles) {
  const result = await build({
    ...bundle.options,
    absWorkingDir: root,
    bundle: true,
    entryPoints: [resolve(root, bundle.source)],
    legalComments: "eof",
    logLevel: "silent",
    metafile: true,
    outfile: resolve(root, ".callflow-license-inventory", bundle.destination),
    sourcemap: false,
    write: false,
  });
  metafiles.push({
    bundle: bundle.destination,
    metafile: result.metafile,
    ...(bundle.includePackageIds ? { includePackageIds: bundle.includePackageIds } : {}),
  });
}

const expected = await createCallFlowLicenseArtifacts(root, metafiles);
const expectedPaths = expected.map((artifact) => artifact.path);
const actualPaths = await listRelativeFiles(licenseDirectory);
if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
  throw new Error(
    `Shipped CallFlow license inventory differs from its bundles. Expected ${expectedPaths.join(", ")}; ` +
      `found ${actualPaths.join(", ")}. Run bun run build.`,
  );
}
for (const artifact of expected) {
  const actual = await readFile(resolve(licenseDirectory, artifact.path));
  if (!actual.equals(Buffer.from(artifact.content))) {
    throw new Error(`licenses/callflow/${artifact.path} differs from its bundle inventory.`);
  }
}

const lockfile = asRecord(
  Bun.JSONC.parse(await readFile(resolve(root, "bun.lock"), "utf8")),
  "bun.lock",
);
const lockWorkspaces = asRecord(lockfile["workspaces"], "bun.lock workspaces");
for (const expectedManifest of expectedManifestPins) {
  const manifest = asRecord(
    JSON.parse(await readFile(resolve(root, expectedManifest.path), "utf8")) as unknown,
    expectedManifest.path,
  );
  const manifestDependencies = asRecord(
    manifest["dependencies"],
    `${expectedManifest.path} dependencies`,
  );
  const lockWorkspace = asRecord(
    lockWorkspaces[expectedManifest.workspace],
    `bun.lock workspace ${expectedManifest.workspace || "root"}`,
  );
  const lockDependencies = asRecord(
    lockWorkspace["dependencies"],
    `bun.lock workspace ${expectedManifest.workspace || "root"} dependencies`,
  );
  for (const [name, version] of Object.entries(expectedManifest.dependencies)) {
    if (manifestDependencies[name] !== version) {
      throw new Error(
        `${expectedManifest.path}: ${name} must remain pinned exactly to ${version}.`,
      );
    }
    if (lockDependencies[name] !== version) {
      throw new Error(
        `bun.lock workspace ${expectedManifest.workspace || "root"}: ${name} must remain pinned exactly to ${version}.`,
      );
    }
  }
}

const notices = await readFile(resolve(root, "THIRD_PARTY_NOTICES.md"), "utf8");
if (
  !notices.includes("licenses/callflow/THIRD_PARTY_NOTICES.md") ||
  !notices.includes("EPL-2.0 option")
) {
  throw new Error(
    "THIRD_PARTY_NOTICES.md must identify CallFlow's generated notice and ELK choice.",
  );
}

const layoutWorker = await readFile(
  resolve(root, "server/dist/callflow-layout-worker.cjs"),
  "utf8",
);
const elkBundleSource = await readFile(
  resolve(root, "node_modules/elkjs/lib/elk.bundled.js"),
  "utf8",
);
const elkNotices = [...elkBundleSource.matchAll(/\/\*{3,}[\s\S]*?\*+\//g)]
  .map((match) => match[0])
  .filter(
    (notice) =>
      /Copyright \(c\) (?:2017|2021) Kiel University and others\./.test(notice) &&
      notice.includes("SPDX-License-Identifier: EPL-2.0 OR GPL-3.0-or-later"),
  );
if (elkNotices.length !== 2) {
  throw new Error("The pinned ELK package does not contain its two expected license notices.");
}
if (!layoutWorker.startsWith(elkNotices.join("\n"))) {
  throw new Error("The bundled ELK worker must begin with both complete upstream license notices.");
}
for (const notice of elkNotices) {
  if (layoutWorker.indexOf(notice) !== layoutWorker.lastIndexOf(notice)) {
    throw new Error("The bundled ELK worker must retain each upstream notice exactly once.");
  }
}

console.log(
  `CallFlow's ${String(CALLFLOW_LICENSE_APPROVALS.length)} bundled dependencies are exactly approved, inventoried, and licensed.`,
);

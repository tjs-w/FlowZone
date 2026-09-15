import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { build, transform, type BuildOptions } from "esbuild";
import { compile as compileTailwind } from "tailwindcss";

// Keep a narrow explicit ceiling while allowing bounded activity history, the
// session picker, the accessible context menu, the deterministic Executive Brief,
// bounded bulk-selection controls, cached-first linked-task synchronization,
// compact note editing, and the three offline Latin variable fonts used by
// Dyna's typography hierarchy.
const DYNA_BROWSER_BUDGET_KIB = 940;
const DYNA_BROWSER_BUDGET_BYTES = DYNA_BROWSER_BUDGET_KIB * 1024;
const LEGACY_SERVER_BUDGET_BYTES = 5 * 1024 * 1024;
const LEGACY_BROWSER_BUDGET_BYTES = 4 * 1024 * 1024;

const LOCKED_FLOWZONE_ARTIFACT_DIGESTS = {
  ".codex-plugin/plugin.json": "3cbc199f7be1aef124bbf04224967667708834983a0f6e1cf32f1782557675f1",
  ".mcp.json": "14399c61c2f3dca6c53200f82e3fd5226c0d0e597b76cd2d31bff6fcb7b64a9e",
  "server/dist/server.cjs": "f9eddbd2fbe2f9853bbeb5ad7bf2fc1e5cc74f87cc1ebd6764bd1919696403ef",
  "server/dist/flowzone-publish.cjs":
    "95fae6c71abf9db4e2f5c9845c08572c813a9859ce522eed582b8bc67ef032e5",
  "server/dist/dyna.cjs": "1a6a290df106f0381d66fd7f767489d0c4450f0e2983de5529e658bb173879c1",
  "web/flowzone.html": "ef8874ed10eb24437c66d5d8c560822d8ef22de4577eae91f03a4a8e8f9120f8",
  "web/dist/flowzone.js": "a82698da66e7a886afa6c19b9b2078cdf2ba461549f8f3b7dcc5e503d301fdf4",
  "web/dyna.html": "7355b0e07b4545c0941cf36f8422a75320d7377b97207a94fad62712047fd874",
  "web/dist/dyna.js": "d1756a6d98b4e912864c671771f719985526ae351dbc3c583874562625652a3f",
  "web/dist/dyna.css": "82c2a877139e1e2c66f8cbbe034ba091e646d4ecf151aba997e1f62250ef6fc9",
} as const;

const LEGACY_STATIC_INPUTS = [
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "bin",
  "bunfig.toml",
  "scripts/legacy-build-pipeline.ts",
  "scripts/tsconfig.json",
  "server/tsconfig.json",
  "skills",
  "tsconfig.base.json",
  "web/flowzone.html",
  "web/dyna.html",
] as const;

const LEGACY_BUILD_CONFIGURATION = {
  bundle: true,
  charset: "utf8",
  sourcemap: false,
} as const satisfies BuildOptions;

const LEGACY_BUILD_OUTPUTS = [
  {
    source: "server/src/main.ts",
    destination: "server/dist/server.cjs",
    options: {
      platform: "node",
      format: "cjs",
      target: "node22",
      minify: false,
    } satisfies BuildOptions,
  },
  {
    source: "server/src/publish.ts",
    destination: "server/dist/flowzone-publish.cjs",
    options: {
      platform: "node",
      format: "cjs",
      target: "node22",
      minify: true,
    } satisfies BuildOptions,
  },
  {
    source: "server/src/dyna.ts",
    destination: "server/dist/dyna.cjs",
    options: {
      platform: "node",
      format: "cjs",
      target: "node22",
      minify: true,
    } satisfies BuildOptions,
  },
  {
    source: "packages/host-mcp-apps/src/browser-entry.ts",
    destination: "web/dist/flowzone.js",
    options: {
      platform: "browser",
      format: "iife",
      target: "es2022",
      minify: true,
    } satisfies BuildOptions,
  },
  {
    source: "packages/dyna-ui/src/index.tsx",
    destination: "web/dist/dyna.js",
    options: {
      platform: "browser",
      format: "iife",
      target: "es2022",
      minify: true,
      loader: { ".woff2": "dataurl" },
    } satisfies BuildOptions,
  },
] as const;

const WHITESPACE_TRIMMED_OUTPUTS = new Set([
  "server/dist/flowzone-publish.cjs",
  "server/dist/dyna.cjs",
]);

interface WorkspacePackageMetadata {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly type?: unknown;
  readonly exports?: unknown;
  readonly dependencies?: unknown;
  readonly devDependencies?: unknown;
  readonly optionalDependencies?: unknown;
  readonly peerDependencies?: unknown;
}

interface LegacyWorkspacePackage {
  readonly directory: string;
  readonly manifestDigest: string;
  readonly name: string;
  readonly version: string;
  readonly type?: unknown;
  readonly exports?: unknown;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly tsconfigDigest?: string;
}

interface LegacyRootConfiguration extends Readonly<Record<string, unknown>> {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
}

interface LegacyWorkspaceConfiguration {
  readonly root: LegacyRootConfiguration;
  readonly packages: readonly LegacyWorkspacePackage[];
}

interface LockFile {
  readonly lockfileVersion: unknown;
  readonly configVersion: unknown;
  readonly packages: Readonly<Record<string, readonly unknown[]>>;
}

export interface LegacyBuildPipelineOptions {
  readonly checkOnly: boolean;
  readonly expectedInputClosureDigest: string;
  readonly outputRoot: string;
  readonly root: string;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedRelativePath(path: string): string {
  return path.split("\\").join("/");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function listRelativeFiles(directory: string, relativePath = ""): Promise<string[]> {
  const entries = await readdir(resolve(directory, relativePath), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => compareCodeUnits(left.name, right.name))) {
    const path = relativePath ? join(relativePath, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...(await listRelativeFiles(directory, path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Legacy build input is not a regular file: ${path}.`);
  }
  return files;
}

function stringRecord(value: unknown, label: string): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const entries = Object.entries(value);
  for (const [name, version] of entries) {
    if (typeof version !== "string") throw new Error(`${label}.${name} must be a string.`);
  }
  return Object.fromEntries(entries);
}

async function legacyPackageDirectories(root: string): Promise<string[]> {
  return (await readdir(resolve(root, "packages"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("callflow-"))
    .map((entry) => entry.name)
    .sort(compareCodeUnits);
}

async function legacyWorkspaceConfiguration(root: string): Promise<LegacyWorkspaceConfiguration> {
  const parsedRootPackage: unknown = JSON.parse(
    await readFile(resolve(root, "package.json"), "utf8"),
  );
  if (
    !parsedRootPackage ||
    typeof parsedRootPackage !== "object" ||
    Array.isArray(parsedRootPackage)
  ) {
    throw new Error("Root package.json must contain an object.");
  }
  const rootPackage = parsedRootPackage as Readonly<Record<string, unknown>>;
  const callFlowRootDependencies = new Set(["@xyflow/react", "elkjs"]);
  const legacyRootDependencies = Object.fromEntries(
    Object.entries(stringRecord(rootPackage["dependencies"], "root dependencies")).filter(
      ([name]) => !callFlowRootDependencies.has(name),
    ),
  );
  const callFlowRootScripts = new Set(["build:callflow", "build:callflow:check"]);
  const legacyRootScripts = Object.fromEntries(
    Object.entries(stringRecord(rootPackage["scripts"], "root scripts")).filter(
      ([name]) => !callFlowRootScripts.has(name),
    ),
  );
  const packageDirectories = await legacyPackageDirectories(root);
  const packages = await Promise.all(
    packageDirectories.map(async (directory) => {
      const packageRoot = resolve(root, "packages", directory);
      const manifestSource = await readFile(resolve(packageRoot, "package.json"), "utf8");
      const manifest = JSON.parse(manifestSource) as WorkspacePackageMetadata;
      const tsconfigPath = resolve(packageRoot, "tsconfig.json");
      const tsconfigDigest = await readFile(tsconfigPath)
        .then((content) => sha256(content))
        .catch(() => undefined);
      if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
        throw new Error(`Legacy workspace package metadata is invalid: ${directory}.`);
      }
      return {
        directory,
        manifestDigest: sha256(manifestSource),
        name: manifest.name,
        version: manifest.version,
        type: manifest.type,
        exports: manifest.exports,
        dependencies: stringRecord(manifest.dependencies, `${directory} dependencies`),
        devDependencies: stringRecord(manifest.devDependencies, `${directory} devDependencies`),
        optionalDependencies: stringRecord(
          manifest.optionalDependencies,
          `${directory} optionalDependencies`,
        ),
        peerDependencies: stringRecord(manifest.peerDependencies, `${directory} peerDependencies`),
        ...(tsconfigDigest ? { tsconfigDigest } : {}),
      };
    }),
  );
  return {
    root: {
      ...rootPackage,
      scripts: legacyRootScripts,
      dependencies: legacyRootDependencies,
      devDependencies: stringRecord(rootPackage["devDependencies"], "root devDependencies"),
      optionalDependencies: stringRecord(
        rootPackage["optionalDependencies"],
        "root optionalDependencies",
      ),
      peerDependencies: stringRecord(rootPackage["peerDependencies"], "root peerDependencies"),
    },
    packages,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function parseTrackedBunLock(source: string): unknown {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (character === ",") {
      let next = index + 1;
      while (next < source.length && /\s/u.test(source[next] ?? "")) next += 1;
      if (source[next] === "}" || source[next] === "]") continue;
    }
    result += character;
  }
  return JSON.parse(result) as unknown;
}

function lockFile(value: unknown): LockFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("bun.lock must contain an object.");
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  const packages = candidate["packages"];
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) {
    throw new Error("bun.lock does not contain a package table.");
  }
  for (const [key, entry] of Object.entries(packages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") {
      throw new Error(`bun.lock package entry is invalid: ${key}.`);
    }
  }
  return {
    lockfileVersion: candidate["lockfileVersion"],
    configVersion: candidate["configVersion"],
    packages: packages as Readonly<Record<string, readonly unknown[]>>,
  };
}

function lockPackageMetadata(entry: readonly unknown[]): Readonly<Record<string, unknown>> {
  const metadata = entry[2];
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Readonly<Record<string, unknown>>)
    : {};
}

function lockPackagePath(key: string): string[] {
  const segments = key.split("/");
  const packageNames: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? "";
    if (!segment) throw new Error(`bun.lock package key is invalid: ${key}.`);
    if (!segment.startsWith("@")) {
      packageNames.push(segment);
      continue;
    }
    const scopedName = segments[index + 1];
    if (!scopedName) throw new Error(`bun.lock scoped package key is invalid: ${key}.`);
    packageNames.push(`${segment}/${scopedName}`);
    index += 1;
  }
  return packageNames;
}

function resolveLockPackageKey(
  packages: Readonly<Record<string, readonly unknown[]>>,
  dependencyName: string,
  parentKey?: string,
): string | undefined {
  const candidates: string[] = [];
  if (parentKey) {
    const packagePath = lockPackagePath(parentKey);
    for (let length = packagePath.length; length > 0; length -= 1) {
      candidates.push(`${packagePath.slice(0, length).join("/")}/${dependencyName}`);
    }
  }
  candidates.push(dependencyName);
  return candidates.find((candidate) => packages[candidate] !== undefined);
}

async function legacyLockClosure(
  root: string,
  workspace: LegacyWorkspaceConfiguration,
): Promise<unknown> {
  const parsed = lockFile(parseTrackedBunLock(await readFile(resolve(root, "bun.lock"), "utf8")));
  const pending: {
    readonly name: string;
    readonly optional: boolean;
    readonly parentKey: string | undefined;
  }[] = [];
  const enqueue = (
    dependencies: Readonly<Record<string, string>>,
    optional: boolean,
    parentKey?: string,
  ): void => {
    for (const [name, version] of Object.entries(dependencies)) {
      if (!version.startsWith("workspace:")) pending.push({ name, optional, parentKey });
    }
  };
  enqueue(workspace.root.dependencies, false);
  enqueue(workspace.root.optionalDependencies, true);
  enqueue(workspace.root.peerDependencies, true);
  pending.push({ name: "esbuild", optional: false, parentKey: undefined });
  for (const entry of workspace.packages) {
    enqueue(entry.dependencies, false, entry.name);
    enqueue(entry.optionalDependencies, true, entry.name);
    enqueue(entry.peerDependencies, true, entry.name);
  }
  pending.sort((left, right) =>
    compareCodeUnits(
      `${left.parentKey ?? ""}:${left.name}:${String(left.optional)}`,
      `${right.parentKey ?? ""}:${right.name}:${String(right.optional)}`,
    ),
  );
  const selected = new Map<string, readonly unknown[]>();
  while (pending.length > 0) {
    const dependency = pending.shift();
    if (!dependency) break;
    const key = resolveLockPackageKey(parsed.packages, dependency.name, dependency.parentKey);
    if (!key) {
      if (dependency.optional) continue;
      throw new Error(`bun.lock does not resolve legacy dependency ${dependency.name}.`);
    }
    if (selected.has(key)) continue;
    const entry = parsed.packages[key];
    if (!entry) throw new Error(`bun.lock package entry disappeared: ${key}.`);
    selected.set(key, entry);
    const metadata = lockPackageMetadata(entry);
    for (const field of ["dependencies", "optionalDependencies"] as const) {
      const dependencies = stringRecord(metadata[field], `bun.lock ${key} ${field}`);
      for (const name of Object.keys(dependencies).sort(compareCodeUnits)) {
        pending.push({ name, optional: field === "optionalDependencies", parentKey: key });
      }
    }
    const peerDependencies = stringRecord(metadata["peerDependencies"], `bun.lock ${key} peers`);
    for (const name of Object.keys(peerDependencies).sort(compareCodeUnits)) {
      pending.push({ name, optional: true, parentKey: key });
    }
  }
  return {
    lockfileVersion: parsed.lockfileVersion,
    configVersion: parsed.configVersion,
    packages: [...selected.entries()].sort(([left], [right]) => compareCodeUnits(left, right)),
  };
}

async function legacyInputClosureDigest(root: string): Promise<string> {
  const records = new Set<string>();
  const workspace = await legacyWorkspaceConfiguration(root);
  const sourceInputs = [
    ...LEGACY_STATIC_INPUTS,
    "server/src",
    ...workspace.packages.map((entry) => `packages/${entry.directory}/src`),
  ];
  for (const input of sourceInputs) {
    const inputPath = resolve(root, input);
    const inputStat = await stat(inputPath);
    const files = inputStat.isDirectory() ? await listRelativeFiles(inputPath) : [""];
    for (const child of files) {
      const path = child ? resolve(inputPath, child) : inputPath;
      const identity = child ? `${input}/${normalizedRelativePath(child)}` : input;
      records.add(`workspace:${identity}:${sha256(await readFile(path))}`);
    }
  }
  records.add(
    `configuration:${canonicalJson({
      budgets: {
        serverBytes: LEGACY_SERVER_BUDGET_BYTES,
        browserBytes: LEGACY_BROWSER_BUDGET_BYTES,
        dynaBytes: DYNA_BROWSER_BUDGET_BYTES,
      },
      runtime: "bun@1.4.0",
      workspace,
      resolvedDependencies: await legacyLockClosure(root, workspace),
    })}`,
  );
  return sha256([...records].sort(compareCodeUnits).join("\n"));
}

async function buildLegacyArtifacts(root: string, outputRoot: string): Promise<void> {
  for (const output of LEGACY_BUILD_OUTPUTS) {
    await build({
      ...output.options,
      absWorkingDir: root,
      ...LEGACY_BUILD_CONFIGURATION,
      entryPoints: [resolve(root, output.source)],
      legalComments: "none",
      logLevel: "info",
      outfile: resolve(outputRoot, output.destination),
    });
    if (WHITESPACE_TRIMMED_OUTPUTS.has(output.destination)) {
      const outputPath = resolve(outputRoot, output.destination);
      const content = await readFile(outputPath, "utf8");
      await writeFile(outputPath, content.replace(/[ \t]+$/gm, ""));
    }
  }

  const dynaStylesheetPath = resolve(outputRoot, "web/dist/dyna.css");
  const dynaStylesheet = await readFile(dynaStylesheetPath, "utf8");
  const compiledStylesheet = await compileTailwind(dynaStylesheet, { base: root });
  const optimizedStylesheet = await transform(compiledStylesheet.build([]), {
    loader: "css",
    minify: true,
  });
  await writeFile(dynaStylesheetPath, optimizedStylesheet.code);
}

async function assertLegacyBudgets(root: string, outputRoot: string): Promise<void> {
  const serverBytes = await Promise.all([
    stat(resolve(outputRoot, "server/dist/server.cjs")),
    stat(resolve(outputRoot, "server/dist/flowzone-publish.cjs")),
    stat(resolve(outputRoot, "server/dist/dyna.cjs")),
  ]).then((values) => values.reduce((total, value) => total + value.size, 0));
  const browserBytes = await Promise.all([
    stat(resolve(root, "web/flowzone.html")),
    stat(resolve(outputRoot, "web/dist/flowzone.js")),
  ]).then((values) => values.reduce((total, value) => total + value.size, 0));
  const dynaBytes = await Promise.all([
    stat(resolve(root, "web/dyna.html")),
    stat(resolve(outputRoot, "web/dist/dyna.js")),
    stat(resolve(outputRoot, "web/dist/dyna.css")),
  ]).then((values) => values.reduce((total, value) => total + value.size, 0));

  if (serverBytes > LEGACY_SERVER_BUDGET_BYTES) {
    throw new Error(`Server bundles are ${serverBytes} bytes; the combined limit is 5 MiB.`);
  }
  // Mermaid is bundled into the single offline MCP Apps resource so the strict CSP
  // never needs a script or module origin. Keep the resulting one-file payload bounded.
  if (browserBytes > LEGACY_BROWSER_BUDGET_BYTES) {
    throw new Error(`Browser payload is ${browserBytes} bytes; the limit is 4 MiB.`);
  }
  if (dynaBytes > DYNA_BROWSER_BUDGET_BYTES) {
    throw new Error(
      `Dyna browser payload is ${dynaBytes} bytes; the limit is ${String(DYNA_BROWSER_BUDGET_KIB)} KiB.`,
    );
  }
}

async function assertLockedFlowZoneArtifacts(root: string): Promise<void> {
  for (const [path, expectedDigest] of Object.entries(LOCKED_FLOWZONE_ARTIFACT_DIGESTS)) {
    const digest = sha256(await readFile(resolve(root, path)));
    if (digest !== expectedDigest) {
      throw new Error(
        `${path} changed even though CallFlow must not alter existing FlowZone shipping artifacts.`,
      );
    }
  }
}

/**
 * The complete executable and validation path for the immutable, pre-CallFlow
 * FlowZone bundles. This module is part of its own locked input closure; the
 * expected digest stays in the CallFlow wrapper to avoid a self-referential hash.
 */
export async function runLegacyBuildPipeline({
  checkOnly,
  expectedInputClosureDigest,
  outputRoot,
  root,
}: LegacyBuildPipelineOptions): Promise<void> {
  await buildLegacyArtifacts(root, outputRoot);
  await assertLegacyBudgets(root, outputRoot);
  if (!checkOnly) return;

  await assertLockedFlowZoneArtifacts(root);
  const actualDigest = await legacyInputClosureDigest(root);
  if (actualDigest !== expectedInputClosureDigest) {
    throw new Error(
      `The immutable FlowZone build-input closure changed (${actualDigest}); CallFlow must not alter legacy sources, static inputs, configuration, or resolved dependencies.`,
    );
  }
}

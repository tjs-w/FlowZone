import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { build, transform, type BuildOptions, type Metafile } from "esbuild";
import { compile as compileTailwind } from "tailwindcss";

// Keep a narrow explicit ceiling while allowing bounded activity history, the
// session picker, the accessible context menu, the deterministic Executive Brief,
// bounded bulk-selection controls, cached-first linked-task synchronization,
// compact note editing, and the three offline Latin variable fonts used by
// Dyna's typography hierarchy.
const DYNA_BROWSER_BUDGET_KIB = 960;
const DYNA_BROWSER_BUDGET_BYTES = DYNA_BROWSER_BUDGET_KIB * 1024;
const FLOWZONE_SERVER_BUDGET_BYTES = 5 * 1024 * 1024;
const FLOWZONE_BROWSER_BUDGET_BYTES = 4 * 1024 * 1024;

const BUILD_CONFIGURATION = {
  bundle: true,
  charset: "utf8",
  sourcemap: false,
} as const satisfies BuildOptions;

const FLOWZONE_BUILD_OUTPUTS = [
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

export interface BuiltFlowZoneBundle {
  readonly bundle: string;
  readonly metafile: Metafile;
}

export interface FlowZoneBuildResult {
  readonly bundles: readonly BuiltFlowZoneBundle[];
  readonly destinations: readonly string[];
}

export interface FlowZoneBuildPipelineOptions {
  readonly outputRoot: string;
  readonly root: string;
}

async function buildFlowZoneArtifacts(
  root: string,
  outputRoot: string,
): Promise<readonly BuiltFlowZoneBundle[]> {
  const bundles: BuiltFlowZoneBundle[] = [];
  for (const output of FLOWZONE_BUILD_OUTPUTS) {
    const result = await build({
      ...output.options,
      absWorkingDir: root,
      ...BUILD_CONFIGURATION,
      entryPoints: [resolve(root, output.source)],
      legalComments: "none",
      logLevel: "info",
      metafile: true,
      outfile: resolve(outputRoot, output.destination),
    });
    bundles.push({ bundle: output.destination, metafile: result.metafile });
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
  return bundles;
}

async function assertFlowZoneBudgets(root: string, outputRoot: string): Promise<void> {
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

  if (serverBytes > FLOWZONE_SERVER_BUDGET_BYTES) {
    throw new Error(`Server bundles are ${serverBytes} bytes; the combined limit is 5 MiB.`);
  }
  // Mermaid is bundled into the single offline MCP Apps resource so the strict CSP
  // never needs a script or module origin. Keep the resulting one-file payload bounded.
  if (browserBytes > FLOWZONE_BROWSER_BUDGET_BYTES) {
    throw new Error(`Browser payload is ${browserBytes} bytes; the limit is 4 MiB.`);
  }
  if (dynaBytes > DYNA_BROWSER_BUDGET_BYTES) {
    throw new Error(
      `Dyna browser payload is ${dynaBytes} bytes; the limit is ${String(DYNA_BROWSER_BUDGET_KIB)} KiB.`,
    );
  }
}

/** Build every pre-existing FlowZone shipping artifact and enforce its fixed budgets. */
export async function runFlowZoneBuildPipeline({
  outputRoot,
  root,
}: FlowZoneBuildPipelineOptions): Promise<FlowZoneBuildResult> {
  const bundles = await buildFlowZoneArtifacts(root, outputRoot);
  await assertFlowZoneBudgets(root, outputRoot);
  return {
    bundles,
    destinations: [
      ...FLOWZONE_BUILD_OUTPUTS.map((output) => output.destination),
      "web/dist/dyna.css",
    ],
  };
}

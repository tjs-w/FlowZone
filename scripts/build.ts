import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build, transform, type BuildOptions } from "esbuild";
import { compile as compileTailwind } from "tailwindcss";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const temporaryRoot = checkOnly ? await mkdtemp(join(tmpdir(), "flowzone-build-")) : root;
// Keep a narrow explicit ceiling while allowing bounded activity history, the
// session picker, and the dependency-free accessible context menu.
const DYNA_BROWSER_BUDGET_KIB = 856;
const DYNA_BROWSER_BUDGET_BYTES = DYNA_BROWSER_BUDGET_KIB * 1024;

const outputs = [
  {
    source: resolve(root, "server/src/main.ts"),
    destination: "server/dist/server.cjs",
    options: {
      platform: "node",
      format: "cjs",
      target: "node22",
      minify: false,
    } satisfies BuildOptions,
  },
  {
    source: resolve(root, "server/src/publish.ts"),
    destination: "server/dist/flowzone-publish.cjs",
    options: {
      platform: "node",
      format: "cjs",
      target: "node22",
      minify: true,
    } satisfies BuildOptions,
  },
  {
    source: resolve(root, "server/src/dyna.ts"),
    destination: "server/dist/dyna.cjs",
    options: {
      platform: "node",
      format: "cjs",
      target: "node22",
      minify: true,
    } satisfies BuildOptions,
  },
  {
    source: resolve(root, "packages/host-mcp-apps/src/browser-entry.ts"),
    destination: "web/dist/flowzone.js",
    options: {
      platform: "browser",
      format: "iife",
      target: "es2022",
      minify: true,
    } satisfies BuildOptions,
  },
  {
    source: resolve(root, "packages/dyna-ui/src/index.tsx"),
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

async function compile(): Promise<void> {
  for (const output of outputs) {
    await build({
      ...output.options,
      absWorkingDir: root,
      bundle: true,
      charset: "utf8",
      entryPoints: [output.source],
      legalComments: "none",
      logLevel: "info",
      outfile: resolve(temporaryRoot, output.destination),
      sourcemap: false,
    });
    if (
      output.destination === "server/dist/flowzone-publish.cjs" ||
      output.destination === "server/dist/dyna.cjs"
    ) {
      const cliPath = resolve(temporaryRoot, output.destination);
      const cli = await readFile(cliPath, "utf8");
      await writeFile(cliPath, cli.replace(/[ \t]+$/gm, ""));
    }
  }
  const dynaStylesheetPath = resolve(temporaryRoot, "web/dist/dyna.css");
  const dynaStylesheet = await readFile(dynaStylesheetPath, "utf8");
  const compiledStylesheet = await compileTailwind(dynaStylesheet, { base: root });
  const optimizedStylesheet = await transform(compiledStylesheet.build([]), {
    loader: "css",
    minify: true,
  });
  await writeFile(dynaStylesheetPath, optimizedStylesheet.code);
}

async function assertArtifactParity(): Promise<void> {
  for (const output of outputs) {
    const expected = await readFile(resolve(root, output.destination));
    const actual = await readFile(resolve(temporaryRoot, output.destination));
    if (!expected.equals(actual)) {
      throw new Error(`${output.destination} differs from a clean build. Run bun run build.`);
    }
  }
  const expectedDynaCss = await readFile(resolve(root, "web/dist/dyna.css"));
  const actualDynaCss = await readFile(resolve(temporaryRoot, "web/dist/dyna.css"));
  if (!expectedDynaCss.equals(actualDynaCss)) {
    throw new Error("web/dist/dyna.css differs from a clean build. Run bun run build.");
  }
}

async function assertBudgets(): Promise<void> {
  const serverBytes = await Promise.all([
    stat(resolve(temporaryRoot, "server/dist/server.cjs")),
    stat(resolve(temporaryRoot, "server/dist/flowzone-publish.cjs")),
    stat(resolve(temporaryRoot, "server/dist/dyna.cjs")),
  ]).then((values) => values.reduce((total, value) => total + value.size, 0));
  const browserBytes = await Promise.all([
    stat(resolve(root, "web/flowzone.html")),
    stat(resolve(temporaryRoot, "web/dist/flowzone.js")),
  ]).then((values) => values.reduce((total, value) => total + value.size, 0));
  const dynaBytes = await Promise.all([
    stat(resolve(root, "web/dyna.html")),
    stat(resolve(temporaryRoot, "web/dist/dyna.js")),
    stat(resolve(temporaryRoot, "web/dist/dyna.css")),
  ]).then((values) => values.reduce((total, value) => total + value.size, 0));

  if (serverBytes > 5 * 1024 * 1024) {
    throw new Error(`Server bundles are ${serverBytes} bytes; the combined limit is 5 MiB.`);
  }
  // Mermaid is bundled into the single offline MCP Apps resource so the strict CSP
  // never needs a script or module origin. Keep the resulting one-file payload bounded.
  if (browserBytes > 4 * 1024 * 1024) {
    throw new Error(`Browser payload is ${browserBytes} bytes; the limit is 4 MiB.`);
  }
  if (dynaBytes > DYNA_BROWSER_BUDGET_BYTES) {
    throw new Error(
      `Dyna browser payload is ${dynaBytes} bytes; the limit is ${String(DYNA_BROWSER_BUDGET_KIB)} KiB.`,
    );
  }
}

try {
  await compile();
  await assertBudgets();
  if (checkOnly) await assertArtifactParity();
} finally {
  if (checkOnly) await rm(temporaryRoot, { force: true, recursive: true });
}

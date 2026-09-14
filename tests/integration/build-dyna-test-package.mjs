import { buildSync } from "esbuild";
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const [packageRoot, databasePath, readyMarker] = process.argv.slice(2);
if (!packageRoot || !databasePath) {
  throw new Error("The Dyna test package builder requires a package root and database path.");
}

const launcherSource = resolve(fixtureDirectory, "../../bin/dyna");
const cliSourcePath = resolve(fixtureDirectory, "../../server/src/dyna.ts");
const cliSource = readFileSync(cliSourcePath, "utf8");
const serviceConstruction =
  "const service = new DynaApplicationService({ actor: DYNA_CLI_ACTOR });";
if (cliSource.split(serviceConstruction).length - 1 !== 1) {
  throw new Error("The Dyna CLI service construction boundary changed.");
}

const launcher = join(packageRoot, "bin", "dyna");
const bundle = join(packageRoot, "server", "dist", "dyna.cjs");
mkdirSync(join(packageRoot, "bin"), { recursive: true });
mkdirSync(join(packageRoot, "server", "dist"), { recursive: true });
copyFileSync(launcherSource, launcher);
chmodSync(launcher, 0o755);
const injectedSource = cliSource.replace(
  serviceConstruction,
  `const service = new DynaApplicationService({ actor: DYNA_CLI_ACTOR, databasePath: ${JSON.stringify(databasePath)} });`,
);
buildSync({
  stdin: {
    contents: readyMarker
      ? `process.stdout.write(${JSON.stringify(`${readyMarker}\n`)});\n${injectedSource}`
      : injectedSource,
    loader: "ts",
    resolveDir: resolve(fixtureDirectory, "../../server/src"),
    sourcefile: cliSourcePath,
  },
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  logLevel: "silent",
});

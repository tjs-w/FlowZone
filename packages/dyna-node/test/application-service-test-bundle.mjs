import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildSync } from "esbuild";

export async function loadDynaApplicationService() {
  const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-service-bundle-"));
  const output = join(directory, "service.mjs");
  buildSync({
    entryPoints: [resolve(import.meta.dirname, "../src/service.ts")],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "silent",
  });
  const serviceModule = await import(pathToFileURL(output).href);
  return {
    serviceModule,
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

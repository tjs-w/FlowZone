import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

describe("Dyna publisher source manifest actions", () => {
  test("creates, binds, lists, and idempotently reconciles an immutable manifest", () => {
    const fixture = resolve(import.meta.dir, "dyna-node-fixture.mjs");
    const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-mcp-action-"));
    const bundledFixture = join(directory, "fixture.mjs");
    try {
      const build = spawnSync(
        process.execPath,
        ["build", fixture, "--target=node", "--outfile", bundledFixture],
        { encoding: "utf8" },
      );
      expect(build.status, build.stderr).toBe(0);
      const result = spawnSync("node", [bundledFixture], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        createSchema: true,
        disabledByDefault: true,
        disabledEnforced: true,
        localPreviewOperational: true,
        scheduledManualRejected: true,
        latestSlicesExposed: true,
        manifestRequired: true,
        bindSchema: true,
        updateSchema: true,
        inventory: true,
        immutable: true,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);
});

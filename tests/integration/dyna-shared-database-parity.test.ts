import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

describe("Dyna shared-database adapter parity", () => {
  test("seeds through MCP and publisher adapters, then projects CLI mutations through MCP", () => {
    const fixture = resolve(import.meta.dir, "dyna-shared-database-parity-node-fixture.mjs");
    const result = spawnSync("node", [fixture], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 8,
      workUpdate: true,
      enrichment: true,
      singlePlacement: true,
      bulkPlacement: true,
      archiveRestore: true,
      standaloneTodo: true,
      followUp: true,
      adapterSeed: true,
      mutationOutputRedacted: true,
      mcpRefreshParity: true,
    });
  }, 35_000);
});

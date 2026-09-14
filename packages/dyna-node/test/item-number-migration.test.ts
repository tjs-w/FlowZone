import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

describe("Dyna item-number persistence", () => {
  test("migrates v7 deterministically and preserves immutable global identifiers", () => {
    const fixture = resolve(import.meta.dir, "item-number-migration-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      deterministicBackfill: true,
      immutableLedger: true,
      neverRecycled: true,
      projections: true,
      followUpProvenance: true,
      taskHostMovement: true,
      taskStatusEvidencePreserved: true,
      sameTimestampRoutingRepair: true,
      taskOwnershipConflict: true,
      migrationRollback: true,
      reopenFailClosed: true,
      supplementalRepair: true,
      reservationSchemaMigration: true,
      safeIntegerExhaustion: true,
      concurrentAllocation: true,
    });
  });
});

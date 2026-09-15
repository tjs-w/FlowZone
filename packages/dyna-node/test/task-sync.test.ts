import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

describe("Dyna linked-task pull synchronization", () => {
  test("deduplicates, checkpoints, finalizes, and migrates through the application boundary", () => {
    const fixture = resolve(import.meta.dir, "task-sync-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.split("\n")[0] ?? "{}")).toEqual({
      deduplicatedRun: true,
      deliveryReservationRecovery: true,
      exactBatchReplay: true,
      atomicFinalization: true,
      checkpointCursor: true,
      nativeSuccessWithoutOutcome: true,
      hostHandoff: true,
      partialCoverage: true,
      snapshotSummary: true,
      observedAtHeartbeat: true,
      leaseReclaim: true,
      conflictingReplay: true,
      unavailablePreservesStatus: true,
      workConditionProjection: true,
      archiveRace: true,
      crossDashboardReceiptAndStaleness: true,
      outOfBandHandoffCursorReset: true,
      invalidCursorRecovery: true,
      incompleteOutcomeMetadata: true,
      stableEventIdentity: true,
      taskTitlePrefixProjection: true,
      failClosedV9Ledger: true,
    });
  });
});

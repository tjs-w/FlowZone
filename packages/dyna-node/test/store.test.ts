import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

describe("DynaStore lifecycle", () => {
  test("passes Node-native claim lease and schedule freshness checks", () => {
    const fixture = resolve(import.meta.dir, "store-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      claim: "needs_reconciliation",
      freshness: "stale",
    });
  });

  test("isolates dashboard preferences and publisher identities with retry-safe mutations", () => {
    const fixture = resolve(import.meta.dir, "integrity-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      isolated: true,
      idempotent: true,
      aggregate: true,
      search: true,
    });
  });

  test("migrates legacy completed tasks and excludes completed work from focus counts", () => {
    const fixture = resolve(import.meta.dir, "migration-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ migrated: true, completedIsNotFocus: true });
  });

  test("serializes publication against publisher revocation and credential rotation", () => {
    const fixture = resolve(import.meta.dir, "publisher-race-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ revokeRace: true, rotateRace: true });
  });

  test("applies successful records from a partial run without retiring the previous slice", () => {
    const fixture = resolve(import.meta.dir, "partial-run-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      appliedSuccessfulSlice: true,
      retainedPreviousSlice: true,
      visiblyStale: true,
    });
  });

  test("rejects databases created by a future schema version", () => {
    const fixture = resolve(import.meta.dir, "schema-version-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ futureVersionRejected: true });
  });

  test("rolls back an unversioned migration when legacy relationships are corrupt", () => {
    const fixture = resolve(import.meta.dir, "migration-rollback-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ corruptMigrationRolledBack: true });
  });

  test("creates a verified private backup that can be restored offline", () => {
    const fixture = resolve(import.meta.dir, "backup-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      backupVerified: true,
      offlineRestore: true,
      privatePermissions: true,
    });
  });

  test("enforces immutable unique schedules and the 50-binding snapshot limit", () => {
    const fixture = resolve(import.meta.dir, "schedule-cardinality-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ immutable: true, unique: true, maximum: 50 });
  });

  test("rejects a ninth task while preserving legacy aggregate workflow state", () => {
    const fixture = resolve(import.meta.dir, "task-cardinality-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      maximum: 8,
      reservationPreserved: true,
      reconciliationReservationPreserved: true,
      legacyNineTaskState: "attention",
    });
  });

  test("deduplicates logical action preparation across processes and guards delivery state", () => {
    const fixture = resolve(import.meta.dir, "action-race-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ crossProcessDedupe: true, deliveryCas: true });
  });

  test("bounds and redacts failure messages before storage and snapshot rendering", () => {
    const fixture = resolve(import.meta.dir, "failure-message-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      bounded: true,
      singleLine: true,
      secretsRedacted: true,
    });
  });

  test("makes annotation retries scoped and atomic with active dashboard membership", () => {
    const fixture = resolve(import.meta.dir, "annotation-idempotency-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      exactRetry: true,
      conflictRejected: true,
      scoped: true,
      membershipRace: true,
    });
  });

  test("caps dashboard and publisher inventory at creation boundaries", () => {
    const fixture = resolve(import.meta.dir, "inventory-cap-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      dashboardMaximum: 100,
      archivedDashboardCounted: true,
      publisherMaximum: 100,
      revokedPublisherCounted: true,
      manualPublisherCounted: true,
      failedTodoRolledBack: true,
    });
  });
});

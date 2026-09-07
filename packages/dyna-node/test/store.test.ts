import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

describe("DynaStore lifecycle", () => {
  test("archives completed and disposed work without deleting its evidence", () => {
    const fixture = resolve(import.meta.dir, "archive-lifecycle-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      retentionDefault: true,
      retentionConfigurable: true,
      recentDoneVisible: true,
      automaticArchive: true,
      activeCountsExcludeArchived: true,
      manualDisposition: true,
      evidencePreserved: true,
      changedDoesNotReactivate: true,
      followUpLinked: true,
      restoredWithHistory: true,
      priorityHistory: true,
    });
  });

  test("publishes through the same-user local CLI boundary without prompt secrets", () => {
    const fixture = resolve(import.meta.dir, "local-cli-publisher-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      disabledRejected: true,
      disabledEnabled: true,
      localCliPublished: true,
      localPreviewSeparated: true,
      revokedRejected: true,
    });
  });

  test("enforces scheduled-source, critical-priority, and publisher credential boundaries", () => {
    const fixture = resolve(import.meta.dir, "publication-boundaries-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      scheduledManualRejected: true,
      criticalEnrichmentBounded: true,
      manualOverridePreserved: true,
      disabledModeEnforced: true,
      localPreviewOperational: true,
      neverRunVisibleAsStale: true,
      revokedStatusImmutable: true,
      revokedDataVisibleAsStale: true,
    });
  });

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
    expect(JSON.parse(result.stdout)).toEqual({
      migrated: true,
      completedIsNotFocus: true,
      externalPublisherDisabled: true,
      legacyCredentialInvalidated: true,
      manifestlessPublicationDenied: true,
    });
  });

  test("disables version-one publishers until safe manifest-backed re-registration", () => {
    const fixture = resolve(import.meta.dir, "source-manifest-migration-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      migratedFromVersionOne: true,
      legacyPublisherDisabled: true,
      manifestEnrollmentPreserved: true,
      safeReregistrationPublishes: true,
    });
  });

  test("migrates version-two credential state and historical source-slice evidence", () => {
    const fixture = resolve(import.meta.dir, "credential-mode-migration-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      externalPublisherDisabled: true,
      externalScheduleUnknown: true,
      legacyCredentialInvalidated: true,
      manifestAndDataPreserved: true,
      manualPublisherDisabled: true,
      historicalSlicesRemainUnknown: true,
      invalidCriticalEnrichmentRepaired: true,
    });
  });

  test("rolls back the version-one manifest migration when relationships are corrupt", () => {
    const fixture = resolve(import.meta.dir, "source-manifest-migration-rollback-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ versionOneMigrationRolledBack: true });
  });

  test("serializes publication against publisher revocation and credential rotation", () => {
    const fixture = resolve(import.meta.dir, "publisher-race-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ revokeRace: true, rotateRace: true });
  });

  test("replaces successful source slices while preserving failed slices", () => {
    const fixture = resolve(import.meta.dir, "partial-run-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      legacyCompatible: true,
      successfulSlicesReplaced: true,
      failedSlicesPreserved: true,
      visiblyStale: true,
      idempotent: true,
      ordered: true,
      successfulCrossSliceMoveRejected: true,
    });
  });

  test("enforces registered source manifests without breaking legacy publishers", () => {
    const fixture = resolve(import.meta.dir, "source-manifest-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      manifestInventory: true,
      reorderedRetry: true,
      bindTimeRegistration: true,
      updateTimeRegistration: true,
      multiSourcePartial: true,
      sourceSliceEvidence: true,
      latestSliceFreshness: true,
      omittedRejected: true,
      extraRejected: true,
      duplicateRejected: true,
      rejectedRunsRolledBack: true,
      conflictingManifestRejected: true,
      activeSliceGuard: true,
      allFailedPreserved: true,
      legacyCompatible: true,
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

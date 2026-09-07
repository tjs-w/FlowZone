import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DynaStore } from "../src/store.ts";

const now = new Date(Date.now() - 60_000).toISOString();
const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-source-manifest-migration-"));
const databasePath = join(directory, "dyna.sqlite3");
const requiredSourceSlices = [{ source: "codex", sourceScope: "codex:local" }];

function item(externalId) {
  return {
    externalId,
    sourceRef: {
      source: "codex",
      taskId: `${externalId}-task`,
    },
    sourceScope: "codex:local",
    title: "Legacy item",
    summary: "A replacement publisher has an explicit source manifest.",
    priority: "normal",
    priorityReason: "Migration security check.",
    sourceUpdatedAt: now,
    labels: [],
  };
}

try {
  const seeded = new DynaStore({ databasePath, clock: () => new Date(now) });
  const dashboard = seeded.createDashboard("Version one", "Publisher migration");
  const legacy = seeded.createPublisher(
    "Version-one publisher",
    undefined,
    undefined,
    "local_preview",
  );
  seeded.bindSchedule(dashboard.id, legacy.publisher.id, {
    id: "version-one-schedule",
    title: "Version-one schedule",
    state: "active",
    staleAfterMinutes: 60,
  });
  seeded.close();

  const versionOne = new DatabaseSync(databasePath);
  versionOne.exec("ALTER TABLE publishers DROP COLUMN required_source_slices");
  versionOne.exec("ALTER TABLE publishers DROP COLUMN credential_mode");
  versionOne.exec("ALTER TABLE publisher_runs DROP COLUMN source_slices");
  versionOne.exec("PRAGMA user_version = 1");
  versionOne.close();

  const migrated = new DynaStore({ databasePath, clock: () => new Date(now) });
  const migratedPublisher = migrated.listPublishers().find(({ id }) => id === legacy.publisher.id);
  assert.ok(migratedPublisher);
  assert.equal(migratedPublisher.requiredSourceSlices, undefined);
  assert.equal(migratedPublisher.credentialMode, "disabled");
  assert.equal(migratedPublisher.scheduleState, "unknown");
  assert.throws(
    () =>
      migrated.publish(legacy.publisher.id, legacy.secret, [item("legacy-item")], {
        runId: "legacy-after-migration",
        sourceCompletedAt: now,
        mode: "replace",
        status: "succeeded",
      }),
    /credentials are invalid/,
  );
  migrated.updateScheduleStatus(legacy.publisher.id, {
    state: "paused",
    requiredSourceSlices,
  });
  assert.deepEqual(
    migrated.listPublishers().find(({ id }) => id === legacy.publisher.id)?.requiredSourceSlices,
    requiredSourceSlices,
  );
  assert.throws(
    () =>
      migrated.publish(legacy.publisher.id, legacy.secret, [item("legacy-item")], {
        runId: "legacy-after-enrollment",
        sourceCompletedAt: now,
        mode: "replace",
        status: "succeeded",
        sourceSlices: [{ ...requiredSourceSlices[0], status: "succeeded" }],
      }),
    /credentials are invalid/,
  );

  const replacement = migrated.createPublisher(
    "Manifest-backed replacement",
    undefined,
    requiredSourceSlices,
    "local_preview",
  );
  const accepted = migrated.publish(replacement.publisher.id, replacement.secret, [item("safe")], {
    runId: "safe-re-registration",
    sourceCompletedAt: now,
    mode: "replace",
    status: "succeeded",
    sourceSlices: [{ ...requiredSourceSlices[0], status: "succeeded" }],
  });
  assert.equal(accepted.accepted, 1);
  migrated.close();

  const versionThree = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(versionThree.prepare("PRAGMA user_version").get().user_version, 5);
  assert.ok(
    versionThree
      .prepare("PRAGMA table_info(publishers)")
      .all()
      .some((column) => column.name === "required_source_slices"),
  );
  assert.ok(
    versionThree
      .prepare("PRAGMA table_info(publishers)")
      .all()
      .some((column) => column.name === "credential_mode"),
  );
  assert.ok(
    versionThree
      .prepare("PRAGMA table_info(publisher_runs)")
      .all()
      .some((column) => column.name === "source_slices"),
  );
  versionThree.close();

  globalThis.process.stdout.write(
    JSON.stringify({
      migratedFromVersionOne: true,
      legacyPublisherDisabled: true,
      manifestEnrollmentPreserved: true,
      safeReregistrationPublishes: true,
    }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

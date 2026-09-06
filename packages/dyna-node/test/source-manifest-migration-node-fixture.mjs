import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DynaStore } from "../src/store.ts";

const now = new Date(Date.now() - 60_000).toISOString();
const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-source-manifest-migration-"));
const databasePath = join(directory, "dyna.sqlite3");

try {
  const seeded = new DynaStore({ databasePath, clock: () => new Date(now) });
  const dashboard = seeded.createDashboard("Version one", "Publisher migration");
  const legacy = seeded.createPublisher("Version-one publisher");
  seeded.bindSchedule(dashboard.id, legacy.publisher.id, {
    id: "version-one-schedule",
    title: "Version-one schedule",
    state: "active",
    staleAfterMinutes: 60,
  });
  seeded.close();

  const versionOne = new DatabaseSync(databasePath);
  versionOne.exec("ALTER TABLE publishers DROP COLUMN required_source_slices");
  versionOne.exec("PRAGMA user_version = 1");
  versionOne.close();

  const migrated = new DynaStore({ databasePath, clock: () => new Date(now) });
  const migratedPublisher = migrated.listPublishers().find(({ id }) => id === legacy.publisher.id);
  assert.ok(migratedPublisher);
  assert.equal(migratedPublisher.requiredSourceSlices, undefined);
  const accepted = migrated.publish(
    legacy.publisher.id,
    legacy.secret,
    [
      {
        externalId: "legacy-item",
        sourceRef: {
          source: "codex",
          taskId: "legacy-task",
        },
        sourceScope: "codex:local",
        title: "Legacy item",
        summary: "A version-one publisher can still publish without a manifest.",
        priority: "normal",
        priorityReason: "Migration compatibility check.",
        sourceUpdatedAt: now,
        labels: [],
      },
    ],
    {
      runId: "legacy-after-migration",
      sourceCompletedAt: now,
      mode: "replace",
      status: "succeeded",
    },
  );
  assert.equal(accepted.accepted, 1);
  migrated.close();

  const versionTwo = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(versionTwo.prepare("PRAGMA user_version").get().user_version, 2);
  assert.ok(
    versionTwo
      .prepare("PRAGMA table_info(publishers)")
      .all()
      .some((column) => column.name === "required_source_slices"),
  );
  versionTwo.close();

  globalThis.process.stdout.write(
    JSON.stringify({ migratedFromVersionOne: true, legacyPublisherCompatible: true }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

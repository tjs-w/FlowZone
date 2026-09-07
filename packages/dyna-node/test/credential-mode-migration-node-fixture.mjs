import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DynaStore } from "../src/store.ts";

let clockMs = Date.now() - 60_000;
const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-credential-migration-"));
const databasePath = join(directory, "dyna.sqlite3");
const requiredSourceSlices = [{ source: "codex", sourceScope: "codex:local" }];

try {
  const seeded = new DynaStore({ databasePath, clock: () => new Date(clockMs) });
  const dashboard = seeded.createDashboard("Version two", "Credential-mode migration");
  const legacy = seeded.createPublisher(
    "Legacy external publisher",
    undefined,
    requiredSourceSlices,
    "local_preview",
  );
  seeded.bindSchedule(dashboard.id, legacy.publisher.id, {
    id: "legacy-external",
    title: "Legacy external",
    state: "active",
    staleAfterMinutes: 60,
  });
  const sourceCompletedAt = new Date(clockMs).toISOString();
  seeded.publish(
    legacy.publisher.id,
    legacy.secret,
    [
      {
        externalId: "legacy-normal",
        sourceRef: { source: "codex", taskId: "legacy-normal" },
        sourceScope: "codex:local",
        title: "Legacy normal item",
        summary: "Used to repair an invalid historical critical enrichment.",
        priority: "normal",
        priorityReason: "Normal source urgency.",
        sourceUpdatedAt: sourceCompletedAt,
        labels: [],
      },
    ],
    {
      runId: "legacy-unsliced-run",
      sourceCompletedAt,
      mode: "replace",
      status: "succeeded",
      sourceSlices: [{ ...requiredSourceSlices[0], status: "succeeded" }],
    },
  );
  seeded.addTodo(
    seeded.createView(dashboard.id),
    { title: "Legacy manual item" },
    "a1d72262-f085-496c-90d2-167e455e810a",
  );
  const normal = seeded
    .snapshot(dashboard.id)
    .cards.find((card) => card.title === "Legacy normal item");
  assert.ok(normal);
  seeded.close();

  const versionTwo = new DatabaseSync(databasePath);
  const legacyTokenHash = versionTwo
    .prepare("SELECT token_hash FROM publishers WHERE id = ?")
    .get(legacy.publisher.id).token_hash;
  versionTwo
    .prepare(
      `INSERT INTO item_enrichments (
        item_id, priority, priority_reason, due_at_set, leadership_score,
        base_fingerprint, base_source_updated_at, applied_at, provenance, version
      ) VALUES (?, 'critical', 'Historical invalid elevation.', 0, 0, ?, ?, ?, 'legacy', 1)`,
    )
    .run(normal.id, normal.fingerprint, normal.sourceUpdatedAt, sourceCompletedAt);
  versionTwo.exec("ALTER TABLE publishers DROP COLUMN credential_mode");
  versionTwo.exec("ALTER TABLE publisher_runs DROP COLUMN source_slices");
  versionTwo.exec("PRAGMA user_version = 2");
  versionTwo.close();

  const migrated = new DynaStore({ databasePath, clock: () => new Date(clockMs) });
  const migratedPublisher = migrated
    .listPublishers(dashboard.id)
    .find(({ id }) => id === legacy.publisher.id);
  assert.ok(migratedPublisher);
  assert.equal(migratedPublisher.credentialMode, "disabled");
  assert.equal(migratedPublisher.scheduleState, "unknown");
  assert.deepEqual(migratedPublisher.requiredSourceSlices, requiredSourceSlices);
  assert.equal(migratedPublisher.lastSourceSlices, undefined);
  assert.equal(
    migrated.snapshot(dashboard.id).cards.find(({ id }) => id === normal.id)?.priority,
    "normal",
  );

  clockMs += 1_000;
  assert.throws(
    () =>
      migrated.publish(legacy.publisher.id, legacy.secret, [], {
        runId: "after-v3-migration",
        sourceCompletedAt: new Date(clockMs).toISOString(),
        mode: "replace",
        status: "succeeded",
        sourceSlices: [{ ...requiredSourceSlices[0], status: "succeeded" }],
      }),
    /credentials are invalid/,
  );
  assert.throws(
    () => migrated.rotatePublisherSecret(legacy.publisher.id),
    /Only a local-preview Dyna publisher can rotate credentials/,
  );
  assert.throws(
    () => migrated.updateScheduleStatus(legacy.publisher.id, { state: "active" }),
    /disabled Dyna publisher cannot use an active schedule/,
  );
  migrated.close();

  const verified = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(verified.prepare("PRAGMA user_version").get().user_version, 5);
  assert.equal(
    verified
      .prepare(
        `SELECT p.credential_mode FROM publishers p
         JOIN dashboard_manual_publishers mp ON mp.publisher_id = p.id`,
      )
      .get().credential_mode,
    "disabled",
  );
  assert.notDeepEqual(
    verified.prepare("SELECT token_hash FROM publishers WHERE id = ?").get(legacy.publisher.id)
      .token_hash,
    legacyTokenHash,
  );
  const enrichment = verified
    .prepare("SELECT priority, priority_reason FROM item_enrichments WHERE item_id = ?")
    .get(normal.id);
  assert.equal(enrichment.priority, null);
  assert.equal(enrichment.priority_reason, null);
  assert.ok(
    verified
      .prepare("PRAGMA table_info(publisher_runs)")
      .all()
      .some(({ name }) => name === "source_slices"),
  );
  verified.close();

  globalThis.process.stdout.write(
    JSON.stringify({
      externalPublisherDisabled: true,
      externalScheduleUnknown: true,
      legacyCredentialInvalidated: true,
      manifestAndDataPreserved: true,
      manualPublisherDisabled: true,
      historicalSlicesRemainUnknown: true,
      invalidCriticalEnrichmentRepaired: true,
    }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

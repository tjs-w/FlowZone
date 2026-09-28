import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

import { DynaStore } from "../src/store.ts";

const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-v14-migration-"));
const databasePath = join(directory, "dyna.sqlite3");
const instant = "2026-09-27T12:00:00.000Z";
const clock = () => new Date(instant);
try {
  const seed = new DynaStore({ databasePath, clock });
  const primary = seed.createDashboard("Primary", "Historical work");
  const secondary = seed.createDashboard("Secondary", "Legacy shared work");
  const { publisher, secret } = seed.createPublisher(
    "Legacy source",
    undefined,
    undefined,
    "local_preview",
  );
  const schedule = {
    id: "legacy-shared",
    title: "Legacy shared source",
    state: "active",
    staleAfterMinutes: 60,
  };
  seed.bindSchedule(primary.id, publisher.id, schedule);
  seed.publish(
    publisher.id,
    secret,
    [
      {
        externalId: "mr-1",
        sourceRef: {
          source: "gitlab",
          instanceId: "gitlab.example.com",
          projectPath: "team/service",
          entityType: "merge_request",
          iid: 184,
        },
        sourceScope: "team/service",
        title: "Preserve this work",
        summary: "Historical decision",
        priority: "high",
        priorityReason: "Direct request",
        sourceUpdatedAt: instant,
        labels: [],
      },
    ],
    { runId: "legacy-run", sourceCompletedAt: instant, mode: "replace", status: "succeeded" },
  );
  const card = seed.snapshot(primary.id).cards[0];
  assert.ok(card);
  seed.addAnnotation(
    seed.createView(primary.id),
    card.id,
    randomUUID(),
    "Keep the decision history.",
  );
  seed.updateTask(primary.id, card.id, {
    taskId: "legacy-task",
    hostId: "local",
    title: `:${String(card.itemNumber)}: Preserve this work`,
    state: "running",
    statusUpdatedAt: instant,
    observedAt: instant,
  });
  // A v13 publisher binding made this same item visible on another dashboard.
  seed.bindSchedule(secondary.id, publisher.id, schedule);
  seed.close();

  const old = new DatabaseSync(databasePath);
  old.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;");
  for (const table of [
    "source_correction_receipts",
    "source_separations",
    "work_summaries",
    "item_merge_events",
    "item_aliases",
    "source_relationship_evidence",
    "work_identity_claims",
    "source_contributions",
    "dashboard_items",
  ]) {
    old.exec(`DROP TABLE IF EXISTS ${table};`);
  }
  old.exec("PRAGMA user_version = 13; COMMIT;");
  old.close();

  const upgraded = new DynaStore({ databasePath, clock });
  const same = upgraded.snapshot(secondary.id).cards[0];
  assert.ok(same);
  assert.equal(same.id, card.id);
  assert.equal(same.itemNumber, card.itemNumber);
  assert.equal(same.annotations[0]?.body, "Keep the decision history.");
  assert.equal(same.linkedTasks[0]?.taskId, "legacy-task");
  assert.equal(same.sources.length, 1);
  upgraded.close();
  const verified = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(verified.prepare("PRAGMA user_version").get().user_version, 14);
  verified.close();
  process.stdout.write(`${JSON.stringify({ migrated: true, legacyShared: true })}\n`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

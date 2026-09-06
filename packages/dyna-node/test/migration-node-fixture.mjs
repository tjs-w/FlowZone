import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DynaStore } from "../src/store.ts";

const now = "2026-09-03T20:00:00.000Z";
const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-migration-"));
const databasePath = join(directory, "dyna.sqlite3");

try {
  const original = new DynaStore({ databasePath, clock: () => new Date(now) });
  const dashboard = original.createDashboard("Migration", "Legacy outcome");
  const publisher = original.createPublisher("Legacy publisher");
  original.bindSchedule(dashboard.id, publisher.publisher.id, {
    id: "legacy-schedule",
    title: "Legacy schedule",
    state: "active",
    staleAfterMinutes: 60,
  });
  original.publish(
    publisher.publisher.id,
    publisher.secret,
    [
      {
        externalId: "legacy-item",
        sourceRef: {
          source: "gitlab",
          instanceId: "corp",
          projectPath: "team/project",
          iid: 42,
          entityType: "merge_request",
        },
        sourceScope: "team/project",
        title: "Legacy completed work",
        summary: "Created before completion outcomes were required.",
        priority: "high",
        priorityReason: "Was urgent before completion.",
        sourceUpdatedAt: now,
        labels: [],
      },
    ],
    { runId: "legacy-run", sourceCompletedAt: now, mode: "replace", status: "succeeded" },
  );
  const item = original.snapshot(dashboard.id).cards[0];
  assert.ok(item);
  original.upsertTaskStatus(item.id, {
    taskId: "legacy-task",
    hostId: "local",
    title: "Legacy task",
    state: "succeeded",
    outcome: "Original outcome.",
    statusUpdatedAt: now,
    observedAt: now,
  });
  original.close();

  const raw = new DatabaseSync(databasePath);
  raw.prepare("UPDATE task_bindings SET outcome = NULL WHERE task_id = 'legacy-task'").run();
  raw.exec("PRAGMA user_version = 0");
  raw.close();

  const migrated = new DynaStore({ databasePath, clock: () => new Date(now) });
  const snapshot = migrated.snapshot(dashboard.id);
  assert.equal(snapshot.counts.high, 0);
  assert.equal(snapshot.cards[0]?.workflowState, "completed");
  assert.equal(
    snapshot.cards[0]?.outcome,
    "Completed before outcome tracking; refresh this task for details.",
  );
  migrated.close();

  const versioned = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(versioned.prepare("PRAGMA user_version").get().user_version, 1);
  versioned.close();

  globalThis.process.stdout.write(JSON.stringify({ migrated: true, completedIsNotFocus: true }));
} finally {
  rmSync(directory, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DynaStore } from "../src/store.ts";

const now = "2026-09-03T20:00:00.000Z";
const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-migration-rollback-"));
const databasePath = join(directory, "dyna.sqlite3");

try {
  const seed = new DynaStore({ databasePath, clock: () => new Date(now) });
  const dashboard = seed.createDashboard("Corrupt legacy", "Rollback verification");
  const { publisher, secret } = seed.createPublisher(
    "Legacy source",
    undefined,
    undefined,
    "local_preview",
  );
  seed.bindSchedule(dashboard.id, publisher.id, {
    id: "legacy-corrupt-source",
    title: "Legacy corrupt source",
    state: "active",
    staleAfterMinutes: 60,
  });
  seed.publish(
    publisher.id,
    secret,
    [
      {
        externalId: "legacy-corrupt-item",
        sourceRef: {
          source: "codex",
          taskId: "legacy-source-task",
        },
        sourceScope: "local",
        title: "Legacy migration rollback",
        summary: "Migration data changes must roll back when relationships are corrupt.",
        priority: "normal",
        priorityReason: "Integrity regression.",
        sourceUpdatedAt: now,
        labels: [],
      },
    ],
    { runId: "legacy-run", sourceCompletedAt: now, mode: "replace", status: "succeeded" },
  );
  const item = seed.snapshot(dashboard.id).cards[0];
  assert.ok(item);
  seed.upsertTaskStatus(item.id, {
    taskId: "legacy-completed-task",
    hostId: "local",
    title: "Legacy completed task",
    state: "succeeded",
    outcome: "Original tracked outcome.",
    statusUpdatedAt: now,
    observedAt: now,
  });
  seed.close();

  const corrupt = new DatabaseSync(databasePath);
  corrupt.exec("PRAGMA foreign_keys = OFF");
  corrupt
    .prepare("UPDATE task_bindings SET outcome = NULL WHERE task_id = ?")
    .run("legacy-completed-task");
  corrupt
    .prepare("INSERT INTO dashboard_publishers (dashboard_id, publisher_id) VALUES (?, ?)")
    .run("missing-dashboard", publisher.id);
  corrupt.exec("PRAGMA user_version = 0");
  corrupt.close();

  assert.throws(
    () => new DynaStore({ databasePath, clock: () => new Date(now) }),
    /invalid relationships.*migration was rolled back/,
  );

  const unchanged = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(unchanged.prepare("PRAGMA user_version").get().user_version, 0);
  assert.equal(
    unchanged
      .prepare("SELECT outcome FROM task_bindings WHERE task_id = ?")
      .get("legacy-completed-task").outcome,
    null,
  );
  assert.equal(
    unchanged
      .prepare("SELECT COUNT(*) AS total FROM dashboard_publishers WHERE dashboard_id = ?")
      .get("missing-dashboard").total,
    1,
  );
  unchanged.close();

  globalThis.process.stdout.write(JSON.stringify({ corruptMigrationRolledBack: true }));
} finally {
  rmSync(directory, { recursive: true, force: true });
}

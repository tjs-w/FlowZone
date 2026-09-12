import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DynaCliStoreError, DynaStore } from "../src/store.ts";

const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-history-pages-"));
const databasePath = join(directory, "dyna.sqlite3");
const baseTime = Date.parse("2025-09-10T20:00:00.000Z");

try {
  let store = new DynaStore({ databasePath, clock: () => new Date(baseTime + 100_000) });
  const dashboard = store.createDashboard("History pages", "Bounded retrospective access");
  const outsideDashboard = store.createDashboard("Outside", "Membership rejection");
  const { publisher, secret } = store.createPublisher(
    "History source",
    undefined,
    undefined,
    "local_preview",
  );
  store.bindSchedule(dashboard.id, publisher.id, {
    id: "history-schedule",
    title: "History source",
    state: "active",
    staleAfterMinutes: 60,
  });
  store.publish(
    publisher.id,
    secret,
    [
      {
        externalId: "history-item",
        sourceRef: {
          source: "gitlab",
          instanceId: "gitlab.example.com",
          projectPath: "team/history",
          iid: 63,
          entityType: "merge_request",
        },
        sourceScope: "team/history",
        title: "Retain all history",
        summary: "Every bounded page remains reachable.",
        priority: "normal",
        priorityReason: "Regression coverage",
        sourceUpdatedAt: new Date(baseTime).toISOString(),
        labels: [],
      },
    ],
    {
      runId: "history-run",
      sourceCompletedAt: new Date(baseTime).toISOString(),
      mode: "replace",
      status: "succeeded",
    },
  );
  const item = store.snapshot(dashboard.id).cards[0];
  assert.ok(item);
  store.close();

  const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
  const insertWork = database.prepare(
    `INSERT INTO work_updates (
       id, item_id, origin_dashboard_id, work_attempt_id, kind, body, outcome,
       artifacts, task_id, host_id, task_title, created_at, created_at_ms
     ) VALUES (?, ?, ?, ?, 'note', ?, NULL, ?, ?, ?, ?, ?, ?)`,
  );
  const insertOrder = database.prepare(
    `INSERT INTO item_preference_events (
       id, dashboard_id, item_id, action, priority, sequence, created_at
     ) VALUES (?, ?, ?, 'resequence', 'normal', ?, ?)`,
  );
  const insertArchive = database.prepare(
    `INSERT INTO item_archive_events (
       id, dashboard_id, item_id, reason, reason_detail, mode,
       archived_at, archived_at_ms, fingerprint_at_archive, workflow_state,
       completed_at, completed_at_ms, outcome_at_archive, priority_at_archive,
       sequence_at_archive, client_request_id, request_hash, restored_at,
       restored_at_ms, restore_request_id, restore_request_hash
     ) VALUES (?, ?, ?, 'invalid', NULL, 'manual', ?, ?, ?, 'todo',
       NULL, NULL, NULL, 'normal', ?, NULL, NULL, ?, ?, NULL, NULL)`,
  );
  database.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < 63; index += 1) {
      const createdAtMs = baseTime + index;
      const createdAt = new Date(createdAtMs).toISOString();
      insertWork.run(
        randomUUID(),
        item.id,
        dashboard.id,
        randomUUID(),
        index === 0
          ? "needle-historical activity"
          : index === 62
            ? "Release status only"
            : `activity ${index}`,
        JSON.stringify(
          index === 0
            ? [
                {
                  kind: "report",
                  label: "Evidence 8842",
                  url: "https://example.com/reports/evidence-8842",
                },
              ]
            : index === 1
              ? [
                  {
                    kind: "report",
                    label: "Release evidence packet",
                    url: "https://example.com/reports/release-evidence-packet",
                  },
                ]
              : [],
        ),
        index === 62 ? "task-index-62" : null,
        index === 62 ? "local" : null,
        index === 62 ? "Indexed Codex task" : null,
        createdAt,
        createdAtMs,
      );
      insertOrder.run(randomUUID(), dashboard.id, item.id, index, createdAt);
      insertArchive.run(
        randomUUID(),
        dashboard.id,
        item.id,
        createdAt,
        createdAtMs,
        item.fingerprint,
        index,
        createdAt,
        createdAtMs,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }

  store = new DynaStore({ databasePath, clock: () => new Date(baseTime + 100_000) });
  const context = store.itemContext(item.id);
  assert.equal(context.workUpdateCount, 63);
  assert.equal(context.workUpdates.length, 20);
  assert.equal(context.workUpdates[0]?.body, "Release status only");

  const card = store.snapshot(dashboard.id).cards[0];
  assert.equal(card?.workUpdateCount, 63);
  assert.equal(card?.workUpdates.length, 1);
  assert.equal(card?.workUpdates[0]?.body, "Release status only");
  const matched = store.snapshot(dashboard.id, "needle-historical").cards[0];
  assert.equal(matched?.id, item.id);
  assert.equal(matched?.matchedActivity, "needle-historical activity");
  const artifactMatched = store.snapshot(dashboard.id, "evidence-8842").cards[0];
  assert.equal(artifactMatched?.id, item.id);
  assert.match(artifactMatched?.matchedActivity ?? "", /^Artifact: Evidence 8842 \(/);
  assert.match(artifactMatched?.matchedActivity ?? "", /evidence-8842/);
  const multiTermMatched = store.snapshot(dashboard.id, "Release evidence packet").cards[0];
  assert.equal(multiTermMatched?.id, item.id);
  assert.equal(multiTermMatched?.matchedActivity, "Artifact: Release evidence packet");
  assert.equal(store.snapshot(dashboard.id, "url").cards.length, 0);
  assert.equal(store.snapshot(dashboard.id, "kind").cards.length, 0);
  assert.equal(
    store.snapshot(dashboard.id, "report").cards[0]?.matchedActivity,
    "Artifact type: report",
  );
  assert.equal(
    store.snapshot(dashboard.id, "task-index-62").cards[0]?.matchedActivity,
    "Codex task ID: task-index-62",
  );
  assert.equal(
    store.snapshot(dashboard.id, "local").cards[0]?.matchedActivity,
    "Codex host: local",
  );
  assert.equal(
    store.snapshot(dashboard.id, "indexed codex").cards[0]?.matchedActivity,
    "Codex task: Indexed Codex task",
  );
  assert.equal(store.snapshot(dashboard.id, "note").cards[0]?.matchedActivity, "Update: note");

  const collectHistory = (cursorName, resultName, nextCursorName) => {
    const values = [];
    let cursor;
    do {
      const page = store.itemHistory(dashboard.id, item.id, {
        limit: 17,
        ...(cursor ? { [cursorName]: cursor } : {}),
      });
      values.push(...page[resultName]);
      cursor = page[nextCursorName];
    } while (cursor);
    return values;
  };
  const archives = collectHistory("archiveCursor", "archives", "archiveEventsNextCursor");
  const organization = collectHistory("orderCursor", "organization", "orderHistoryNextCursor");
  const updates = collectHistory("workCursor", "workUpdates", "workUpdatesNextCursor");
  assert.equal(archives.length, 63);
  assert.equal(new Set(archives.map((entry) => entry.id)).size, 63);
  assert.equal(organization.length, 63);
  assert.equal(new Set(organization.map((entry) => entry.createdAt)).size, 63);
  assert.equal(updates.length, 63);
  assert.equal(new Set(updates.map((entry) => entry.id)).size, 63);

  const firstHistoryPage = store.itemHistory(dashboard.id, item.id, { limit: 1 });
  assert.ok(firstHistoryPage.workUpdatesNextCursor);
  assert.throws(
    () =>
      store.itemHistory(dashboard.id, item.id, {
        archiveCursor: firstHistoryPage.workUpdatesNextCursor,
      }),
    (error) => error instanceof DynaCliStoreError && error.code === "invalid_input",
  );
  assert.throws(
    () => store.itemHistory(dashboard.id, item.id, { workCursor: "%%%" }),
    (error) => error instanceof DynaCliStoreError && error.code === "invalid_input",
  );
  assert.throws(
    () => store.itemHistory(dashboard.id, item.id, { limit: 51 }),
    (error) => error instanceof DynaCliStoreError && error.code === "invalid_input",
  );

  const activityIds = [];
  let activityCursor;
  do {
    const page = store.itemActivityPage(dashboard.id, item.id, {
      limit: 13,
      ...(activityCursor ? { cursor: activityCursor } : {}),
    });
    assert.equal(page.total, 63);
    activityIds.push(...page.updates.map((update) => update.id));
    activityCursor = page.nextCursor;
  } while (activityCursor);
  assert.equal(activityIds.length, 63);
  assert.equal(new Set(activityIds).size, 63);

  assert.throws(
    () =>
      store.upsertTaskStatusForDashboard(outsideDashboard.id, item.id, {
        taskId: "outside-task",
        hostId: "local",
        title: "Outside task",
        state: "running",
        statusUpdatedAt: new Date(baseTime + 100_000).toISOString(),
        observedAt: new Date(baseTime + 100_000).toISOString(),
      }),
    (error) => error instanceof DynaCliStoreError && error.code === "outside_dashboard",
  );
  assert.equal(store.itemContext(item.id).linkedTasks.length, 0);
  store.upsertTaskStatusForDashboard(dashboard.id, item.id, {
    taskId: "inside-task",
    hostId: "local",
    title: "Inside task",
    state: "running",
    statusUpdatedAt: new Date(baseTime + 100_000).toISOString(),
    observedAt: new Date(baseTime + 100_000).toISOString(),
  });
  assert.equal(store.itemContext(item.id).linkedTasks.length, 1);
  const beforeArchive = store.showItem(dashboard.id, item.id);
  store.archiveItemFromCli(dashboard.id, item.id, beforeArchive.revision, item.fingerprint, {
    requestId: randomUUID(),
    reason: "invalid",
  });
  const archivedArtifactMatch = store.snapshot(dashboard.id, "evidence-8842", "archive").cards[0];
  assert.equal(archivedArtifactMatch?.id, item.id);
  assert.match(archivedArtifactMatch?.matchedActivity ?? "", /^Artifact: Evidence 8842 \(/);
  assert.match(archivedArtifactMatch?.matchedActivity ?? "", /evidence-8842/);
  const archivedMultiTermMatch = store.snapshot(dashboard.id, "Release evidence packet", "archive")
    .cards[0];
  assert.equal(archivedMultiTermMatch?.id, item.id);
  assert.equal(archivedMultiTermMatch?.matchedActivity, "Artifact: Release evidence packet");
  assert.equal(store.snapshot(dashboard.id, "url", "archive").cards.length, 0);
  assert.equal(store.snapshot(dashboard.id, "kind", "archive").cards.length, 0);
  store.close();

  const queryPlanDatabase = new DatabaseSync(databasePath, { readOnly: true });
  const plan = queryPlanDatabase
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT candidate.rowid FROM work_updates candidate
       WHERE candidate.item_id = ? AND candidate.task_id = ? AND candidate.host_id = ?
         AND candidate.kind IN (
           'progress', 'needs_input', 'blocked', 'completion_reported', 'handoff'
         )
       ORDER BY candidate.created_at_ms DESC, candidate.rowid DESC LIMIT 1`,
    )
    .all(item.id, "inside-task", "local");
  assert.equal(
    plan.some((step) => String(step.detail).includes("idx_dyna_work_updates_task_state")),
    true,
  );
  queryPlanDatabase.close();

  globalThis.process.stdout.write(
    JSON.stringify({
      pagination: true,
      compactCards: true,
      membership: true,
      scopedIndex: true,
      valueOnlyActivitySearch: true,
      activityFieldExplanations: true,
    }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

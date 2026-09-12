import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DynaCliStoreError, DynaStore } from "../src/store.ts";

let now = Date.parse("2026-09-10T16:00:00.000Z");
const timestamp = () => new Date(now).toISOString();
const advance = () => {
  now += 1_000;
  return timestamp();
};
const request = () => randomUUID();
const attemptA = randomUUID();
const attemptB = randomUUID();
const store = new DynaStore({ databasePath: ":memory:", clock: () => new Date(now) });

function status(taskId, state, outcome) {
  const at = timestamp();
  return {
    taskId,
    hostId: "local",
    title: `Codex ${taskId}`,
    state,
    statusUpdatedAt: at,
    observedAt: at,
    ...(outcome ? { outcome } : {}),
  };
}

try {
  const dashboardA = store.createDashboard("Daily work", "Cross-session work updates");
  const dashboardB = store.createDashboard("Shared work", "Same item, separate placement");
  const { publisher, secret } = store.createPublisher(
    "Engineering signals",
    undefined,
    undefined,
    "local_preview",
  );
  for (const dashboard of [dashboardA, dashboardB]) {
    store.bindSchedule(dashboard.id, publisher.id, {
      id: "schedule-shared",
      title: "Engineering signals",
      state: "active",
      staleAfterMinutes: 60,
    });
  }
  store.publish(
    publisher.id,
    secret,
    [
      {
        externalId: "mr-42",
        sourceRef: {
          source: "gitlab",
          instanceId: "gitlab.example.com",
          projectPath: "team/service",
          iid: 42,
          entityType: "merge_request",
        },
        sourceScope: "team/service",
        title: "Review MR 42",
        summary: "Release decision is waiting.",
        priority: "high",
        priorityReason: "Direct request",
        sourceUpdatedAt: timestamp(),
        labels: ["release"],
      },
      {
        externalId: "mr-43",
        sourceRef: {
          source: "gitlab",
          instanceId: "gitlab.example.com",
          projectPath: "team/service",
          iid: 43,
          entityType: "merge_request",
        },
        sourceScope: "team/service",
        title: "Review MR 43",
        summary: "Ordering peer.",
        priority: "normal",
        priorityReason: "Review requested",
        sourceUpdatedAt: timestamp(),
        labels: [],
      },
      {
        externalId: "mr-44",
        sourceRef: {
          source: "gitlab",
          instanceId: "gitlab.example.com",
          projectPath: "team/service",
          iid: 44,
          entityType: "merge_request",
        },
        sourceScope: "team/service",
        title: "Review MR 44",
        summary: "Mixed failed-task projection.",
        priority: "low",
        priorityReason: "Regression coverage",
        sourceUpdatedAt: timestamp(),
        labels: [],
      },
    ],
    { runId: "run-1", sourceCompletedAt: timestamp(), mode: "replace", status: "succeeded" },
  );
  const mixedSnapshot = store.snapshot(dashboardA.id);
  const waitingItem = mixedSnapshot.cards.find((card) => card.title === "Review MR 43");
  const failedItem = mixedSnapshot.cards.find((card) => card.title === "Review MR 44");
  assert.ok(waitingItem && failedItem);

  store.upsertTaskStatus(waitingItem.id, status("waiting-task-a", "running"));
  store.upsertTaskStatus(waitingItem.id, status("waiting-task-b", "waiting"));
  advance();
  store.recordWorkUpdate(dashboardA.id, waitingItem.id, waitingItem.fingerprint, {
    requestId: request(),
    workAttemptId: randomUUID(),
    kind: "progress",
    body: "Task A is progressing while task B still needs input.",
    artifacts: [],
    task: { taskId: "waiting-task-a", hostId: "local" },
  });
  let mixedCard = store.showItem(dashboardA.id, waitingItem.id).item;
  assert.equal(mixedCard.workflowState, "paused");
  assert.equal(mixedCard.blocked, false);
  advance();
  store.recordWorkUpdate(dashboardA.id, waitingItem.id, waitingItem.fingerprint, {
    requestId: request(),
    workAttemptId: randomUUID(),
    kind: "progress",
    body: "A task report cannot clear controller-observed input requirements.",
    artifacts: [],
    task: { taskId: "waiting-task-b", hostId: "local" },
  });
  mixedCard = store.showItem(dashboardA.id, waitingItem.id).item;
  assert.equal(mixedCard.workflowState, "paused");
  assert.equal(mixedCard.blocked, false);
  advance();
  store.upsertTaskStatus(waitingItem.id, status("waiting-task-b", "unknown"));
  advance();
  store.recordWorkUpdate(dashboardA.id, waitingItem.id, waitingItem.fingerprint, {
    requestId: request(),
    workAttemptId: randomUUID(),
    kind: "handoff",
    body: "A task report cannot clear an unknown controller state.",
    artifacts: [],
    task: { taskId: "waiting-task-b", hostId: "local" },
  });
  mixedCard = store.showItem(dashboardA.id, waitingItem.id).item;
  assert.equal(mixedCard.workflowState, "attention");
  assert.equal(mixedCard.blocked, true);
  advance();
  store.upsertTaskStatus(waitingItem.id, status("waiting-task-b", "running"));
  mixedCard = store.showItem(dashboardA.id, waitingItem.id).item;
  assert.equal(mixedCard.workflowState, "executing");
  assert.equal(mixedCard.blocked, false);

  store.upsertTaskStatus(failedItem.id, status("failed-task-a", "running"));
  store.upsertTaskStatus(failedItem.id, status("failed-task-b", "failed"));
  advance();
  store.recordWorkUpdate(dashboardA.id, failedItem.id, failedItem.fingerprint, {
    requestId: request(),
    workAttemptId: randomUUID(),
    kind: "progress",
    body: "Task A is progressing while task B remains failed.",
    artifacts: [],
    task: { taskId: "failed-task-a", hostId: "local" },
  });
  mixedCard = store.showItem(dashboardA.id, failedItem.id).item;
  assert.equal(mixedCard.workflowState, "attention");
  assert.equal(mixedCard.blocked, true);
  assert.equal(store.snapshot(dashboardA.id).counts.blocked, 1);
  advance();
  store.recordWorkUpdate(dashboardA.id, failedItem.id, failedItem.fingerprint, {
    requestId: request(),
    workAttemptId: randomUUID(),
    kind: "completion_reported",
    body: "A completion report cannot clear a controller-observed failure.",
    outcome: "Task-side completion awaits controller verification.",
    artifacts: [],
    task: { taskId: "failed-task-b", hostId: "local" },
  });
  mixedCard = store.showItem(dashboardA.id, failedItem.id).item;
  assert.equal(mixedCard.workflowState, "attention");
  assert.equal(mixedCard.blocked, true);
  assert.equal(store.snapshot(dashboardA.id).counts.blocked, 1);
  advance();
  store.upsertTaskStatus(failedItem.id, status("failed-task-b", "running"));
  store.upsertTaskStatus(failedItem.id, status("failed-task-a", "succeeded", "Task A finished."));
  advance();
  store.recordWorkUpdate(dashboardA.id, failedItem.id, failedItem.fingerprint, {
    requestId: request(),
    workAttemptId: randomUUID(),
    kind: "blocked",
    body: "A stale report must not reactivate a controller-succeeded task.",
    artifacts: [],
    task: { taskId: "failed-task-a", hostId: "local" },
  });
  mixedCard = store.showItem(dashboardA.id, failedItem.id).item;
  assert.equal(mixedCard.workflowState, "executing");
  assert.equal(mixedCard.workState, undefined);
  assert.equal(mixedCard.blocked, false);

  let shown = store.showItem(dashboardA.id, store.snapshot(dashboardA.id).cards[0].id);
  const itemId = shown.item.id;
  const fingerprint = shown.item.fingerprint;
  assert.equal(shown.enrichmentVersion, 0);

  assert.throws(
    () =>
      store.recordWorkUpdate(dashboardA.id, itemId, fingerprint, {
        requestId: request(),
        workAttemptId: attemptA,
        kind: "progress",
        body: "Lifecycle progress cannot be accepted before task identity is available.",
        artifacts: [],
      }),
    (error) => error instanceof DynaCliStoreError && error.code === "invalid_input",
  );
  const unattributed = store.recordWorkUpdate(dashboardA.id, itemId, fingerprint, {
    requestId: request(),
    workAttemptId: attemptA,
    kind: "decision",
    body: "The implementation path was selected before task identity was available.",
    artifacts: [],
  });
  assert.equal(unattributed.deduplicated, false);
  assert.equal(store.showItem(dashboardA.id, itemId).item.workState, undefined);

  advance();
  store.upsertTaskStatus(itemId, status("task-a", "running"));
  store.upsertTaskStatus(itemId, status("task-b", "running"));
  advance();
  const needsInputRequest = request();
  store.recordWorkUpdate(dashboardA.id, itemId, fingerprint, {
    requestId: needsInputRequest,
    workAttemptId: attemptA,
    kind: "needs_input",
    body: "Choose whether to keep the compatibility path.",
    artifacts: [],
    task: { taskId: "task-a", hostId: "local" },
  });
  assert.throws(
    () =>
      store.recordWorkUpdate(dashboardA.id, itemId, fingerprint, {
        requestId: request(),
        workAttemptId: attemptA,
        kind: "decision",
        body: "An established task attribution cannot be dropped.",
        artifacts: [],
      }),
    (error) => error instanceof DynaCliStoreError && error.code === "request_conflict",
  );
  advance();
  store.recordWorkUpdate(dashboardA.id, itemId, fingerprint, {
    requestId: request(),
    workAttemptId: attemptB,
    kind: "blocked",
    body: "Pipeline evidence is unavailable.",
    artifacts: [],
    task: { taskId: "task-b", hostId: "local" },
  });
  shown = store.showItem(dashboardA.id, itemId);
  assert.equal(shown.item.workflowState, "paused");
  assert.equal(shown.item.workState, "needs_input");
  assert.equal(shown.item.workConditionSummary, "Choose whether to keep the compatibility path.");
  assert.deepEqual(shown.item.workConditionTask, { taskId: "task-a", hostId: "local" });
  assert.equal(shown.item.blocked, true);
  assert.equal(store.snapshot(dashboardA.id).counts.blocked, 1);

  advance();
  store.recordWorkUpdate(dashboardA.id, itemId, fingerprint, {
    requestId: request(),
    workAttemptId: randomUUID(),
    kind: "progress",
    body: "Pipeline evidence was recovered.",
    artifacts: [{ kind: "pipeline", label: "Pipeline", url: "https://example.com/p/42" }],
    task: { taskId: "task-b", hostId: "local" },
  });
  shown = store.showItem(dashboardA.id, itemId);
  assert.equal(shown.item.blocked, false);
  assert.equal(shown.item.workflowState, "paused");

  advance();
  const progressRequest = request();
  const progressInput = {
    requestId: progressRequest,
    workAttemptId: randomUUID(),
    kind: "progress",
    body: "Decision received; implementation is proceeding.",
    artifacts: [],
    task: { taskId: "task-a", hostId: "local" },
  };
  const progress = store.recordWorkUpdate(dashboardA.id, itemId, fingerprint, progressInput);
  const retry = store.recordWorkUpdate(dashboardA.id, itemId, fingerprint, progressInput);
  assert.equal(retry.workUpdateId, progress.workUpdateId);
  assert.equal(retry.deduplicated, true);
  assert.throws(
    () => store.recordWorkUpdate(dashboardB.id, itemId, fingerprint, progressInput),
    (error) => error instanceof DynaCliStoreError && error.code === "request_conflict",
  );
  assert.throws(
    () =>
      store.recordWorkUpdate(dashboardA.id, itemId, fingerprint, {
        ...progressInput,
        body: "Conflicting reuse",
      }),
    (error) => error instanceof DynaCliStoreError && error.code === "request_conflict",
  );
  shown = store.showItem(dashboardA.id, itemId);
  assert.equal(shown.item.workflowState, "executing");
  assert.equal(shown.item.workState, "progress");
  const sharedItem = store.showItem(dashboardB.id, itemId).item;
  assert.equal(sharedItem.workUpdates.length, 1);
  assert.equal(sharedItem.workUpdateCount, 5);

  advance();
  store.upsertTaskStatus(itemId, status("task-a", "running"));
  advance();
  store.upsertTaskStatus(itemId, status("task-b", "running"));
  shown = store.showItem(dashboardA.id, itemId);
  assert.equal(shown.item.workState, undefined);
  assert.equal(shown.item.workflowState, "executing");

  advance();
  store.recordWorkUpdate(dashboardA.id, itemId, fingerprint, {
    requestId: request(),
    workAttemptId: randomUUID(),
    kind: "completion_reported",
    body: "Implementation and checks are complete.",
    outcome: "MR review completed with release path verified.",
    artifacts: [{ kind: "report", label: "Report", url: "https://example.com/report" }],
    task: { taskId: "task-a", hostId: "local" },
  });
  assert.equal(store.showItem(dashboardA.id, itemId).item.workflowState, "executing");
  advance();
  store.upsertTaskStatus(itemId, status("task-a", "succeeded", "Task A finished."));
  assert.equal(store.showItem(dashboardA.id, itemId).item.workflowState, "executing");
  advance();
  store.upsertTaskStatus(itemId, status("task-b", "succeeded", "Task B finished."));
  shown = store.showItem(dashboardA.id, itemId);
  assert.equal(shown.item.workflowState, "completed");
  assert.equal(shown.item.workState, undefined);
  advance();
  assert.throws(
    () => store.upsertTaskStatus(itemId, status("task-a", "running")),
    (error) => error instanceof DynaCliStoreError && error.code === "request_conflict",
  );
  advance();
  assert.throws(
    () => store.upsertTaskStatus(itemId, status("task-b", "failed")),
    (error) => error instanceof DynaCliStoreError && error.code === "request_conflict",
  );
  shown = store.showItem(dashboardA.id, itemId);
  assert.equal(shown.item.workflowState, "completed");
  assert.deepEqual(
    shown.item.linkedTasks.map((task) => task.state),
    ["succeeded", "succeeded"],
  );
  advance();
  store.upsertTaskStatusForDashboard(
    dashboardA.id,
    itemId,
    status("task-a", "succeeded", "Task A finished."),
  );
  assert.throws(
    () =>
      store.upsertTaskStatusForDashboard(
        dashboardA.id,
        itemId,
        status("new-completed-task", "running"),
      ),
    (error) => error instanceof DynaCliStoreError && error.code === "completed_item",
  );
  assert.throws(
    () =>
      store.recordWorkUpdate(dashboardA.id, itemId, fingerprint, {
        requestId: request(),
        workAttemptId: randomUUID(),
        kind: "progress",
        body: "Should be a follow-up.",
        artifacts: [],
        task: { taskId: "task-a", hostId: "local" },
      }),
    (error) => error instanceof DynaCliStoreError && error.code === "completed_item",
  );
  store.recordWorkUpdate(dashboardA.id, itemId, fingerprint, {
    requestId: request(),
    workAttemptId: randomUUID(),
    kind: "note",
    body: "Historical note retained after completion.",
    artifacts: [],
  });

  shown = store.showItem(dashboardA.id, itemId);
  const archiveInput = {
    requestId: request(),
    reason: "completed",
  };
  const archived = store.archiveItemFromCli(
    dashboardA.id,
    itemId,
    shown.revision,
    fingerprint,
    archiveInput,
  );
  assert.equal(archived.reason, "completed");
  assert.equal(
    store.archiveItemFromCli(dashboardA.id, itemId, shown.revision, fingerprint, archiveInput)
      .deduplicated,
    true,
  );
  assert.equal(
    store.snapshot(dashboardA.id).cards.some((card) => card.id === itemId),
    false,
  );
  assert.equal(
    store.snapshot(dashboardB.id).cards.some((card) => card.id === itemId),
    true,
  );
  advance();
  store.upsertTaskStatusForDashboard(
    dashboardA.id,
    itemId,
    status("task-a", "succeeded", "Task A finished."),
  );
  assert.equal(
    store.snapshot(dashboardA.id).cards.some((card) => card.id === itemId),
    false,
  );
  assert.throws(
    () =>
      store.upsertTaskStatusForDashboard(
        dashboardA.id,
        itemId,
        status("new-archived-task", "running"),
      ),
    (error) => error instanceof DynaCliStoreError && error.code === "archived_item",
  );
  assert.throws(
    () =>
      store.recordWorkUpdate(dashboardA.id, itemId, fingerprint, {
        requestId: request(),
        workAttemptId: randomUUID(),
        kind: "handoff",
        body: "Continue elsewhere.",
        artifacts: [],
        task: { taskId: "task-a", hostId: "local" },
      }),
    (error) => error instanceof DynaCliStoreError && error.code === "archived_item",
  );
  const archivedNote = store.recordWorkUpdate(dashboardA.id, itemId, fingerprint, {
    requestId: request(),
    workAttemptId: randomUUID(),
    kind: "note",
    body: "Archive remains searchable with this note.",
    artifacts: [],
  });
  assert.equal(archivedNote.deduplicated, false);
  assert.equal(store.snapshot(dashboardA.id, "searchable", "archive").cards[0]?.id, itemId);

  shown = store.showItem(dashboardA.id, itemId);
  const followUp = store.createFollowUpFromCli(dashboardA.id, itemId, shown.revision, fingerprint, {
    requestId: request(),
    title: "Follow up on MR 42",
    summary: "New active work linked to historical evidence.",
    priority: "normal",
    labels: ["follow-up"],
  });
  assert.notEqual(followUp.itemId, itemId);
  const followUpShown = store.showItem(dashboardA.id, followUp.itemId);
  assert.equal(followUpShown.item.followUpOfItemId, itemId);
  const enriched = store.enrichItemFromCli(
    dashboardA.id,
    followUp.itemId,
    followUp.fingerprint,
    0,
    {
      requestId: request(),
      summary: "Evidence-bound follow-up summary.",
      provenance: "codex-task",
    },
  );
  assert.equal(enriched.enrichmentVersion, 1);
  const afterEnrich = store.showItem(dashboardA.id, followUp.itemId);
  const placed = store.placeItemFromCli(
    dashboardA.id,
    followUp.itemId,
    afterEnrich.revision,
    followUp.fingerprint,
    { requestId: request(), targetPriority: "high" },
  );
  assert.equal(placed.changed, true);
  assert.equal(store.showItem(dashboardA.id, followUp.itemId).item.priority, "high");

  shown = store.showItem(dashboardA.id, itemId);
  const restored = store.restoreItemFromCli(
    dashboardA.id,
    itemId,
    shown.revision,
    fingerprint,
    request(),
  );
  assert.equal(typeof restored.restoredAt, "string");
  assert.equal(store.itemHistory(dashboardA.id, itemId).workUpdates.length >= 7, true);
} finally {
  store.close();
}

const orderingDirectory = mkdtempSync(join(tmpdir(), "flowzone-dyna-work-order-"));
const orderingDatabasePath = join(orderingDirectory, "dyna.sqlite3");
try {
  const orderingAt = "2026-09-10T18:00:00.000Z";
  let orderingStore = new DynaStore({
    databasePath: orderingDatabasePath,
    clock: () => new Date(orderingAt),
  });
  const orderingDashboard = orderingStore.createDashboard(
    "Ordering regression",
    "Same-millisecond work update ordering",
  );
  const { publisher: orderingPublisher, secret: orderingSecret } = orderingStore.createPublisher(
    "Ordering source",
    undefined,
    undefined,
    "local_preview",
  );
  orderingStore.bindSchedule(orderingDashboard.id, orderingPublisher.id, {
    id: "ordering-schedule",
    title: "Ordering source",
    state: "active",
    staleAfterMinutes: 60,
  });
  orderingStore.publish(
    orderingPublisher.id,
    orderingSecret,
    [
      {
        externalId: "ordering-item",
        sourceRef: {
          source: "gitlab",
          instanceId: "gitlab.example.com",
          projectPath: "team/service",
          iid: 45,
          entityType: "merge_request",
        },
        sourceScope: "team/service",
        title: "Resolve same-millisecond state",
        summary: "The last inserted report must win.",
        priority: "normal",
        priorityReason: "Regression coverage",
        sourceUpdatedAt: orderingAt,
        labels: [],
      },
    ],
    { runId: "ordering-run", sourceCompletedAt: orderingAt, mode: "replace", status: "succeeded" },
  );
  const orderingItem = orderingStore.snapshot(orderingDashboard.id).cards[0];
  assert.ok(orderingItem);
  orderingStore.upsertTaskStatus(orderingItem.id, {
    taskId: "ordering-task",
    hostId: "local",
    title: "Codex ordering task",
    state: "running",
    statusUpdatedAt: orderingAt,
    observedAt: orderingAt,
  });
  orderingStore.close();

  const orderingDatabase = new DatabaseSync(orderingDatabasePath);
  const insertUpdate = orderingDatabase.prepare(
    `INSERT INTO work_updates (
       id, item_id, origin_dashboard_id, work_attempt_id, kind, body, outcome,
       artifacts, task_id, host_id, task_title, created_at, created_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, '[]', ?, ?, ?, ?, ?)`,
  );
  insertUpdate.run(
    "ffffffff-ffff-4fff-bfff-ffffffffffff",
    orderingItem.id,
    orderingDashboard.id,
    "11111111-1111-4111-8111-111111111111",
    "blocked",
    "Earlier blocked report with a lexically larger UUID.",
    "ordering-task",
    "local",
    "Codex ordering task",
    orderingAt,
    Date.parse(orderingAt),
  );
  insertUpdate.run(
    "00000000-0000-4000-8000-000000000000",
    orderingItem.id,
    orderingDashboard.id,
    "22222222-2222-4222-8222-222222222222",
    "progress",
    "Later progress report with a lexically smaller UUID.",
    "ordering-task",
    "local",
    "Codex ordering task",
    orderingAt,
    Date.parse(orderingAt),
  );
  orderingDatabase.close();

  orderingStore = new DynaStore({
    databasePath: orderingDatabasePath,
    clock: () => new Date(orderingAt),
  });
  const orderedItem = orderingStore.showItem(orderingDashboard.id, orderingItem.id).item;
  assert.equal(orderedItem.workflowState, "executing");
  assert.equal(orderedItem.workState, "progress");
  assert.equal(orderedItem.blocked, false);
  assert.equal(orderedItem.workUpdates[0]?.kind, "progress");
  orderingStore.close();
} finally {
  rmSync(orderingDirectory, { recursive: true, force: true });
}

const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-v5-v6-"));
const databasePath = join(directory, "dyna.sqlite3");
try {
  const seed = new DynaStore({ databasePath });
  const migrationDashboard = seed.createDashboard("Migration", "True v5 action schema");
  const { publisher: migrationPublisher, secret: migrationSecret } = seed.createPublisher(
    "Migration source",
    undefined,
    undefined,
    "local_preview",
  );
  seed.bindSchedule(migrationDashboard.id, migrationPublisher.id, {
    id: "migration-schedule",
    title: "Migration source",
    state: "active",
    staleAfterMinutes: 60,
  });
  seed.publish(
    migrationPublisher.id,
    migrationSecret,
    [
      {
        externalId: "migration-item",
        sourceRef: {
          source: "gitlab",
          instanceId: "gitlab.example.com",
          projectPath: "team/service",
          iid: 46,
          entityType: "merge_request",
        },
        sourceScope: "team/service",
        title: "Preserve action request",
        summary: "The action must survive migration and cascade on dashboard purge.",
        priority: "normal",
        priorityReason: "Migration coverage",
        sourceUpdatedAt: timestamp(),
        labels: [],
      },
    ],
    {
      runId: "migration-run",
      sourceCompletedAt: timestamp(),
      mode: "replace",
      status: "succeeded",
    },
  );
  const migrationSnapshot = seed.snapshot(migrationDashboard.id);
  const migrationItem = migrationSnapshot.cards[0];
  assert.ok(migrationItem);
  const migrationView = seed.createView(migrationDashboard.id);
  const migrationAction = seed.prepareAction(migrationView, "open_source", {
    itemId: migrationItem.id,
    expectedRevision: migrationSnapshot.revision,
    expectedFingerprint: migrationItem.fingerprint,
    idempotencyKey: "migration-action",
  });
  seed.close();
  const versionFive = new DatabaseSync(databasePath);
  versionFive.exec(`
    ALTER TABLE action_requests RENAME TO action_requests_v6_seed;
    CREATE TABLE action_requests (
      id TEXT PRIMARY KEY, view_token_hash BLOB NOT NULL, dashboard_id TEXT,
      kind TEXT NOT NULL, item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
      item_fingerprint TEXT, dashboard_revision INTEGER, task_id TEXT, host_id TEXT,
      idempotency_key TEXT, state TEXT NOT NULL, claim_token_hash BLOB, claim_expires_at TEXT,
      result_task_id TEXT, failure_message TEXT, uncertain_effect INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO action_requests (
      id, view_token_hash, dashboard_id, kind, item_id, item_fingerprint,
      dashboard_revision, task_id, host_id, idempotency_key, state,
      claim_token_hash, claim_expires_at, result_task_id, failure_message,
      uncertain_effect, expires_at, created_at, updated_at
    )
    SELECT id, view_token_hash, NULL, kind, item_id, item_fingerprint,
      dashboard_revision, task_id, host_id, idempotency_key, state,
      claim_token_hash, claim_expires_at, result_task_id, failure_message,
      uncertain_effect, expires_at, created_at, updated_at
    FROM action_requests_v6_seed;
    DROP TABLE action_requests_v6_seed;
    DROP TABLE cli_requests;
    DROP TABLE work_updates;
    PRAGMA user_version = 5;
  `);
  versionFive.close();
  chmodSync(databasePath, 0o600);
  const migrated = new DynaStore({ databasePath });
  migrated.close();
  const verified = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(verified.prepare("PRAGMA user_version").get().user_version, 7);
  assert.equal(
    verified
      .prepare(
        "SELECT COUNT(*) AS total FROM sqlite_schema WHERE type = 'table' AND name IN ('work_updates', 'cli_requests')",
      )
      .get().total,
    2,
  );
  const cliRequestColumns = verified.prepare("PRAGMA table_info(cli_requests)").all();
  assert.equal(cliRequestColumns.find((column) => column.name === "request_id")?.pk, 1);
  assert.equal(cliRequestColumns.find((column) => column.name === "dashboard_id")?.pk, 0);
  const actionRequestColumns = verified.prepare("PRAGMA table_info(action_requests)").all();
  assert.equal(actionRequestColumns.find((column) => column.name === "dashboard_id")?.notnull, 1);
  assert.deepEqual(
    verified
      .prepare("PRAGMA foreign_key_list(action_requests)")
      .all()
      .filter((foreignKey) => foreignKey.from === "dashboard_id")
      .map((foreignKey) => ({ table: foreignKey.table, onDelete: foreignKey.on_delete })),
    [{ table: "dashboards", onDelete: "CASCADE" }],
  );
  assert.equal(
    verified
      .prepare("SELECT dashboard_id FROM action_requests WHERE id = ?")
      .get(migrationAction.id)?.dashboard_id,
    migrationDashboard.id,
  );
  assert.deepEqual(
    verified
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'index' AND name IN (
           'idx_dyna_action_idempotency', 'idx_dyna_actions_item_state'
         ) ORDER BY name`,
      )
      .all()
      .map((row) => row.name),
    ["idx_dyna_action_idempotency", "idx_dyna_actions_item_state"],
  );
  verified.close();
  const incompleteV6 = new DatabaseSync(databasePath);
  incompleteV6.exec(`
    DROP INDEX idx_dyna_work_updates_task_state;
    DROP INDEX idx_dyna_action_idempotency;
    DROP INDEX idx_dyna_actions_item_state;
  `);
  incompleteV6.close();
  const repairedV6 = new DynaStore({ databasePath });
  repairedV6.close();
  const repairVerified = new DatabaseSync(databasePath, { readOnly: true });
  assert.deepEqual(
    repairVerified
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'index' AND name IN (
           'idx_dyna_work_updates_task_state',
           'idx_dyna_action_idempotency',
           'idx_dyna_actions_item_state'
         ) ORDER BY name`,
      )
      .all()
      .map((row) => row.name),
    [
      "idx_dyna_action_idempotency",
      "idx_dyna_actions_item_state",
      "idx_dyna_work_updates_task_state",
    ],
  );
  repairVerified.close();
  const purge = new DynaStore({ databasePath });
  purge.purgeDashboard(migrationDashboard.id, migrationDashboard.id);
  purge.close();
  const afterPurge = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(afterPurge.prepare("SELECT COUNT(*) AS total FROM action_requests").get().total, 0);
  afterPurge.close();
} finally {
  rmSync(directory, { recursive: true, force: true });
}

globalThis.process.stdout.write(
  JSON.stringify({
    globalActivity: true,
    localArchive: true,
    taskScopedProjection: true,
    mixedTaskWaiting: true,
    mixedTaskFailure: true,
    attributedLifecycleUpdates: true,
    succeededTaskReportsIgnored: true,
    succeededControllerTerminal: true,
    taskAttachLifecycleGuards: true,
    sameTimestampOrdering: true,
    globalRequestLedger: true,
    idempotentLedger: true,
    completedGuard: true,
    archiveHistory: true,
    followUp: true,
    enrichment: true,
    placement: true,
    restore: true,
  }),
);

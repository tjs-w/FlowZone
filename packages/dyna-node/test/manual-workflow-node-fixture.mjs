import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DynaCliStoreError, DynaStore } from "../src/store.ts";

let now = Date.parse("2026-09-11T16:00:00.000Z");
const timestamp = () => new Date(now).toISOString();
const request = () => randomUUID();
const store = new DynaStore({ databasePath: ":memory:", clock: () => new Date(now) });

function signal(externalId, iid, title) {
  return {
    externalId,
    sourceRef: {
      source: "gitlab",
      instanceId: "gitlab.example.com",
      projectPath: "team/service",
      iid,
      entityType: "merge_request",
    },
    sourceScope: "team/service",
    title,
    summary: `${title} summary`,
    priority: "high",
    priorityReason: "Direct request",
    sourceUpdatedAt: timestamp(),
    labels: [],
  };
}

try {
  const dashboardA = store.createDashboard("Primary", "Manual workflow changes");
  const dashboardB = store.createDashboard("Shared", "Same item, shared lifecycle");
  const { publisher, secret } = store.createPublisher(
    "Signals",
    undefined,
    undefined,
    "local_preview",
  );
  for (const dashboard of [dashboardA, dashboardB]) {
    store.bindSchedule(dashboard.id, publisher.id, {
      id: "manual-workflow-schedule",
      title: "Manual workflow schedule",
      state: "active",
      staleAfterMinutes: 60,
    });
  }
  store.publish(
    publisher.id,
    secret,
    [
      signal("taskless", 1, "Taskless decision"),
      signal("linked", 2, "Controller-owned work"),
      { ...signal("inflight", 3, "Creation in flight"), priority: "low" },
    ],
    {
      runId: "run-1",
      sourceCompletedAt: timestamp(),
      mode: "replace",
      status: "succeeded",
    },
  );

  let snapshot = store.snapshot(dashboardA.id);
  const taskless = snapshot.cards.find((card) => card.title === "Taskless decision");
  const linked = snapshot.cards.find((card) => card.title === "Controller-owned work");
  const inflight = snapshot.cards.find((card) => card.title === "Creation in flight");
  assert.ok(taskless && linked && inflight);
  const view = store.createView(dashboardA.id);
  const needsYouRequest = request();
  const needsYouInput = {
    viewToken: view,
    itemId: taskless.id,
    targetStage: "needs_you",
    expectedRevision: snapshot.revision,
    expectedFingerprint: taskless.fingerprint,
    clientRequestId: needsYouRequest,
  };
  const needsYou = store.setItemStatus(needsYouInput);
  assert.equal(needsYou.changed, true);
  assert.equal(needsYou.deduplicated, false);
  assert.equal(store.setItemStatus(needsYouInput).deduplicated, true);
  assert.throws(
    () =>
      store.setItemStatus({
        ...needsYouInput,
        targetStage: "todo",
      }),
    (error) => error instanceof DynaCliStoreError && error.code === "request_conflict",
  );

  snapshot = store.snapshot(dashboardA.id);
  assert.equal(snapshot.cards.find((card) => card.id === taskless.id)?.workflowState, "attention");
  assert.equal(
    store.snapshot(dashboardB.id).cards.find((card) => card.id === taskless.id)?.workflowState,
    "attention",
  );
  assert.throws(
    () =>
      store.setItemStatus({
        ...needsYouInput,
        clientRequestId: request(),
        targetStage: "todo",
      }),
    (error) => error instanceof DynaCliStoreError && error.code === "stale_dashboard",
  );
  const noOp = store.setItemStatus({
    ...needsYouInput,
    expectedRevision: snapshot.revision,
    clientRequestId: request(),
  });
  assert.equal(noOp.changed, false);
  assert.equal(store.itemHistory(dashboardB.id, taskless.id).statusChanges.length, 1);

  let tasklessCard = snapshot.cards.find((card) => card.id === taskless.id);
  assert.ok(tasklessCard);
  now += 1_000;
  const todo = store.setItemStatus({
    viewToken: view,
    itemId: taskless.id,
    targetStage: "todo",
    expectedRevision: snapshot.revision,
    expectedFingerprint: tasklessCard.fingerprint,
    clientRequestId: request(),
  });
  assert.equal(todo.changed, true);

  store.upsertTaskStatusForDashboard(dashboardA.id, linked.id, {
    taskId: "task-linked",
    hostId: "local",
    title: "Controller-owned task",
    state: "running",
    statusUpdatedAt: timestamp(),
    observedAt: timestamp(),
  });
  snapshot = store.snapshot(dashboardA.id);
  const linkedCard = snapshot.cards.find((card) => card.id === linked.id);
  assert.ok(linkedCard);
  assert.throws(
    () =>
      store.setItemStatus({
        viewToken: view,
        itemId: linked.id,
        targetStage: "needs_you",
        expectedRevision: snapshot.revision,
        expectedFingerprint: linkedCard.fingerprint,
        clientRequestId: request(),
      }),
    (error) => error instanceof DynaCliStoreError && error.code === "invalid_input",
  );
  assert.equal(
    store.snapshot(dashboardA.id).cards.find((card) => card.id === linked.id)?.workflowState,
    "executing",
  );

  snapshot = store.snapshot(dashboardA.id);
  const inflightCard = snapshot.cards.find((card) => card.id === inflight.id);
  assert.ok(inflightCard);
  const creation = store.prepareAction(view, "create_codex_task", {
    itemId: inflight.id,
    expectedRevision: snapshot.revision,
    expectedFingerprint: inflightCard.fingerprint,
    idempotencyKey: "manual-status-creation-race",
  });
  store.markDelivered(view, creation.id);
  const claimedCreation = store.claimAction(creation.id);
  const completeInflight = () =>
    store.setItemStatus({
      viewToken: view,
      itemId: inflight.id,
      targetStage: "done",
      outcome: "Must not complete while task creation is unresolved.",
      expectedRevision: store.snapshot(dashboardA.id).revision,
      expectedFingerprint: inflightCard.fingerprint,
      clientRequestId: request(),
    });
  assert.throws(
    completeInflight,
    (error) => error instanceof DynaCliStoreError && error.code === "invalid_input",
  );
  store.completeAction(creation.id, claimedCreation.claimToken, {
    outcome: "needs_reconciliation",
    failureMessage: "Controller could not confirm whether the task was created.",
  });
  assert.throws(
    completeInflight,
    (error) => error instanceof DynaCliStoreError && error.code === "invalid_input",
  );

  snapshot = store.snapshot(dashboardA.id);
  tasklessCard = snapshot.cards.find((card) => card.id === taskless.id);
  assert.ok(tasklessCard);
  now += 1_000;
  const completedAt = timestamp();
  const done = store.setItemStatus({
    viewToken: view,
    itemId: taskless.id,
    targetStage: "done",
    outcome: "Decision recorded and communicated.",
    expectedRevision: snapshot.revision,
    expectedFingerprint: tasklessCard.fingerprint,
    clientRequestId: request(),
  });
  assert.equal(done.changedAt, completedAt);
  snapshot = store.snapshot(dashboardA.id);
  const completedCard = snapshot.cards.find((card) => card.id === taskless.id);
  assert.equal(completedCard?.workflowState, "completed");
  assert.equal(completedCard?.completedAt, completedAt);
  assert.equal(completedCard?.outcome, "Decision recorded and communicated.");
  assert.equal(snapshot.counts.high, 1);
  assert.equal(
    store.setItemStatus({
      viewToken: view,
      itemId: taskless.id,
      targetStage: "done",
      outcome: "Decision recorded and communicated.",
      expectedRevision: snapshot.revision,
      expectedFingerprint: taskless.fingerprint,
      clientRequestId: request(),
    }).changed,
    false,
  );
  assert.throws(
    () =>
      store.setItemStatus({
        viewToken: view,
        itemId: taskless.id,
        targetStage: "done",
        outcome: "A conflicting completion outcome.",
        expectedRevision: snapshot.revision,
        expectedFingerprint: taskless.fingerprint,
        clientRequestId: request(),
      }),
    (error) => error instanceof DynaCliStoreError && error.code === "completed_item",
  );
  assert.throws(
    () =>
      store.setItemStatus({
        viewToken: view,
        itemId: taskless.id,
        targetStage: "todo",
        expectedRevision: snapshot.revision,
        expectedFingerprint: taskless.fingerprint,
        clientRequestId: request(),
      }),
    (error) => error instanceof DynaCliStoreError && error.code === "completed_item",
  );
  assert.throws(
    () =>
      store.upsertTaskStatusForDashboard(dashboardA.id, taskless.id, {
        taskId: "task-after-manual-completion",
        hostId: "local",
        title: "Must not attach",
        state: "running",
        statusUpdatedAt: timestamp(),
        observedAt: timestamp(),
      }),
    (error) => error instanceof DynaCliStoreError && error.code === "completed_item",
  );

  const sharedHistory = store.itemHistory(dashboardB.id, taskless.id);
  assert.deepEqual(
    sharedHistory.statusChanges.map((event) => event.targetStage),
    ["done", "todo", "needs_you"],
  );
  assert.equal(sharedHistory.statusChanges[0]?.originDashboardId, dashboardA.id);
  const firstStatusPage = store.itemHistory(dashboardB.id, taskless.id, { limit: 1 });
  assert.equal(firstStatusPage.statusChanges[0]?.targetStage, "done");
  assert.ok(firstStatusPage.statusHistoryNextCursor);
  const secondStatusPage = store.itemHistory(dashboardB.id, taskless.id, {
    limit: 1,
    statusCursor: firstStatusPage.statusHistoryNextCursor,
  });
  assert.equal(secondStatusPage.statusChanges[0]?.targetStage, "todo");
  assert.ok(secondStatusPage.statusHistoryNextCursor);
  const thirdStatusPage = store.itemHistory(dashboardB.id, taskless.id, {
    limit: 1,
    statusCursor: secondStatusPage.statusHistoryNextCursor,
  });
  assert.equal(thirdStatusPage.statusChanges[0]?.targetStage, "needs_you");
  assert.equal(thirdStatusPage.statusHistoryNextCursor, undefined);
  assert.throws(
    () =>
      store.itemHistory(dashboardB.id, taskless.id, {
        limit: 1,
        orderCursor: firstStatusPage.statusHistoryNextCursor,
      }),
    (error) => error instanceof DynaCliStoreError && error.code === "invalid_input",
  );

  now += 25 * 60 * 60 * 1_000;
  snapshot = store.snapshot(dashboardA.id);
  assert.equal(
    snapshot.cards.some((card) => card.id === taskless.id),
    false,
  );
  assert.equal(snapshot.counts.high, 1);
  const archived = store.snapshot(dashboardA.id, "communicated", "archive").cards[0];
  assert.equal(archived?.id, taskless.id);
  assert.equal(archived?.archive?.wasCompleted, true);
  const archivedHistory = store.itemHistory(dashboardA.id, taskless.id);
  assert.equal(
    archivedHistory.archives[0]?.outcomeAtArchive,
    "Decision recorded and communicated.",
  );

  const archiveSnapshot = store.snapshot(dashboardA.id, "", "archive");
  store.restoreItem(view, taskless.id, {
    expectedRevision: archiveSnapshot.revision,
    expectedFingerprint: taskless.fingerprint,
    clientRequestId: request(),
  });
  assert.equal(
    store.snapshot(dashboardA.id).cards.find((card) => card.id === taskless.id)?.workflowState,
    "completed",
  );

  globalThis.process.stdout.write(
    JSON.stringify({
      globalTasklessStatus: true,
      exactReplay: true,
      staleAndConflictGuards: true,
      linkedTaskAuthority: true,
      creationRaceGuard: true,
      manualCompletion: true,
      terminalCompletion: true,
      retentionAndArchiveEvidence: true,
      restoreHistory: true,
    }),
  );
} finally {
  store.close();
}

const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-v6-v7-"));
const databasePath = join(directory, "dyna.sqlite3");
try {
  const current = new DynaStore({ databasePath });
  current.close();
  const versionSix = new DatabaseSync(databasePath);
  versionSix.exec("DROP TABLE item_workflow_events; PRAGMA user_version = 6;");
  versionSix.close();
  const migrated = new DynaStore({ databasePath });
  migrated.close();
  const verified = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(verified.prepare("PRAGMA user_version").get().user_version, 7);
  assert.equal(
    verified
      .prepare(
        "SELECT COUNT(*) AS total FROM sqlite_schema WHERE type = 'table' AND name = 'item_workflow_events'",
      )
      .get().total,
    1,
  );
  verified.close();
} finally {
  rmSync(directory, { recursive: true, force: true });
}

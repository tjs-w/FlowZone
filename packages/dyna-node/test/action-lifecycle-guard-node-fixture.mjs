import assert from "node:assert/strict";

import { DynaStore } from "../src/store.ts";

let now = Date.parse("2026-09-10T20:00:00.000Z");
const timestamp = () => new Date(now).toISOString();
const advance = () => {
  now += 1_000;
  return timestamp();
};

function task(taskId, state) {
  const at = timestamp();
  return {
    taskId,
    hostId: "local",
    title: `Codex ${taskId}`,
    state,
    statusUpdatedAt: at,
    observedAt: at,
    ...(state === "succeeded" ? { outcome: `${taskId} completed.` } : {}),
  };
}

const store = new DynaStore({ databasePath: ":memory:", clock: () => new Date(now) });
try {
  const dashboard = store.createDashboard(
    "Action lifecycle guard",
    "New Codex tasks attach only to active unfinished work.",
  );
  const { publisher, secret } = store.createPublisher(
    "Lifecycle source",
    undefined,
    undefined,
    "local_preview",
  );
  store.bindSchedule(dashboard.id, publisher.id, {
    id: "lifecycle-schedule",
    title: "Lifecycle source",
    state: "active",
    staleAfterMinutes: 60,
  });
  const titles = [
    "Completed before prepare",
    "Archived before prepare",
    "Archived before claim",
    "Completed before claim",
    "Archived after claim",
    "Completed after claim",
  ];
  store.publish(
    publisher.id,
    secret,
    titles.map((title, index) => ({
      externalId: `lifecycle-${String(index + 1)}`,
      sourceRef: {
        source: "gitlab",
        instanceId: "gitlab.example.com",
        projectPath: "team/service",
        iid: index + 1,
        entityType: "merge_request",
      },
      sourceScope: "team/service",
      title,
      summary: "Regression coverage for task-attachment lifecycle boundaries.",
      priority: "normal",
      priorityReason: "Lifecycle integrity",
      sourceUpdatedAt: timestamp(),
      labels: [],
    })),
    {
      runId: "lifecycle-run",
      sourceCompletedAt: timestamp(),
      mode: "replace",
      status: "succeeded",
    },
  );
  const viewToken = store.createView(dashboard.id);
  const activeCard = (title) => {
    const snapshot = store.snapshot(dashboard.id);
    const card = snapshot.cards.find((candidate) => candidate.title === title);
    assert.ok(card, `Expected active card: ${title}`);
    return { card, revision: snapshot.revision };
  };
  const archivedCard = (title) => {
    const snapshot = store.snapshot(dashboard.id, "", "archive");
    const card = snapshot.cards.find((candidate) => candidate.title === title);
    assert.ok(card, `Expected archived card: ${title}`);
    return { card, revision: snapshot.revision };
  };
  const archive = (title) => {
    const { card, revision } = activeCard(title);
    store.archiveItem(viewToken, card.id, {
      reason: "no_action_needed",
      expectedRevision: revision,
      expectedFingerprint: card.fingerprint,
      clientRequestId: `archive-${card.id}`,
    });
    return card;
  };
  const prepare = (title, idempotencyKey) => {
    const { card, revision } = activeCard(title);
    const request = store.prepareAction(viewToken, "create_codex_task", {
      itemId: card.id,
      expectedRevision: revision,
      expectedFingerprint: card.fingerprint,
      idempotencyKey,
    });
    return { card, request };
  };

  let current = activeCard("Completed before prepare");
  advance();
  store.upsertTaskStatus(current.card.id, task("completed-before-prepare", "succeeded"));
  current = activeCard("Completed before prepare");
  assert.equal(current.card.workflowState, "completed");
  assert.throws(
    () =>
      store.prepareAction(viewToken, "create_codex_task", {
        itemId: current.card.id,
        expectedRevision: current.revision,
        expectedFingerprint: current.card.fingerprint,
        idempotencyKey: "completed-before-prepare",
      }),
    /completed Dyna work/,
  );

  const archivedBeforePrepare = archive("Archived before prepare");
  const archivedBeforePrepareSnapshot = archivedCard("Archived before prepare");
  assert.throws(
    () =>
      store.prepareAction(viewToken, "create_codex_task", {
        itemId: archivedBeforePrepare.id,
        expectedRevision: archivedBeforePrepareSnapshot.revision,
        expectedFingerprint: archivedBeforePrepare.fingerprint,
        idempotencyKey: "archived-before-prepare",
      }),
    /archived Dyna item/,
  );

  let prepared = prepare("Archived before claim", "archived-before-claim");
  store.markDelivered(viewToken, prepared.request.id);
  archive("Archived before claim");
  assert.throws(() => store.claimAction(prepared.request.id), /archived Dyna item/);
  assert.equal(store.actionStatus(prepared.request.id).state, "failed");

  current = activeCard("Completed before claim");
  advance();
  store.upsertTaskStatus(current.card.id, task("completed-before-claim-existing", "running"));
  prepared = prepare("Completed before claim", "completed-before-claim");
  store.markDelivered(viewToken, prepared.request.id);
  advance();
  store.upsertTaskStatus(prepared.card.id, task("completed-before-claim-existing", "succeeded"));
  assert.throws(() => store.claimAction(prepared.request.id), /completed Dyna work/);
  assert.equal(store.actionStatus(prepared.request.id).state, "failed");

  prepared = prepare("Archived after claim", "archived-after-claim");
  store.markDelivered(viewToken, prepared.request.id);
  const archivedClaim = store.claimAction(prepared.request.id);
  archive("Archived after claim");
  advance();
  const archivedCompletion = store.completeAction(prepared.request.id, archivedClaim.claimToken, {
    outcome: "succeeded",
    task: task("archived-after-claim-new", "running"),
  });
  assert.equal(archivedCompletion.state, "needs_reconciliation");
  assert.equal(
    store
      .showItem(dashboard.id, prepared.card.id)
      .item.linkedTasks.some((linked) => linked.taskId === "archived-after-claim-new"),
    false,
  );
  assert.throws(
    () =>
      store.resolveActionReconciliation(prepared.request.id, {
        outcome: "task_linked",
        task: task("archived-after-claim-new", "running"),
      }),
    /archived Dyna item/,
  );

  current = activeCard("Completed after claim");
  advance();
  store.upsertTaskStatus(current.card.id, task("completed-after-claim-existing", "running"));
  prepared = prepare("Completed after claim", "completed-after-claim");
  store.markDelivered(viewToken, prepared.request.id);
  const completedClaim = store.claimAction(prepared.request.id);
  advance();
  store.upsertTaskStatus(prepared.card.id, task("completed-after-claim-existing", "succeeded"));
  assert.equal(store.showItem(dashboard.id, prepared.card.id).item.workflowState, "completed");
  advance();
  const completedCompletion = store.completeAction(prepared.request.id, completedClaim.claimToken, {
    outcome: "succeeded",
    task: task("completed-after-claim-new", "running"),
  });
  assert.equal(completedCompletion.state, "needs_reconciliation");
  assert.equal(
    store
      .showItem(dashboard.id, prepared.card.id)
      .item.linkedTasks.some((linked) => linked.taskId === "completed-after-claim-new"),
    false,
  );
  assert.throws(
    () =>
      store.resolveActionReconciliation(prepared.request.id, {
        outcome: "task_linked",
        task: task("completed-after-claim-new", "running"),
      }),
    /completed Dyna work/,
  );

  globalThis.process.stdout.write(
    JSON.stringify({
      prepareGuards: true,
      claimGuards: true,
      archiveRace: true,
      completionRace: true,
      reconciliationGuards: true,
    }),
  );
} finally {
  store.close();
}

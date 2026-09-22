import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { DynaCliStoreError, DynaStore } from "../src/store.ts";

let now = Date.parse("2026-09-21T16:00:00.000Z");
const timestamp = () => new Date(now).toISOString();
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
  const dashboardA = store.createDashboard("Primary", "Temporary attention deferral");
  const dashboardB = store.createDashboard("Shared", "Independent dashboard preferences");
  const { publisher, secret } = store.createPublisher(
    "Signals",
    undefined,
    undefined,
    "local_preview",
  );
  for (const dashboard of [dashboardA, dashboardB]) {
    store.bindSchedule(dashboard.id, publisher.id, {
      id: "backlog-schedule",
      title: "Backlog schedule",
      state: "active",
      staleAfterMinutes: 60,
    });
  }
  store.publish(
    publisher.id,
    secret,
    [signal("attention", 1, "Needs a decision"), signal("linked", 2, "Linked work")],
    {
      runId: "run-1",
      sourceCompletedAt: timestamp(),
      mode: "replace",
      status: "succeeded",
    },
  );

  let snapshot = store.snapshot(dashboardA.id);
  const attention = snapshot.cards.find((card) => card.title === "Needs a decision");
  const linked = snapshot.cards.find((card) => card.title === "Linked work");
  assert.ok(attention && linked);
  const view = store.createView(dashboardA.id);

  store.setItemStatus({
    viewToken: view,
    itemId: attention.id,
    targetStage: "needs_you",
    expectedRevision: snapshot.revision,
    expectedFingerprint: attention.fingerprint,
    clientRequestId: randomUUID(),
  });
  snapshot = store.snapshot(dashboardA.id);
  const deferRequestId = randomUUID();
  const deferInput = {
    viewToken: view,
    itemId: attention.id,
    action: "defer",
    expectedRevision: snapshot.revision,
    expectedFingerprint: attention.fingerprint,
    clientRequestId: deferRequestId,
  };
  const deferred = store.setItemBacklog(deferInput);
  assert.equal(deferred.changed, true);
  assert.equal(deferred.deduplicated, false);
  assert.equal(
    Date.parse(deferred.backlog.until) - Date.parse(deferred.backlog.backloggedAt),
    86_400_000,
  );
  assert.equal(store.setItemBacklog(deferInput).deduplicated, true);
  assert.throws(
    () => store.setItemBacklog({ ...deferInput, action: "return" }),
    (error) => error instanceof DynaCliStoreError && error.code === "request_conflict",
  );

  snapshot = store.snapshot(dashboardA.id);
  const deferredCard = snapshot.cards.find((card) => card.id === attention.id);
  assert.equal(deferredCard?.workflowState, "attention");
  assert.equal(deferredCard?.backlog?.until, deferred.backlog.until);
  assert.equal(snapshot.counts.backlog, 1);
  assert.equal(snapshot.counts.high, 1);
  const sharedCard = store.snapshot(dashboardB.id).cards.find((card) => card.id === attention.id);
  assert.equal(sharedCard?.workflowState, "attention");
  assert.equal(sharedCard?.backlog, undefined);

  store.updateTask(dashboardA.id, linked.id, {
    taskId: "linked-task",
    hostId: "local",
    title: `:${String(linked.itemNumber)}: Linked work`,
    state: "running",
    statusUpdatedAt: timestamp(),
    observedAt: timestamp(),
  });
  snapshot = store.snapshot(dashboardA.id);
  const linkedCard = snapshot.cards.find((card) => card.id === linked.id);
  assert.ok(linkedCard);
  store.setItemBacklog({
    viewToken: view,
    itemId: linked.id,
    action: "defer",
    expectedRevision: snapshot.revision,
    expectedFingerprint: linkedCard.fingerprint,
    clientRequestId: randomUUID(),
  });
  snapshot = store.snapshot(dashboardA.id);
  assert.equal(snapshot.cards.find((card) => card.id === linked.id)?.workflowState, "executing");
  assert.equal(snapshot.cards.find((card) => card.id === linked.id)?.backlog !== undefined, true);
  assert.equal(snapshot.counts.backlog, 2);
  assert.equal(snapshot.counts.high, 0);

  const returned = store.setItemBacklog({
    viewToken: view,
    itemId: linked.id,
    action: "return",
    expectedRevision: snapshot.revision,
    expectedFingerprint: linkedCard.fingerprint,
    clientRequestId: randomUUID(),
  });
  assert.equal(returned.changed, true);
  snapshot = store.snapshot(dashboardA.id);
  assert.equal(snapshot.cards.find((card) => card.id === linked.id)?.backlog, undefined);
  assert.equal(snapshot.counts.backlog, 1);

  now += 24 * 60 * 60 * 1_000 + 1;
  snapshot = store.snapshot(dashboardA.id);
  const returnedAutomatically = snapshot.cards.find((card) => card.id === attention.id);
  assert.equal(returnedAutomatically?.backlog, undefined);
  assert.equal(returnedAutomatically?.workflowState, "attention");
  assert.equal(snapshot.counts.backlog, 0);
  assert.equal(snapshot.counts.high, 2);

  const freshView = store.createView(dashboardA.id);
  store.setItemStatus({
    viewToken: freshView,
    itemId: attention.id,
    targetStage: "done",
    outcome: "Decision completed.",
    expectedRevision: snapshot.revision,
    expectedFingerprint: attention.fingerprint,
    clientRequestId: randomUUID(),
  });
  snapshot = store.snapshot(dashboardA.id);
  assert.throws(
    () =>
      store.setItemBacklog({
        viewToken: freshView,
        itemId: attention.id,
        action: "defer",
        expectedRevision: snapshot.revision,
        expectedFingerprint: attention.fingerprint,
        clientRequestId: randomUUID(),
      }),
    (error) => error instanceof DynaCliStoreError && error.code === "completed_item",
  );

  globalThis.process.stdout.write(
    JSON.stringify({
      exactReplay: true,
      dashboardLocal: true,
      linkedItems: true,
      attentionExcluded: true,
      automaticReturn: true,
      completionGuard: true,
    }),
  );
} finally {
  store.close();
}

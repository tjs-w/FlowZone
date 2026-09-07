import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { DynaStore } from "../src/store.ts";

let now = Date.now() - 26 * 60 * 60 * 1_000;
const instant = () => new Date(now).toISOString();
const store = new DynaStore({ databasePath: ":memory:", clock: () => new Date(now) });

function source(externalId, title, updatedAt = instant()) {
  return {
    externalId,
    sourceRef: {
      source: "gitlab",
      instanceId: "gitlab.example.com",
      projectPath: "team/project",
      iid: Number(externalId.slice(1)),
      entityType: "merge_request",
    },
    sourceScope: "team/project",
    title,
    summary: `${title} summary`,
    priority: "normal",
    priorityReason: "Tracked executive work.",
    sourceUpdatedAt: updatedAt,
    labels: ["release"],
  };
}

try {
  const dashboard = store.createDashboard("Archive lifecycle", "Durable evidence");
  assert.equal(dashboard.doneRetentionHours, 24);
  const shortRetention = store.createDashboard("Short retention", "", 1);
  assert.equal(shortRetention.doneRetentionHours, 1);
  const { publisher, secret } = store.createPublisher(
    "Schedule",
    undefined,
    undefined,
    "local_preview",
  );
  store.bindSchedule(dashboard.id, publisher.id, {
    id: "archive-schedule",
    title: "Archive schedule",
    state: "active",
    staleAfterMinutes: 1_440,
  });
  store.publish(publisher.id, secret, [source("m1", "Completed MR"), source("m2", "Invalid MR")], {
    runId: "run-1",
    sourceCompletedAt: instant(),
    mode: "replace",
    status: "succeeded",
  });

  let snapshot = store.snapshot(dashboard.id);
  const completed = snapshot.cards.find((card) => card.title === "Completed MR");
  const invalid = snapshot.cards.find((card) => card.title === "Invalid MR");
  assert.ok(completed && invalid);
  const view = store.createView(dashboard.id);
  store.addAnnotation(view, completed.id, randomUUID(), "Retain this decision note.");
  store.upsertTaskStatus(completed.id, {
    taskId: "task-complete",
    hostId: "local",
    title: "Review completed MR",
    state: "succeeded",
    statusUpdatedAt: instant(),
    observedAt: instant(),
    outcome: "MR reviewed and release unblocked.",
  });

  snapshot = store.snapshot(dashboard.id);
  const invalidNow = snapshot.cards.find((card) => card.id === invalid.id);
  assert.ok(invalidNow);
  store.organizeItem(view, invalid.id, "bump", snapshot.revision, invalidNow.fingerprint);
  snapshot = store.snapshot(dashboard.id);
  const invalidRaised = snapshot.cards.find((card) => card.id === invalid.id);
  assert.ok(invalidRaised);
  const archiveRequestId = randomUUID();
  const manuallyArchived = store.archiveItem(view, invalid.id, {
    reason: "invalid",
    expectedRevision: snapshot.revision,
    expectedFingerprint: invalidRaised.fingerprint,
    clientRequestId: archiveRequestId,
  });
  assert.deepEqual(
    store.archiveItem(view, invalid.id, {
      reason: "invalid",
      expectedRevision: snapshot.revision,
      expectedFingerprint: invalidRaised.fingerprint,
      clientRequestId: archiveRequestId,
    }),
    manuallyArchived,
  );
  assert.throws(
    () =>
      store.archiveItem(view, completed.id, {
        reason: "other",
        expectedRevision: store.snapshot(dashboard.id).revision,
        expectedFingerprint: completed.fingerprint,
        clientRequestId: randomUUID(),
      }),
    /require a short explanation/,
  );

  now += 60_000;
  const changedAt = instant();
  store.publish(publisher.id, secret, [source("m2", "Invalid MR changed", changedAt)], {
    runId: "run-2",
    sourceCompletedAt: changedAt,
    mode: "upsert",
    status: "succeeded",
  });
  snapshot = store.snapshot(dashboard.id);
  assert.equal(
    snapshot.cards.some((card) => card.id === invalid.id),
    false,
  );
  const changedArchived = store
    .snapshot(dashboard.id, "changed", "archive")
    .cards.find((card) => card.id === invalid.id);
  assert.equal(changedArchived?.archive?.changedSinceArchive, true);

  now += 23 * 60 * 60 * 1_000;
  assert.equal(
    store.snapshot(dashboard.id).cards.some((card) => card.id === completed.id),
    true,
  );
  now += 2 * 60 * 60 * 1_000;
  snapshot = store.snapshot(dashboard.id);
  assert.equal(snapshot.counts.total, 0);
  assert.equal(snapshot.counts.archived, 2);
  const archived = store.snapshot(dashboard.id, "", "archive");
  const archivedCompleted = archived.cards.find((card) => card.id === completed.id);
  assert.ok(archivedCompleted?.archive);
  assert.equal(archivedCompleted.archive.reason, "completed");
  assert.equal(archivedCompleted.archive.mode, "automatic");
  assert.equal(archivedCompleted.archive.wasCompleted, true);
  assert.equal(archivedCompleted.outcome, "MR reviewed and release unblocked.");
  assert.equal(archivedCompleted.annotations[0]?.body, "Retain this decision note.");
  assert.equal(archivedCompleted.linkedTasks[0]?.taskId, "task-complete");

  const followUpId = store.addTodo(
    view,
    {
      title: "Follow up on completed MR",
      priority: "normal",
      labels: [],
      followUpOfItemId: completed.id,
    },
    randomUUID(),
  );
  assert.equal(store.snapshot(dashboard.id).cards[0]?.followUpOfItemId, completed.id);

  const allArchived = store.snapshot(dashboard.id, "", "archive");
  const restoredCard = allArchived.cards.find((card) => card.id === completed.id);
  assert.ok(restoredCard);
  const restoreRequestId = randomUUID();
  const restored = store.restoreItem(view, completed.id, {
    expectedRevision: allArchived.revision,
    expectedFingerprint: restoredCard.fingerprint,
    clientRequestId: restoreRequestId,
  });
  assert.deepEqual(
    store.restoreItem(view, completed.id, {
      expectedRevision: allArchived.revision,
      expectedFingerprint: restoredCard.fingerprint,
      clientRequestId: restoreRequestId,
    }),
    restored,
  );
  snapshot = store.snapshot(dashboard.id);
  assert.equal(
    snapshot.cards.some((card) => card.id === completed.id),
    true,
  );
  assert.equal(
    snapshot.cards.some((card) => card.id === followUpId),
    true,
  );

  const history = store.itemHistory(dashboard.id, invalid.id);
  assert.equal(history.archives[0]?.reason, "invalid");
  assert.equal(history.archives[0]?.priorityAtArchive, "high");
  assert.equal(history.organization[0]?.action, "bump");

  globalThis.process.stdout.write(
    JSON.stringify({
      retentionDefault: dashboard.doneRetentionHours === 24,
      retentionConfigurable: shortRetention.doneRetentionHours === 1,
      recentDoneVisible: true,
      automaticArchive: archivedCompleted.archive.mode === "automatic",
      activeCountsExcludeArchived: snapshot.counts.total === 2,
      manualDisposition: history.archives[0]?.reason === "invalid",
      evidencePreserved: archivedCompleted.annotations.length === 1,
      changedDoesNotReactivate: changedArchived?.archive?.changedSinceArchive === true,
      followUpLinked:
        snapshot.cards.find((card) => card.id === followUpId)?.followUpOfItemId === completed.id,
      restoredWithHistory:
        store.itemHistory(dashboard.id, completed.id).archives[0]?.restoredAt ===
        restored.restoredAt,
      priorityHistory: history.organization.length === 1,
    }),
  );
} finally {
  store.close();
}

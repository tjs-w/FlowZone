import assert from "node:assert/strict";

import { DynaStore } from "../src/store.ts";

let now = Date.parse("2026-09-10T21:00:00.000Z");
const timestamp = () => new Date(now).toISOString();
const advance = (milliseconds = 1_000) => {
  now += milliseconds;
  return timestamp();
};

const store = new DynaStore({ databasePath: ":memory:", clock: () => new Date(now) });
try {
  const dashboard = store.createDashboard("Session picker", "Attach an existing Codex session.");
  const otherDashboard = store.createDashboard("Other dashboard", "Capability isolation.");
  const { publisher, secret } = store.createPublisher(
    "Picker source",
    undefined,
    undefined,
    "local_preview",
  );
  store.bindSchedule(dashboard.id, publisher.id, {
    id: "picker-schedule",
    title: "Picker schedule",
    state: "active",
    staleAfterMinutes: 60,
  });
  store.publish(
    publisher.id,
    secret,
    ["Attach selected session", "Archive race", "Completion race", "Capacity guard"].map(
      (title, index) => ({
        externalId: `picker-${String(index + 1)}`,
        sourceRef: {
          source: "gitlab",
          instanceId: "gitlab.example.com",
          projectPath: "team/service",
          iid: index + 1,
          entityType: "merge_request",
        },
        sourceScope: "team/service",
        title,
        summary: "Session picker regression coverage.",
        priority: "normal",
        priorityReason: "Verify exact task association.",
        sourceUpdatedAt: timestamp(),
        labels: [],
      }),
    ),
    { runId: "picker-run", sourceCompletedAt: timestamp(), mode: "replace", status: "succeeded" },
  );
  const viewToken = store.createView(dashboard.id);
  const wrongViewToken = store.createView(otherDashboard.id);

  const card = (title) => {
    const snapshot = store.snapshot(dashboard.id);
    const item = snapshot.cards.find((candidate) => candidate.title === title);
    assert.ok(item, `Missing picker item ${title}`);
    return { item, revision: snapshot.revision };
  };
  const listSessions = (title, key, candidates) => {
    const current = card(title);
    const request = store.prepareAction(viewToken, "list_codex_sessions", {
      itemId: current.item.id,
      expectedRevision: current.revision,
      expectedFingerprint: current.item.fingerprint,
      idempotencyKey: key,
    });
    store.markDelivered(viewToken, request.id);
    const claim = store.claimAction(request.id);
    assert.equal(claim.request.kind, "list_codex_sessions");
    assert.equal(claim.context.task, undefined);
    assert.equal(
      store.completeAction(request.id, claim.claimToken, {
        outcome: "succeeded",
        candidates,
      }).state,
      "succeeded",
    );
    return { request, current };
  };

  const selectedCandidate = {
    taskId: "selected-task",
    hostId: "local",
    projectId: "project-1",
    title: "Selected from Codex",
    updatedAt: timestamp(),
  };
  const listed = listSessions("Attach selected session", "list-selected", [selectedCandidate]);
  const privateStatus = store.actionStatusForView(viewToken, listed.request.id);
  assert.deepEqual(privateStatus.candidates, [selectedCandidate]);
  assert.throws(
    () => store.actionStatusForView(wrongViewToken, listed.request.id),
    /not found in this view/,
  );
  assert.equal("candidates" in store.actionStatus(listed.request.id), false);

  assert.throws(
    () =>
      store.prepareAction(viewToken, "attach_codex_task", {
        itemId: listed.current.item.id,
        taskId: "not-listed",
        taskHostId: "local",
        sessionListRequestId: listed.request.id,
        expectedRevision: listed.current.revision,
        expectedFingerprint: listed.current.item.fingerprint,
        idempotencyKey: "attach-not-listed",
      }),
    /not in the authorized session list/,
  );
  const differentItem = card("Archive race");
  assert.throws(
    () =>
      store.prepareAction(viewToken, "attach_codex_task", {
        itemId: differentItem.item.id,
        taskId: selectedCandidate.taskId,
        taskHostId: selectedCandidate.hostId,
        sessionListRequestId: listed.request.id,
        expectedRevision: differentItem.revision,
        expectedFingerprint: differentItem.item.fingerprint,
        idempotencyKey: "attach-cross-item",
      }),
    /another Dyna view/,
  );

  const attachInput = {
    itemId: listed.current.item.id,
    taskId: selectedCandidate.taskId,
    taskHostId: selectedCandidate.hostId,
    sessionListRequestId: listed.request.id,
    expectedRevision: listed.current.revision,
    expectedFingerprint: listed.current.item.fingerprint,
    idempotencyKey: "attach-selected",
  };
  const attach = store.prepareAction(viewToken, "attach_codex_task", attachInput);
  assert.equal(store.prepareAction(viewToken, "attach_codex_task", attachInput).id, attach.id);
  assert.equal(
    store.prepareAction(viewToken, "attach_codex_task", {
      ...attachInput,
      idempotencyKey: "attach-selected-logical-retry",
    }).id,
    attach.id,
  );
  store.markDelivered(viewToken, attach.id);
  const attachClaim = store.claimAction(attach.id);
  assert.equal(attachClaim.request.taskId, selectedCandidate.taskId);
  assert.equal(attachClaim.request.taskHostId, selectedCandidate.hostId);
  assert.equal(attachClaim.context.task, undefined);
  assert.throws(
    () =>
      store.completeAction(attach.id, attachClaim.claimToken, {
        outcome: "succeeded",
        task: {
          taskId: "substituted-task",
          hostId: "local",
          title: "Substituted task",
          state: "running",
          statusUpdatedAt: timestamp(),
          observedAt: timestamp(),
        },
      }),
    /does not match the claimed request/,
  );
  advance();
  assert.equal(
    store.completeAction(attach.id, attachClaim.claimToken, {
      outcome: "succeeded",
      task: {
        taskId: selectedCandidate.taskId,
        hostId: selectedCandidate.hostId,
        projectId: selectedCandidate.projectId,
        title: "Controller-verified title",
        state: "running",
        statusUpdatedAt: timestamp(),
        observedAt: timestamp(),
      },
    }).state,
    "succeeded",
  );
  const attached = store.showItem(dashboard.id, listed.current.item.id).item.linkedTasks;
  assert.equal(attached.length, 1);
  assert.equal(attached[0]?.title, "Controller-verified title");

  const archiveListed = listSessions("Archive race", "list-archive-race", [
    { ...selectedCandidate, taskId: "archive-race-task", updatedAt: timestamp() },
  ]);
  const archiveAttach = store.prepareAction(viewToken, "attach_codex_task", {
    itemId: archiveListed.current.item.id,
    taskId: "archive-race-task",
    taskHostId: "local",
    sessionListRequestId: archiveListed.request.id,
    expectedRevision: archiveListed.current.revision,
    expectedFingerprint: archiveListed.current.item.fingerprint,
    idempotencyKey: "attach-archive-race",
  });
  store.markDelivered(viewToken, archiveAttach.id);
  const archiveClaim = store.claimAction(archiveAttach.id);
  const beforeArchive = card("Archive race");
  store.archiveItem(viewToken, beforeArchive.item.id, {
    reason: "no_action_needed",
    expectedRevision: beforeArchive.revision,
    expectedFingerprint: beforeArchive.item.fingerprint,
    clientRequestId: "archive-picker-race",
  });
  advance();
  assert.equal(
    store.completeAction(archiveAttach.id, archiveClaim.claimToken, {
      outcome: "succeeded",
      task: {
        taskId: "archive-race-task",
        hostId: "local",
        title: "Must not attach",
        state: "running",
        statusUpdatedAt: timestamp(),
        observedAt: timestamp(),
      },
    }).state,
    "failed",
  );
  assert.equal(store.showItem(dashboard.id, beforeArchive.item.id).item.linkedTasks.length, 0);

  const completionListed = listSessions("Completion race", "list-completion-race", [
    { ...selectedCandidate, taskId: "completion-race-task", updatedAt: timestamp() },
  ]);
  const completionAttach = store.prepareAction(viewToken, "attach_codex_task", {
    itemId: completionListed.current.item.id,
    taskId: "completion-race-task",
    taskHostId: "local",
    sessionListRequestId: completionListed.request.id,
    expectedRevision: completionListed.current.revision,
    expectedFingerprint: completionListed.current.item.fingerprint,
    idempotencyKey: "attach-completion-race",
  });
  store.markDelivered(viewToken, completionAttach.id);
  advance();
  store.upsertTaskStatus(completionListed.current.item.id, {
    taskId: "existing-completed-task",
    hostId: "local",
    title: "Existing completed task",
    state: "succeeded",
    outcome: "Completed before the picker claim.",
    statusUpdatedAt: timestamp(),
    observedAt: timestamp(),
  });
  assert.throws(() => store.claimAction(completionAttach.id), /completed Dyna work/);
  assert.equal(store.actionStatus(completionAttach.id).state, "failed");

  const capacityItem = card("Capacity guard").item;
  for (let index = 0; index < 8; index += 1) {
    store.upsertTaskStatus(capacityItem.id, {
      taskId: `capacity-task-${String(index)}`,
      hostId: "local",
      title: `Capacity task ${String(index)}`,
      state: "running",
      statusUpdatedAt: timestamp(),
      observedAt: timestamp(),
    });
    advance();
  }
  const capacityListed = listSessions("Capacity guard", "list-capacity", [
    { ...selectedCandidate, taskId: "capacity-task-9", updatedAt: timestamp() },
  ]);
  assert.throws(
    () =>
      store.prepareAction(viewToken, "attach_codex_task", {
        itemId: capacityListed.current.item.id,
        taskId: "capacity-task-9",
        taskHostId: "local",
        sessionListRequestId: capacityListed.request.id,
        expectedRevision: capacityListed.current.revision,
        expectedFingerprint: capacityListed.current.item.fingerprint,
        idempotencyKey: "attach-capacity",
      }),
    /more than eight Codex tasks/,
  );

  advance(10 * 60 * 1_000);
  assert.equal(store.actionStatusForView(viewToken, listed.request.id).candidates, undefined);
  assert.equal(
    store.prepareAction(viewToken, "attach_codex_task", attachInput).id,
    attach.id,
    "an exact idempotent retry must remain stable after candidate metadata expires",
  );

  globalThis.process.stdout.write(
    JSON.stringify({
      privateCandidates: true,
      exactSelection: true,
      idempotentPrepare: true,
      controllerMetadata: true,
      archiveGuard: true,
      completionGuard: true,
      ephemeralExpiry: true,
    }),
  );
} finally {
  store.close();
}

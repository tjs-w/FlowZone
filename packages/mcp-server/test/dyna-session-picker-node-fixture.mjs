import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { canonicalDynaTaskTitle, DynaApplicationService } from "@flowzone/dyna-node";

import { createDynaPlugin } from "../src/plugins/dyna.ts";

const executionContext = {
  plugin: "dyna",
  action: "test",
  requestId: "test-request",
  signal: new globalThis.AbortController().signal,
  reportProgress: () => Promise.resolve(),
};

function action(actions, id) {
  const found = actions.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing Dyna action ${id}`);
  return found;
}

function appTool(appTools, name) {
  const found = appTools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing Dyna app tool ${name}`);
  return found;
}

async function execute(target, input) {
  if (target.executor.kind !== "module") throw new Error("Expected a module action");
  return (await target.executor.execute(input, executionContext)).result;
}

async function call(target, input) {
  return target.handler(input, {
    signal: executionContext.signal,
    requestId: executionContext.requestId,
  });
}

const now = "2026-09-10T21:00:00.000Z";
const service = new DynaApplicationService({
  databasePath: ":memory:",
  clock: () => new Date(now),
  actor: {
    kind: "mcp_host",
    capabilities: [
      "dashboard:read",
      "dashboard:manage",
      "item:read",
      "work:update",
      "work:enrich",
      "work:complete",
      "annotation:manage",
      "item:organize",
      "item:lifecycle",
      "follow-up:create",
      "todo:create",
      "publisher:publish",
      "publisher:manage",
      "view:interact",
      "action:execute",
      "task:observe",
    ],
  },
});
const plugin = createDynaPlugin({ service });
const actions = plugin.actions;
const appTools = plugin.appTools ?? [];

try {
  const dashboard = service.createDashboard("Session picker", "Private candidate metadata.");
  const { publisher, secret } = service.createPublisher(
    "Picker source",
    undefined,
    undefined,
    "local_preview",
  );
  service.bindSchedule(dashboard.id, publisher.id, {
    id: "picker-schedule",
    title: "Picker schedule",
    state: "active",
    staleAfterMinutes: 60,
  });
  service.publish(
    publisher.id,
    secret,
    [
      {
        externalId: "picker-item",
        sourceRef: {
          source: "gitlab",
          instanceId: "gitlab.example.com",
          projectPath: "team/service",
          iid: 1,
          entityType: "merge_request",
        },
        sourceScope: "team/service",
        title: "Attach existing Codex session",
        summary: "Candidates remain app-private.",
        priority: "normal",
        priorityReason: "Verify private picker flow.",
        sourceUpdatedAt: now,
        labels: [],
      },
      {
        externalId: "competing-picker-item",
        sourceRef: {
          source: "gitlab",
          instanceId: "gitlab.example.com",
          projectPath: "team/service",
          iid: 2,
          entityType: "merge_request",
        },
        sourceScope: "team/service",
        title: "Compete for existing Codex session",
        summary: "Only one Dyna item may reserve a native task.",
        priority: "low",
        priorityReason: "Exercise the association race boundary.",
        sourceUpdatedAt: now,
        labels: [],
      },
    ],
    { runId: "picker-run", sourceCompletedAt: now, mode: "replace", status: "succeeded" },
  );
  const payload = service.render(dashboard.id);
  const card = payload.snapshot.cards.find(
    (candidate) => candidate.title === "Attach existing Codex session",
  );
  const competingCard = payload.snapshot.cards.find(
    (candidate) => candidate.title === "Compete for existing Codex session",
  );
  assert.ok(card);
  assert.ok(competingCard);

  const prepare = appTool(appTools, "dyna_prepare_action");
  const markDelivered = appTool(appTools, "dyna_mark_action_delivered");
  const actionStatus = appTool(appTools, "dyna_action_status");
  assert.equal(
    prepare.inputSchema.safeParse({
      viewToken: payload.viewToken,
      itemId: card.id,
      kind: "attach_codex_task",
      taskId: "selected-task",
      taskHostId: "local",
      expectedRevision: payload.snapshot.revision,
      expectedFingerprint: card.fingerprint,
      idempotencyKey: "missing-list",
    }).success,
    false,
  );

  const preparedList = await call(prepare, {
    viewToken: payload.viewToken,
    itemId: card.id,
    kind: "list_codex_sessions",
    expectedRevision: payload.snapshot.revision,
    expectedFingerprint: card.fingerprint,
    idempotencyKey: "list-sessions",
  });
  const listRequestId = preparedList.structuredContent.requestId;
  assert.equal(typeof listRequestId, "string");
  await call(markDelivered, { viewToken: payload.viewToken, requestId: listRequestId });
  const listClaim = await execute(action(actions, "claim-action"), { requestId: listRequestId });
  const candidates = [
    {
      taskId: "selected-task",
      hostId: "local",
      projectId: "project-1",
      title: "Selected task",
      updatedAt: now,
    },
  ];
  const completeAction = action(actions, "complete-action");
  const checkAssociation = action(actions, "check-codex-task-association");
  const attachTask = action(actions, "attach-codex-task");
  const reservationRequestId = randomUUID();
  const associationReservation = await execute(checkAssociation, {
    dashboardId: dashboard.id,
    itemId: card.id,
    taskId: "preflight-task",
    reservationRequestId,
  });
  assert.equal(associationReservation.association, "attachable");
  assert.equal(associationReservation.reservationId, reservationRequestId);
  assert.equal(typeof associationReservation.expiresAt, "string");
  assert.deepEqual(
    await execute(checkAssociation, {
      dashboardId: dashboard.id,
      itemId: card.id,
      taskId: "preflight-task",
      reservationRequestId,
    }),
    associationReservation,
  );
  assert.deepEqual(
    await execute(checkAssociation, {
      dashboardId: dashboard.id,
      itemId: card.id,
      taskId: "preflight-task",
      reservationRequestId: randomUUID(),
    }),
    { association: "not_attachable" },
  );
  const preflightTask = {
    taskId: "preflight-task",
    hostId: "local",
    title: canonicalDynaTaskTitle(card.itemNumber, "Reserved direct task"),
    state: "running",
    statusUpdatedAt: now,
    observedAt: now,
  };
  await assert.rejects(
    () => execute(attachTask, { dashboardId: dashboard.id, itemId: card.id, task: preflightTask }),
    /reservation/u,
  );
  assert.deepEqual(
    await execute(attachTask, {
      dashboardId: dashboard.id,
      itemId: card.id,
      associationReservationId: associationReservation.reservationId,
      task: preflightTask,
    }),
    { ok: true },
  );
  assert.deepEqual(
    await execute(attachTask, {
      dashboardId: dashboard.id,
      itemId: card.id,
      task: {
        ...preflightTask,
        hostId: "remote-direct",
        title: canonicalDynaTaskTitle(card.itemNumber, "Reserved direct task refreshed"),
        statusUpdatedAt: "2026-09-10T21:00:01.000Z",
        observedAt: "2026-09-10T21:00:01.000Z",
      },
    }),
    { ok: true },
  );
  const refreshedDirectTask = service
    .snapshot(dashboard.id)
    .cards.find((candidate) => candidate.id === card.id)
    ?.linkedTasks.find((task) => task.taskId === "preflight-task");
  assert.equal(refreshedDirectTask?.hostId, "remote-direct");
  assert.equal(
    refreshedDirectTask?.title,
    canonicalDynaTaskTitle(card.itemNumber, "Reserved direct task refreshed"),
  );
  assert.equal(
    completeAction.inputSchema.safeParse({
      requestId: listRequestId,
      claimToken: listClaim.claimToken,
      outcome: "succeeded",
      candidates: [{ ...candidates[0], transcript: "must not cross the boundary" }],
    }).success,
    false,
  );
  const completedList = await execute(completeAction, {
    requestId: listRequestId,
    claimToken: listClaim.claimToken,
    outcome: "succeeded",
    candidates,
  });
  assert.equal(completedList.state, "succeeded");
  assert.equal("candidates" in completedList, false);

  const privateListStatus = await call(actionStatus, {
    viewToken: payload.viewToken,
    requestId: listRequestId,
  });
  assert.equal("candidates" in privateListStatus.structuredContent, false);
  assert.deepEqual(privateListStatus._meta.dynaCodexSessionCandidates, candidates);

  const attachmentRevision = service.snapshot(dashboard.id).revision;
  const competingList = await call(prepare, {
    viewToken: payload.viewToken,
    itemId: competingCard.id,
    kind: "list_codex_sessions",
    expectedRevision: attachmentRevision,
    expectedFingerprint: competingCard.fingerprint,
    idempotencyKey: "list-sessions-competing-item",
  });
  const competingListRequestId = competingList.structuredContent.requestId;
  assert.equal(typeof competingListRequestId, "string");
  await call(markDelivered, {
    viewToken: payload.viewToken,
    requestId: competingListRequestId,
  });
  const competingListClaim = await execute(action(actions, "claim-action"), {
    requestId: competingListRequestId,
  });
  assert.equal(
    (
      await execute(completeAction, {
        requestId: competingListRequestId,
        claimToken: competingListClaim.claimToken,
        outcome: "succeeded",
        candidates,
      })
    ).state,
    "succeeded",
  );

  const preparedAttach = await call(prepare, {
    viewToken: payload.viewToken,
    itemId: card.id,
    kind: "attach_codex_task",
    taskId: "selected-task",
    taskHostId: "local",
    sessionListRequestId: listRequestId,
    expectedRevision: attachmentRevision,
    expectedFingerprint: card.fingerprint,
    idempotencyKey: "attach-selected",
  });
  const competingAttach = await call(prepare, {
    viewToken: payload.viewToken,
    itemId: competingCard.id,
    kind: "attach_codex_task",
    taskId: "selected-task",
    taskHostId: "local",
    sessionListRequestId: competingListRequestId,
    expectedRevision: attachmentRevision,
    expectedFingerprint: competingCard.fingerprint,
    idempotencyKey: "attach-selected-competing-item",
  });
  const attachRequestId = preparedAttach.structuredContent.requestId;
  const competingAttachRequestId = competingAttach.structuredContent.requestId;
  assert.equal(typeof attachRequestId, "string");
  assert.equal(typeof competingAttachRequestId, "string");
  await call(markDelivered, { viewToken: payload.viewToken, requestId: attachRequestId });
  await call(markDelivered, {
    viewToken: payload.viewToken,
    requestId: competingAttachRequestId,
  });
  const attachClaim = await execute(action(actions, "claim-action"), {
    requestId: attachRequestId,
  });
  assert.equal(attachClaim.context.task, undefined);
  await assert.rejects(
    () =>
      execute(action(actions, "claim-action"), {
        requestId: competingAttachRequestId,
      }),
    /owned or reserved/u,
  );
  await assert.rejects(
    () =>
      execute(completeAction, {
        requestId: attachRequestId,
        claimToken: attachClaim.claimToken,
        outcome: "succeeded",
        task: {
          taskId: "selected-task",
          hostId: "remote-host",
          projectId: "project-1",
          title: "Unverified native title",
          state: "running",
          statusUpdatedAt: now,
          observedAt: now,
        },
      }),
    new RegExp(`must begin with :${String(card.itemNumber)}: exactly once`, "u"),
  );
  assert.equal(
    (
      await execute(completeAction, {
        requestId: attachRequestId,
        claimToken: attachClaim.claimToken,
        outcome: "succeeded",
        task: {
          taskId: "selected-task",
          hostId: "remote-host",
          projectId: "project-1",
          title: canonicalDynaTaskTitle(card.itemNumber, "Controller-verified selected task"),
          state: "running",
          statusUpdatedAt: now,
          observedAt: now,
        },
      })
    ).state,
    "succeeded",
  );
  const attachedCard = service
    .snapshot(dashboard.id)
    .cards.find((candidate) => candidate.id === card.id);
  assert.equal(
    attachedCard?.linkedTasks.some((task) => task.taskId === "selected-task"),
    true,
  );
  assert.deepEqual(
    await execute(checkAssociation, {
      dashboardId: dashboard.id,
      itemId: card.id,
      taskId: "selected-task",
      reservationRequestId: randomUUID(),
    }),
    { association: "same_item", hostId: "remote-host" },
  );

  const latest = service.snapshot(dashboard.id);
  const uncertainAttach = await call(prepare, {
    viewToken: payload.viewToken,
    itemId: card.id,
    kind: "attach_codex_task",
    taskId: "selected-task",
    taskHostId: "local",
    sessionListRequestId: listRequestId,
    expectedRevision: latest.revision,
    expectedFingerprint: card.fingerprint,
    idempotencyKey: "attach-selected-reconcile",
  });
  const uncertainRequestId = uncertainAttach.structuredContent.requestId;
  await call(markDelivered, { viewToken: payload.viewToken, requestId: uncertainRequestId });
  const uncertainClaim = await execute(action(actions, "claim-action"), {
    requestId: uncertainRequestId,
  });
  const uncertainResult = await execute(completeAction, {
    requestId: uncertainRequestId,
    claimToken: uncertainClaim.claimToken,
    outcome: "needs_reconciliation",
    failureMessage: "Native title read-back was uncertain.",
  });
  assert.equal(uncertainResult.state, "needs_reconciliation");
  const resolveReconciliation = action(actions, "resolve-action-reconciliation");
  await assert.rejects(
    () =>
      execute(resolveReconciliation, {
        requestId: uncertainRequestId,
        outcome: "task_linked",
        task: {
          taskId: "substituted-task",
          hostId: "local",
          title: canonicalDynaTaskTitle(card.itemNumber, "Substituted task"),
          state: "running",
          statusUpdatedAt: now,
          observedAt: now,
        },
      }),
    /does not match the selected attachment/u,
  );
  const reconciled = await execute(resolveReconciliation, {
    requestId: uncertainRequestId,
    outcome: "task_linked",
    task: {
      taskId: "selected-task",
      hostId: "remote-host",
      projectId: "project-1",
      title: canonicalDynaTaskTitle(card.itemNumber, "Controller-verified selected task"),
      state: "running",
      statusUpdatedAt: now,
      observedAt: now,
    },
  });
  assert.equal(reconciled.state, "succeeded");

  globalThis.process.stdout.write(
    JSON.stringify({
      prepareSchema: true,
      privateMetadata: true,
      transcriptRejected: true,
      exactAttachment: true,
      ownershipPreflight: true,
      directReservationRequired: true,
      reservationReplay: true,
      claimReservationRace: true,
      sameItemRefreshIdempotent: true,
      canonicalTitleRequired: true,
      attachmentReconciliation: true,
    }),
  );
} finally {
  service.close();
}

import assert from "node:assert/strict";

import { DynaService } from "@flowzone/dyna-node";

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
const service = new DynaService({ databasePath: ":memory:", clock: () => new Date(now) });
const plugin = createDynaPlugin({ service });
const actions = plugin.actions;
const appTools = plugin.appTools ?? [];

try {
  const dashboard = service.store.createDashboard("Session picker", "Private candidate metadata.");
  const { publisher, secret } = service.store.createPublisher(
    "Picker source",
    undefined,
    undefined,
    "local_preview",
  );
  service.store.bindSchedule(dashboard.id, publisher.id, {
    id: "picker-schedule",
    title: "Picker schedule",
    state: "active",
    staleAfterMinutes: 60,
  });
  service.store.publish(
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
    ],
    { runId: "picker-run", sourceCompletedAt: now, mode: "replace", status: "succeeded" },
  );
  const payload = service.render(dashboard.id);
  const card = payload.snapshot.cards[0];
  assert.ok(card);

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

  const preparedAttach = await call(prepare, {
    viewToken: payload.viewToken,
    itemId: card.id,
    kind: "attach_codex_task",
    taskId: "selected-task",
    taskHostId: "local",
    sessionListRequestId: listRequestId,
    expectedRevision: payload.snapshot.revision,
    expectedFingerprint: card.fingerprint,
    idempotencyKey: "attach-selected",
  });
  const attachRequestId = preparedAttach.structuredContent.requestId;
  assert.equal(typeof attachRequestId, "string");
  await call(markDelivered, { viewToken: payload.viewToken, requestId: attachRequestId });
  const attachClaim = await execute(action(actions, "claim-action"), {
    requestId: attachRequestId,
  });
  assert.equal(attachClaim.context.task, undefined);
  assert.equal(
    (
      await execute(completeAction, {
        requestId: attachRequestId,
        claimToken: attachClaim.claimToken,
        outcome: "succeeded",
        task: {
          taskId: "selected-task",
          hostId: "local",
          projectId: "project-1",
          title: "Controller-verified selected task",
          state: "running",
          statusUpdatedAt: now,
          observedAt: now,
        },
      })
    ).state,
    "succeeded",
  );
  assert.equal(service.snapshot(dashboard.id).cards[0]?.linkedTasks[0]?.taskId, "selected-task");

  globalThis.process.stdout.write(
    JSON.stringify({
      prepareSchema: true,
      privateMetadata: true,
      transcriptRejected: true,
      exactAttachment: true,
    }),
  );
} finally {
  service.close();
}

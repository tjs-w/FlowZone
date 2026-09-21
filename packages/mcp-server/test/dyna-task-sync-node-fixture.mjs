import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createDynaPlugin } from "../src/plugins/dyna.ts";

const now = "2026-09-14T18:00:00.000Z";
const dashboardId = randomUUID();
const itemId = randomUUID();
const runId = randomUUID();
const viewToken = "v".repeat(32);
const claimToken = "c".repeat(32);
const summary = {
  runId,
  dashboardId,
  state: "syncing",
  processedTasks: 0,
  totalTasks: 1,
  updatedItems: 0,
  unavailableTasks: 0,
  incompleteMetadataTasks: 0,
  remainingTasks: 1,
  startedAt: now,
  updatedAt: now,
};
const target = {
  itemId,
  itemNumber: 184,
  taskId: "task-1",
  hostId: "local",
  checkpointVersion: 0,
  afterCursor: "opaque-cursor",
};
const calls = [];
const service = {
  beginTaskSyncForView(receivedViewToken, scope) {
    calls.push(["begin", receivedViewToken, scope]);
    return {
      schema: "dyna/task-sync-begin-result-v1",
      joined: false,
      deliveryRequired: true,
      summary,
    };
  },
  markTaskSyncDeliveredForView(receivedViewToken, receivedRunId) {
    calls.push(["delivered", receivedViewToken, receivedRunId]);
    return { schema: "dyna/task-sync-status-result-v1", summary };
  },
  taskSyncStatusForView(receivedViewToken, receivedRunId) {
    calls.push(["status", receivedViewToken, receivedRunId]);
    return { schema: "dyna/task-sync-status-result-v1", summary };
  },
  claimTaskSync(receivedRunId) {
    calls.push(["claim", receivedRunId]);
    return {
      schema: "dyna/task-sync-claim-v1",
      runId,
      dashboardId,
      claimToken,
      leaseExpiresAt: "2026-09-14T18:05:00.000Z",
      totalTasks: 1,
      remainingTasks: 0,
      targets: [target],
    };
  },
  submitTaskSyncBatch(receivedRunId, receivedClaimToken, input) {
    calls.push(["batch", receivedRunId, receivedClaimToken, input]);
    return {
      schema: "dyna/task-sync-batch-result-v1",
      acceptedTasks: 1,
      deduplicated: false,
      leaseExpiresAt: "2026-09-14T18:05:00.000Z",
      summary: { ...summary, processedTasks: 1, remainingTasks: 0 },
    };
  },
  completeTaskSync(receivedRunId, receivedClaimToken, input) {
    calls.push(["complete", receivedRunId, receivedClaimToken, input]);
    return {
      schema: "dyna/task-sync-status-result-v1",
      summary: {
        ...summary,
        state: "partial",
        processedTasks: 1,
        updatedItems: 1,
        incompleteMetadataTasks: 1,
        remainingTasks: 0,
        completedAt: now,
      },
    };
  },
};

const executionContext = {
  plugin: "dyna",
  action: "test",
  requestId: "task-sync-test",
  signal: new globalThis.AbortController().signal,
  reportProgress: () => Promise.resolve(),
};

function appTool(appTools, name) {
  const found = appTools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing Dyna app tool ${name}`);
  return found;
}

function action(actions, id) {
  const found = actions.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing Dyna action ${id}`);
  return found;
}

async function call(target, input) {
  return target.handler(input, {
    signal: executionContext.signal,
    requestId: executionContext.requestId,
  });
}

async function execute(target, input) {
  if (target.executor.kind !== "module") throw new Error("Expected a module action");
  return (await target.executor.execute(input, executionContext)).result;
}

const plugin = createDynaPlugin({ service });
const appTools = plugin.appTools ?? [];
const begin = appTool(appTools, "dyna_begin_task_sync");
const delivered = appTool(appTools, "dyna_mark_task_sync_delivered");
const status = appTool(appTools, "dyna_task_sync_status");
const claim = action(plugin.actions, "claim-task-sync");
const batch = action(plugin.actions, "submit-task-sync-batch");
const complete = action(plugin.actions, "complete-task-sync");

assert.equal(
  plugin.actions.some((candidate) => candidate.id === begin.name),
  false,
);
assert.equal(
  appTools.some((candidate) => candidate.name === claim.id),
  false,
);
assert.deepEqual(begin.annotations, {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
});
assert.deepEqual(status.annotations, {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
});
assert.equal(
  begin.inputSchema.safeParse({ viewToken, scope: { kind: "dashboard" }, transcript: "no" })
    .success,
  false,
);
assert.equal(
  begin.inputSchema.safeParse({
    viewToken,
    scope: { kind: "task", itemId, taskId: "task-1" },
  }).success,
  false,
);
const cancelled = new globalThis.AbortController();
cancelled.abort(new Error("cancelled before mutation"));
assert.throws(
  () =>
    begin.handler(
      { viewToken, scope: { kind: "dashboard" } },
      { signal: cancelled.signal, requestId: "cancelled" },
    ),
  /cancelled before mutation/u,
);

const begun = await call(begin, { viewToken, scope: { kind: "dashboard" } });
assert.deepEqual(begun.content, []);
assert.equal(begun.structuredContent.deliveryRequired, true);
assert.equal("claimToken" in begun.structuredContent, false);
assert.equal("afterCursor" in begun.structuredContent, false);
assert.deepEqual((await call(delivered, { viewToken, runId })).structuredContent, {
  schema: "dyna/task-sync-status-result-v1",
  summary,
});
assert.deepEqual((await call(status, { viewToken, runId })).structuredContent, {
  schema: "dyna/task-sync-status-result-v1",
  summary,
});

const claimed = await execute(claim, { runId });
assert.equal(claimed.targets.length, 1);
assert.equal(claimed.targets[0].afterCursor, "opaque-cursor");
assert.equal(claimed.claimToken, claimToken);
assert.equal(claim.inputSchema.safeParse({ runId, dashboardId }).success, false);

const observation = {
  taskId: "task-1",
  checkpointVersion: 0,
  task: {
    taskId: "task-1",
    hostId: "local",
    title: ":184: Restore release path",
    state: "succeeded",
    statusUpdatedAt: now,
    observedAt: now,
  },
  summaryCoverage: "available",
  nextCursor: "next-opaque-cursor",
  delta: {
    kind: "progress",
    body: "Validated the release repair against the focused test suite.",
    artifacts: [{ kind: "report", label: "Focused results", url: "https://example.test/r/1" }],
  },
};
assert.equal(
  batch.inputSchema.safeParse({
    runId,
    claimToken,
    requestId: randomUUID(),
    observations: [{ ...observation, transcript: "must not cross" }],
    unavailable: [],
  }).success,
  false,
);
assert.equal(
  batch.inputSchema.safeParse({
    runId,
    claimToken,
    requestId: randomUUID(),
    observations: [],
    unavailable: [
      {
        taskId: "task-1",
        hostId: "local",
        checkpointVersion: 0,
        reason: "read_failed",
        rawError: "must not cross",
      },
    ],
  }).success,
  false,
);
assert.equal(
  batch.inputSchema.safeParse({
    runId,
    claimToken,
    requestId: randomUUID(),
    observations: [],
    unavailable: [],
  }).success,
  false,
);
const requestId = randomUUID();
const batched = await execute(batch, {
  runId,
  claimToken,
  requestId,
  observations: [observation],
  unavailable: [],
});
assert.equal(batched.acceptedTasks, 1);
assert.equal(batched.summary.processedTasks, 1);

const completionRequestId = randomUUID();
const completed = await execute(complete, { runId, claimToken, requestId: completionRequestId });
assert.equal(completed.summary.state, "partial");
assert.equal(completed.summary.updatedItems, 1);
assert.equal(completed.summary.incompleteMetadataTasks, 1);
assert.equal("outcome" in observation.task, false);
assert.equal("taskId" in completed.summary, false);
assert.equal("outcome" in completed.summary, false);
assert.equal(
  complete.inputSchema.safeParse({ runId, claimToken, requestId: completionRequestId, counts: {} })
    .success,
  false,
);

assert.deepEqual(calls, [
  ["begin", viewToken, { kind: "dashboard" }],
  ["delivered", viewToken, runId],
  ["status", viewToken, runId],
  ["claim", runId],
  ["batch", runId, claimToken, { requestId, observations: [observation], unavailable: [] }],
  ["complete", runId, claimToken, { requestId: completionRequestId }],
]);

globalThis.process.stdout.write(
  JSON.stringify({
    appPrivate: true,
    exactScope: true,
    boundedControllerActions: true,
    privateCapabilities: true,
    cancellationBoundary: true,
    transcriptRejected: true,
    rawErrorsRejected: true,
    missingOutcomeIsPublicCountOnly: true,
  }),
);

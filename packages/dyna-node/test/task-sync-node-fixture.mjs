import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdout } from "node:process";
import { DatabaseSync } from "node:sqlite";

import { loadDynaApplicationService } from "./application-service-test-bundle.mjs";

const { serviceModule, cleanup } = await loadDynaApplicationService();
const { DynaApplicationService, canonicalDynaTaskTitle } = serviceModule;

let now = Date.parse("2026-09-14T12:00:00.000Z");
const clock = () => new Date(now);
const advance = (milliseconds = 1_000) => {
  now += milliseconds;
  return new Date(now).toISOString();
};

function status(itemNumber, taskId, hostId, state, options = {}) {
  const statusUpdatedAt = options.statusUpdatedAt ?? advance();
  const observedAt = options.observedAt ?? advance();
  return {
    taskId,
    hostId,
    title: canonicalDynaTaskTitle(itemNumber, options.title ?? "Synchronize linked work"),
    state,
    statusUpdatedAt,
    observedAt,
    ...(options.outcome ? { outcome: options.outcome } : {}),
  };
}

function createTodo(service, dashboardId, title) {
  return service.createTodo(dashboardId, {
    requestId: randomUUID(),
    title,
    priority: "high",
    labels: [],
  });
}

const service = new DynaApplicationService({ databasePath: ":memory:", clock });
try {
  const dashboard = service.createDashboard("Linked task sync", "Controller pull synchronization");
  const created = createTodo(service, dashboard.id, "Validate the release");
  service.updateTask(
    dashboard.id,
    created.itemId,
    status(created.itemNumber, "task-release", "host-local", "running", {
      title: "Inspect the release pipeline",
    }),
  );
  const rendered = service.render(dashboard.id);
  const initialRevision = rendered.snapshot.revision;

  const begun = service.beginTaskSyncForView(rendered.viewToken, { kind: "dashboard" });
  assert.equal(begun.joined, false);
  assert.equal(begun.deliveryRequired, true);
  assert.equal(begun.summary.totalTasks, 1);
  const joined = service.beginTaskSyncForView(rendered.viewToken, { kind: "dashboard" });
  assert.equal(joined.summary.runId, begun.summary.runId);
  assert.equal(joined.joined, true);
  assert.equal(joined.deliveryRequired, false);

  advance(15_001);
  const recoveredDelivery = service.beginTaskSyncForView(rendered.viewToken, {
    kind: "dashboard",
  });
  assert.equal(recoveredDelivery.summary.runId, begun.summary.runId);
  assert.equal(recoveredDelivery.joined, true);
  assert.equal(recoveredDelivery.deliveryRequired, true);
  advance(5_000);
  service.markTaskSyncDeliveredForView(rendered.viewToken, begun.summary.runId);
  advance(11_000);
  assert.equal(
    service.beginTaskSyncForView(rendered.viewToken, { kind: "dashboard" }).deliveryRequired,
    false,
  );
  advance(4_001);
  const recoveredAfterDelivery = service.beginTaskSyncForView(rendered.viewToken, {
    kind: "dashboard",
  });
  assert.equal(recoveredAfterDelivery.deliveryRequired, true);
  service.markTaskSyncDeliveredForView(rendered.viewToken, begun.summary.runId);
  const claim = service.claimTaskSync(begun.summary.runId);
  assert.equal(claim.targets.length, 1);
  assert.equal(claim.targets[0].checkpointVersion, 0);
  assert.equal(
    claim.targets[0].expectedTitle,
    `:${created.itemNumber}: Inspect the release pipeline`,
  );
  advance(16_000);
  assert.equal(
    service.beginTaskSyncForView(rendered.viewToken, { kind: "dashboard" }).deliveryRequired,
    false,
  );

  const batchRequestId = randomUUID();
  const pulled = status(created.itemNumber, "task-release", "host-local", "running");
  const batchInput = {
    requestId: batchRequestId,
    observations: [
      {
        taskId: "task-release",
        checkpointVersion: 0,
        task: pulled,
        summaryCoverage: "available",
        nextCursor: "cursor-1",
        lastTurnId: "turn-1",
        delta: {
          kind: "progress",
          body: "Validated the release candidate and its required pipeline.",
          artifacts: [
            { kind: "pipeline", label: "Release pipeline", url: "https://example.com/pipeline/1" },
          ],
        },
      },
    ],
    unavailable: [],
  };
  const staged = service.submitTaskSyncBatch(claim.runId, claim.claimToken, batchInput);
  assert.equal(staged.acceptedTasks, 1);
  assert.equal(staged.deduplicated, false);
  assert.equal(
    service.submitTaskSyncBatch(claim.runId, claim.claimToken, batchInput).deduplicated,
    true,
  );
  const completionRequest = { requestId: randomUUID() };
  const completed = service.completeTaskSync(claim.runId, claim.claimToken, completionRequest);
  assert.equal(completed.summary.state, "updated");
  assert.equal(completed.summary.updatedItems, 1);
  assert.equal(
    service.completeTaskSync(claim.runId, claim.claimToken, completionRequest).summary.state,
    "updated",
  );
  const refreshed = service.refresh(rendered.viewToken);
  assert.equal(refreshed.snapshot.taskSync?.state, "updated");
  assert.equal(refreshed.snapshot.revision, initialRevision + 1);
  assert.equal(refreshed.snapshot.cards[0].workUpdates[0]?.kind, "progress");

  const heartbeatRun = service.beginTaskSyncForView(rendered.viewToken, { kind: "dashboard" });
  service.markTaskSyncDeliveredForView(rendered.viewToken, heartbeatRun.summary.runId);
  const heartbeatClaim = service.claimTaskSync(heartbeatRun.summary.runId);
  assert.equal(heartbeatClaim.targets[0]?.checkpointVersion, 1);
  const heartbeatObservedAt = advance();
  service.submitTaskSyncBatch(heartbeatClaim.runId, heartbeatClaim.claimToken, {
    requestId: randomUUID(),
    observations: [
      {
        taskId: "task-release",
        checkpointVersion: 1,
        task: { ...pulled, observedAt: heartbeatObservedAt },
        summaryCoverage: "available",
        nextCursor: "cursor-heartbeat",
        lastTurnId: "turn-progress-final",
      },
    ],
    unavailable: [],
  });
  const heartbeatResult = service.completeTaskSync(
    heartbeatClaim.runId,
    heartbeatClaim.claimToken,
    { requestId: randomUUID() },
  );
  assert.equal(heartbeatResult.summary.state, "current");
  assert.equal(heartbeatResult.summary.updatedItems, 0);
  const heartbeatSnapshot = service.snapshot(dashboard.id);
  assert.equal(heartbeatSnapshot.revision, refreshed.snapshot.revision);
  assert.equal(heartbeatSnapshot.cards[0]?.linkedTasks[0]?.observedAt, heartbeatObservedAt);

  const second = service.beginTaskSyncForView(rendered.viewToken, { kind: "dashboard" });
  service.markTaskSyncDeliveredForView(rendered.viewToken, second.summary.runId);
  const secondClaim = service.claimTaskSync(second.summary.runId);
  const secondTarget = secondClaim.targets.find((target) => target.taskId === "task-release");
  assert.equal(secondTarget?.checkpointVersion, 2);
  assert.equal(secondTarget?.afterCursor, "cursor-heartbeat");
  const succeeded = status(created.itemNumber, "task-release", "host-local", "succeeded");
  service.submitTaskSyncBatch(secondClaim.runId, secondClaim.claimToken, {
    requestId: randomUUID(),
    observations: [
      {
        taskId: "task-release",
        checkpointVersion: 2,
        task: succeeded,
        summaryCoverage: "available",
        nextCursor: "cursor-2",
        lastTurnId: "turn-progress-final",
      },
    ],
    unavailable: [],
  });
  const successWithoutOutcome = service.completeTaskSync(
    secondClaim.runId,
    secondClaim.claimToken,
    {
      requestId: randomUUID(),
    },
  );
  assert.equal(successWithoutOutcome.summary.state, "partial");
  assert.equal(successWithoutOutcome.summary.incompleteMetadataTasks, 1);
  assert.equal(successWithoutOutcome.summary.unavailableTasks, 0);
  const succeededCard = service
    .snapshot(dashboard.id)
    .cards.find((card) => card.id === created.itemId);
  assert.equal(succeededCard?.workflowState, "completed");
  assert.equal(succeededCard?.outcome, undefined);

  const handoffItem = createTodo(service, dashboard.id, "Follow a task handoff");
  service.updateTask(
    dashboard.id,
    handoffItem.itemId,
    status(handoffItem.itemNumber, "task-handoff", "host-a", "running"),
  );
  const handoffView = service.render(dashboard.id);
  const handoffRun = service.beginTaskSyncForView(handoffView.viewToken, {
    kind: "task",
    itemId: handoffItem.itemId,
    taskId: "task-handoff",
    hostId: "host-a",
  });
  service.markTaskSyncDeliveredForView(handoffView.viewToken, handoffRun.summary.runId);
  const handoffClaim = service.claimTaskSync(handoffRun.summary.runId);
  service.submitTaskSyncBatch(handoffClaim.runId, handoffClaim.claimToken, {
    requestId: randomUUID(),
    observations: [
      {
        taskId: "task-handoff",
        checkpointVersion: 0,
        task: status(handoffItem.itemNumber, "task-handoff", "host-b", "waiting"),
        summaryCoverage: "unavailable",
        nextCursor: "host-b-cursor-must-reset",
        lastTurnId: "handoff-turn",
      },
    ],
    unavailable: [],
  });
  const handoffResult = service.completeTaskSync(handoffClaim.runId, handoffClaim.claimToken, {
    requestId: randomUUID(),
  });
  assert.equal(handoffResult.summary.state, "partial");
  assert.equal(handoffResult.summary.unavailableTasks, 1);
  const handoffCard = service
    .snapshot(dashboard.id)
    .cards.find((card) => card.id === handoffItem.itemId);
  assert.equal(handoffCard?.workflowState, "paused");
  assert.equal(handoffCard?.linkedTasks[0]?.hostId, "host-b");

  const cursorDashboard = service.createDashboard(
    "Handoff checkpoint",
    "Suppress host-bound cursors after native task handoff",
  );
  const cursorItem = createTodo(service, cursorDashboard.id, "Recover after native handoff");
  const cursorStatus = status(cursorItem.itemNumber, "task-cursor", "host-before", "running");
  service.updateTask(cursorDashboard.id, cursorItem.itemId, cursorStatus);
  const cursorView = service.render(cursorDashboard.id);
  const cursorRun = service.beginTaskSyncForView(cursorView.viewToken, { kind: "dashboard" });
  service.markTaskSyncDeliveredForView(cursorView.viewToken, cursorRun.summary.runId);
  const cursorClaim = service.claimTaskSync(cursorRun.summary.runId);
  service.submitTaskSyncBatch(cursorClaim.runId, cursorClaim.claimToken, {
    requestId: randomUUID(),
    observations: [
      {
        taskId: "task-cursor",
        checkpointVersion: 0,
        task: cursorStatus,
        summaryCoverage: "available",
        nextCursor: "cursor-bound-to-old-host",
        lastTurnId: "turn-survives-handoff",
      },
    ],
    unavailable: [],
  });
  service.completeTaskSync(cursorClaim.runId, cursorClaim.claimToken, {
    requestId: randomUUID(),
  });
  service.updateTask(cursorDashboard.id, cursorItem.itemId, {
    ...cursorStatus,
    hostId: "host-after",
    observedAt: advance(),
  });
  const cursorAfterHandoffView = service.render(cursorDashboard.id);
  const cursorAfterHandoff = service.beginTaskSyncForView(cursorAfterHandoffView.viewToken, {
    kind: "task",
    itemId: cursorItem.itemId,
    taskId: "task-cursor",
    hostId: "host-after",
  });
  service.markTaskSyncDeliveredForView(
    cursorAfterHandoffView.viewToken,
    cursorAfterHandoff.summary.runId,
  );
  const cursorAfterHandoffClaim = service.claimTaskSync(cursorAfterHandoff.summary.runId);
  assert.equal(cursorAfterHandoffClaim.targets[0]?.afterCursor, undefined);
  assert.equal(cursorAfterHandoffClaim.targets[0]?.lastTurnId, "turn-survives-handoff");
  service.submitTaskSyncBatch(cursorAfterHandoffClaim.runId, cursorAfterHandoffClaim.claimToken, {
    requestId: randomUUID(),
    observations: [
      {
        taskId: "task-cursor",
        checkpointVersion: 1,
        task: {
          ...cursorStatus,
          hostId: "host-after",
          observedAt: advance(),
        },
        summaryCoverage: "available",
        nextCursor: "cursor-bound-to-new-host-before-reset",
        lastTurnId: "turn-after-handoff",
      },
    ],
    unavailable: [],
  });
  service.completeTaskSync(cursorAfterHandoffClaim.runId, cursorAfterHandoffClaim.claimToken, {
    requestId: randomUUID(),
  });
  const establishCursorView = service.render(cursorDashboard.id);
  const establishCursorRun = service.beginTaskSyncForView(establishCursorView.viewToken, {
    kind: "dashboard",
  });
  service.markTaskSyncDeliveredForView(
    establishCursorView.viewToken,
    establishCursorRun.summary.runId,
  );
  const establishCursorClaim = service.claimTaskSync(establishCursorRun.summary.runId);
  assert.equal(establishCursorClaim.targets[0]?.checkpointVersion, 2);
  assert.equal(establishCursorClaim.targets[0]?.afterCursor, undefined);
  service.submitTaskSyncBatch(establishCursorClaim.runId, establishCursorClaim.claimToken, {
    requestId: randomUUID(),
    observations: [
      {
        taskId: "task-cursor",
        checkpointVersion: 2,
        task: {
          ...cursorStatus,
          hostId: "host-after",
          observedAt: advance(),
        },
        summaryCoverage: "available",
        nextCursor: "cursor-valid-after-handoff",
        lastTurnId: "turn-after-handoff-2",
      },
    ],
    unavailable: [],
  });
  service.completeTaskSync(establishCursorClaim.runId, establishCursorClaim.claimToken, {
    requestId: randomUUID(),
  });
  const invalidCursorView = service.render(cursorDashboard.id);
  const invalidCursorRun = service.beginTaskSyncForView(invalidCursorView.viewToken, {
    kind: "dashboard",
  });
  service.markTaskSyncDeliveredForView(invalidCursorView.viewToken, invalidCursorRun.summary.runId);
  const invalidCursorClaim = service.claimTaskSync(invalidCursorRun.summary.runId);
  assert.equal(invalidCursorClaim.targets[0]?.checkpointVersion, 3);
  assert.equal(invalidCursorClaim.targets[0]?.afterCursor, "cursor-valid-after-handoff");
  service.submitTaskSyncBatch(invalidCursorClaim.runId, invalidCursorClaim.claimToken, {
    requestId: randomUUID(),
    observations: [],
    unavailable: [
      {
        taskId: "task-cursor",
        hostId: "host-after",
        checkpointVersion: 3,
        reason: "cursor_invalid",
      },
    ],
  });
  service.completeTaskSync(invalidCursorClaim.runId, invalidCursorClaim.claimToken, {
    requestId: randomUUID(),
  });
  const recoveredCursorView = service.render(cursorDashboard.id);
  const recoveredCursorRun = service.beginTaskSyncForView(recoveredCursorView.viewToken, {
    kind: "dashboard",
  });
  service.markTaskSyncDeliveredForView(
    recoveredCursorView.viewToken,
    recoveredCursorRun.summary.runId,
  );
  const recoveredCursorClaim = service.claimTaskSync(recoveredCursorRun.summary.runId);
  assert.equal(recoveredCursorClaim.targets[0]?.checkpointVersion, 3);
  assert.equal(recoveredCursorClaim.targets[0]?.afterCursor, undefined);
  assert.equal(recoveredCursorClaim.targets[0]?.lastTurnId, "turn-after-handoff-2");

  const leaseItem = createTodo(service, dashboard.id, "Preserve status on unavailable reads");
  service.updateTask(
    dashboard.id,
    leaseItem.itemId,
    status(leaseItem.itemNumber, "task-lease", "host-local", "running"),
  );
  const leaseView = service.render(dashboard.id);
  const leaseRun = service.beginTaskSyncForView(leaseView.viewToken, {
    kind: "task",
    itemId: leaseItem.itemId,
    taskId: "task-lease",
    hostId: "host-local",
  });
  service.markTaskSyncDeliveredForView(leaseView.viewToken, leaseRun.summary.runId);
  const expiredClaim = service.claimTaskSync(leaseRun.summary.runId);
  advance(5 * 60 * 1_000 + 1);
  const redelivery = service.beginTaskSyncForView(leaseView.viewToken, {
    kind: "task",
    itemId: leaseItem.itemId,
    taskId: "task-lease",
    hostId: "host-local",
  });
  assert.equal(redelivery.joined, true);
  assert.equal(redelivery.deliveryRequired, true);
  assert.equal(
    service.beginTaskSyncForView(leaseView.viewToken, {
      kind: "task",
      itemId: leaseItem.itemId,
      taskId: "task-lease",
      hostId: "host-local",
    }).deliveryRequired,
    false,
  );
  service.markTaskSyncDeliveredForView(leaseView.viewToken, leaseRun.summary.runId);
  const reclaimed = service.claimTaskSync(leaseRun.summary.runId);
  assert.notEqual(reclaimed.claimToken, expiredClaim.claimToken);
  const unavailableRequestId = randomUUID();
  const unavailableInput = {
    requestId: unavailableRequestId,
    observations: [],
    unavailable: [
      {
        taskId: "task-lease",
        hostId: "host-local",
        checkpointVersion: 0,
        reason: "read_failed",
      },
    ],
  };
  assert.throws(
    () =>
      service.submitTaskSyncBatch(expiredClaim.runId, expiredClaim.claimToken, unavailableInput),
    (error) => error?.code === "request_conflict",
  );
  service.submitTaskSyncBatch(reclaimed.runId, reclaimed.claimToken, unavailableInput);
  assert.throws(
    () =>
      service.submitTaskSyncBatch(reclaimed.runId, reclaimed.claimToken, {
        ...unavailableInput,
        unavailable: [{ ...unavailableInput.unavailable[0], reason: "host_unavailable" }],
      }),
    (error) => error?.code === "request_conflict",
  );
  const unavailableResult = service.completeTaskSync(reclaimed.runId, reclaimed.claimToken, {
    requestId: randomUUID(),
  });
  assert.equal(unavailableResult.summary.state, "partial");
  assert.equal(
    service.snapshot(dashboard.id).cards.find((card) => card.id === leaseItem.itemId)
      ?.linkedTasks[0]?.state,
    "running",
  );

  const conditionItem = createTodo(service, dashboard.id, "Project normalized work conditions");
  service.updateTask(
    dashboard.id,
    conditionItem.itemId,
    status(conditionItem.itemNumber, "task-condition", "host-local", "running"),
  );
  async function synchronizeCondition(kind, body, outcome) {
    const view = service.render(dashboard.id);
    const begunCondition = service.beginTaskSyncForView(view.viewToken, {
      kind: "task",
      itemId: conditionItem.itemId,
      taskId: "task-condition",
      hostId: "host-local",
    });
    service.markTaskSyncDeliveredForView(view.viewToken, begunCondition.summary.runId);
    const conditionClaim = service.claimTaskSync(begunCondition.summary.runId);
    const target = conditionClaim.targets[0];
    service.submitTaskSyncBatch(conditionClaim.runId, conditionClaim.claimToken, {
      requestId: randomUUID(),
      observations: [
        {
          taskId: "task-condition",
          checkpointVersion: target.checkpointVersion,
          task: status(conditionItem.itemNumber, "task-condition", "host-local", "running"),
          summaryCoverage: "available",
          delta: {
            kind,
            body,
            ...(outcome ? { outcome } : {}),
            artifacts: [],
          },
        },
      ],
      unavailable: [],
    });
    service.completeTaskSync(conditionClaim.runId, conditionClaim.claimToken, {
      requestId: randomUUID(),
    });
    return service.snapshot(dashboard.id).cards.find((card) => card.id === conditionItem.itemId);
  }
  const blockedCard = await synchronizeCondition("blocked", "Pipeline access is blocked.");
  assert.equal(blockedCard?.blocked, true);
  assert.equal(blockedCard?.workflowState, "executing");
  const inputCard = await synchronizeCondition("needs_input", "Choose the rollback strategy.");
  assert.equal(inputCard?.workflowState, "paused");
  const reportedCard = await synchronizeCondition(
    "completion_reported",
    "Implementation is reported complete.",
    "Implemented the bounded synchronization path.",
  );
  assert.equal(reportedCard?.workflowState, "executing");
  assert.equal(reportedCard?.workState, "completion_reported");

  const archivedItem = createTodo(service, dashboard.id, "Archive during synchronization");
  service.updateTask(
    dashboard.id,
    archivedItem.itemId,
    status(archivedItem.itemNumber, "task-archive", "host-local", "running"),
  );
  const archiveView = service.render(dashboard.id);
  const archiveRun = service.beginTaskSyncForView(archiveView.viewToken, {
    kind: "task",
    itemId: archivedItem.itemId,
    taskId: "task-archive",
    hostId: "host-local",
  });
  service.markTaskSyncDeliveredForView(archiveView.viewToken, archiveRun.summary.runId);
  const archiveClaim = service.claimTaskSync(archiveRun.summary.runId);
  service.submitTaskSyncBatch(archiveClaim.runId, archiveClaim.claimToken, {
    requestId: randomUUID(),
    observations: [
      {
        taskId: "task-archive",
        checkpointVersion: 0,
        task: status(archivedItem.itemNumber, "task-archive", "host-local", "waiting"),
        summaryCoverage: "unavailable",
      },
    ],
    unavailable: [],
  });
  const beforeArchive = service.snapshot(dashboard.id);
  const archiveCard = beforeArchive.cards.find((card) => card.id === archivedItem.itemId);
  service.archiveItem(
    dashboard.id,
    archivedItem.itemId,
    beforeArchive.revision,
    archiveCard.fingerprint,
    {
      requestId: randomUUID(),
      reason: "no_action_needed",
    },
  );
  const archivedCompletion = service.completeTaskSync(archiveClaim.runId, archiveClaim.claimToken, {
    requestId: randomUUID(),
  });
  assert.equal(archivedCompletion.summary.state, "partial");
  assert.equal(archivedCompletion.summary.unavailableTasks, 1);
  assert.equal(
    service.snapshot(dashboard.id, "", "archive").cards[0]?.linkedTasks[0]?.state,
    "running",
  );

  const sharedDashboardA = service.createDashboard(
    "Shared sync A",
    "First dashboard observing a shared item",
  );
  const sharedDashboardB = service.createDashboard(
    "Shared sync B",
    "Second dashboard observing a shared item",
  );
  const { publisher: sharedPublisher, secret: sharedSecret } = service.createPublisher(
    "Shared sync source",
    undefined,
    undefined,
    "local_preview",
  );
  for (const sharedDashboard of [sharedDashboardA, sharedDashboardB]) {
    service.bindSchedule(sharedDashboard.id, sharedPublisher.id, {
      id: "shared-sync-schedule",
      title: "Shared task synchronization",
      state: "active",
      staleAfterMinutes: 60,
    });
  }
  service.publish(
    sharedPublisher.id,
    sharedSecret,
    [
      {
        externalId: "shared-sync-item",
        sourceRef: {
          source: "gitlab",
          instanceId: "gitlab.example.com",
          projectPath: "team/service",
          iid: 184,
          entityType: "merge_request",
        },
        sourceScope: "team/service",
        title: "Reconcile shared task",
        summary: "One task is represented on two dashboards.",
        priority: "high",
        priorityReason: "Direct request",
        sourceUpdatedAt: advance(),
        labels: [],
      },
    ],
    {
      runId: "shared-sync-run",
      sourceCompletedAt: advance(),
      mode: "replace",
      status: "succeeded",
    },
  );
  const sharedCard = service.snapshot(sharedDashboardA.id).cards[0];
  assert.ok(sharedCard);
  service.updateTask(
    sharedDashboardA.id,
    sharedCard.id,
    status(sharedCard.itemNumber, "task-shared", "host-shared", "running"),
  );

  function beginSharedSync(dashboardId) {
    const view = service.render(dashboardId);
    const begunShared = service.beginTaskSyncForView(view.viewToken, { kind: "dashboard" });
    service.markTaskSyncDeliveredForView(view.viewToken, begunShared.summary.runId);
    return service.claimTaskSync(begunShared.summary.runId);
  }

  const sharedClaimA = beginSharedSync(sharedDashboardA.id);
  const sharedClaimB = beginSharedSync(sharedDashboardB.id);
  const identicalObservation = {
    taskId: "task-shared",
    checkpointVersion: 0,
    task: status(sharedCard.itemNumber, "task-shared", "host-shared", "running"),
    summaryCoverage: "available",
    nextCursor: "shared-cursor-1",
    lastTurnId: "shared-turn-1",
    delta: {
      kind: "progress",
      body: "Reviewed the shared release evidence.",
      artifacts: [],
    },
  };
  service.submitTaskSyncBatch(sharedClaimA.runId, sharedClaimA.claimToken, {
    requestId: randomUUID(),
    observations: [identicalObservation],
    unavailable: [],
  });
  service.submitTaskSyncBatch(sharedClaimB.runId, sharedClaimB.claimToken, {
    requestId: randomUUID(),
    observations: [
      {
        ...identicalObservation,
        task: {
          ...identicalObservation.task,
          title: canonicalDynaTaskTitle(
            sharedCard.itemNumber,
            "Reworded native title for the same turn",
          ),
        },
        delta: {
          ...identicalObservation.delta,
          body: "Paraphrased text for the same native task turn.",
        },
      },
    ],
    unavailable: [],
  });
  assert.equal(
    service.completeTaskSync(sharedClaimA.runId, sharedClaimA.claimToken, {
      requestId: randomUUID(),
    }).summary.state,
    "updated",
  );
  assert.equal(
    service.completeTaskSync(sharedClaimB.runId, sharedClaimB.claimToken, {
      requestId: randomUUID(),
    }).summary.state,
    "partial",
  );
  assert.equal(
    service
      .showItem(sharedDashboardA.id, sharedCard.id)
      .item.workUpdates.filter((update) => update.task?.taskId === "task-shared").length,
    1,
  );

  const staleClaimA = beginSharedSync(sharedDashboardA.id);
  const staleClaimB = beginSharedSync(sharedDashboardB.id);
  assert.equal(staleClaimA.targets[0]?.checkpointVersion, 1);
  assert.equal(staleClaimB.targets[0]?.checkpointVersion, 1);
  const acceptedWaitingStatus = status(
    sharedCard.itemNumber,
    "task-shared",
    "host-shared",
    "waiting",
  );
  const rejectedStaleStatus = status(
    sharedCard.itemNumber,
    "task-shared",
    "host-shared",
    "running",
  );
  for (const [sharedClaim, task] of [
    [staleClaimA, acceptedWaitingStatus],
    [staleClaimB, rejectedStaleStatus],
  ]) {
    service.submitTaskSyncBatch(sharedClaim.runId, sharedClaim.claimToken, {
      requestId: randomUUID(),
      observations: [
        {
          taskId: "task-shared",
          checkpointVersion: 1,
          task,
          summaryCoverage: "available",
        },
      ],
      unavailable: [],
    });
  }
  service.completeTaskSync(staleClaimA.runId, staleClaimA.claimToken, {
    requestId: randomUUID(),
  });
  assert.equal(
    service.completeTaskSync(staleClaimB.runId, staleClaimB.claimToken, {
      requestId: randomUUID(),
    }).summary.state,
    "partial",
  );
  assert.equal(service.snapshot(sharedDashboardB.id).cards[0]?.linkedTasks[0]?.state, "waiting");

  const titleProjectionDashboard = service.createDashboard(
    "Task title projection",
    "Preserve native task suffixes while repairing Dyna prefixes",
  );
  const titleProjectionCases = [
    {
      taskId: "task-title-unprefixed",
      itemTitle: "Unprefixed item title",
      cachedTitle: "Preserve this unprefixed task suffix",
      expectedSuffix: "Preserve this unprefixed task suffix",
    },
    {
      taskId: "task-title-wrong-prefixes",
      itemTitle: "Wrong-prefix item title",
      cachedTitle: ":999991: :999992: Preserve this repaired task suffix",
      expectedSuffix: "Preserve this repaired task suffix",
    },
    {
      taskId: "task-title-canonical",
      itemTitle: "Canonical item title",
      cachedTitle: undefined,
      expectedSuffix: "Keep this canonical task suffix",
    },
  ];
  const expectedTitles = new Map();
  let captureStabilityItem;
  for (const titleCase of titleProjectionCases) {
    const titleItem = createTodo(service, titleProjectionDashboard.id, titleCase.itemTitle);
    const cachedTitle =
      titleCase.cachedTitle ??
      canonicalDynaTaskTitle(titleItem.itemNumber, titleCase.expectedSuffix);
    const observedAt = advance();
    service.compatibilityUpsertTaskStatus(titleItem.itemId, {
      taskId: titleCase.taskId,
      hostId: "host-title",
      title: cachedTitle,
      state: "running",
      statusUpdatedAt: observedAt,
      observedAt,
    });
    expectedTitles.set(
      titleCase.taskId,
      canonicalDynaTaskTitle(titleItem.itemNumber, titleCase.expectedSuffix),
    );
    if (titleCase.taskId === "task-title-canonical") captureStabilityItem = titleItem;
  }
  const titleProjectionView = service.render(titleProjectionDashboard.id);
  const titleProjectionRun = service.beginTaskSyncForView(titleProjectionView.viewToken, {
    kind: "dashboard",
  });
  assert.ok(captureStabilityItem);
  service.updateTask(
    titleProjectionDashboard.id,
    captureStabilityItem.itemId,
    status(captureStabilityItem.itemNumber, "task-title-canonical", "host-title", "running", {
      title: "Changed after the sync run was captured",
    }),
  );
  service.markTaskSyncDeliveredForView(
    titleProjectionView.viewToken,
    titleProjectionRun.summary.runId,
  );
  const titleProjectionClaim = service.claimTaskSync(titleProjectionRun.summary.runId);
  assert.equal(titleProjectionClaim.targets.length, titleProjectionCases.length);
  for (const target of titleProjectionClaim.targets) {
    assert.equal(target.expectedTitle, expectedTitles.get(target.taskId));
  }

  stdout.write(
    `${JSON.stringify({
      deduplicatedRun: true,
      deliveryReservationRecovery: true,
      exactBatchReplay: true,
      atomicFinalization: true,
      checkpointCursor: true,
      nativeSuccessWithoutOutcome: true,
      hostHandoff: true,
      partialCoverage: true,
      snapshotSummary: true,
      observedAtHeartbeat: true,
      leaseReclaim: true,
      conflictingReplay: true,
      unavailablePreservesStatus: true,
      workConditionProjection: true,
      archiveRace: true,
      crossDashboardReceiptAndStaleness: true,
      outOfBandHandoffCursorReset: true,
      invalidCursorRecovery: true,
      incompleteOutcomeMetadata: true,
      stableEventIdentity: true,
      taskTitlePrefixProjection: true,
      failClosedV9Ledger: true,
    })}\n`,
  );
} finally {
  service.close();
  cleanup();
}

const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-v8-sync-"));
const databasePath = join(directory, "dyna.sqlite3");
let migrationService;
try {
  migrationService = new DynaApplicationService({ databasePath, clock });
  const dashboard = migrationService.createDashboard("Migration", "Version eight checkpoint seed");
  const item = createTodo(migrationService, dashboard.id, "Existing linked task");
  migrationService.updateTask(
    dashboard.id,
    item.itemId,
    status(item.itemNumber, "legacy-task", "legacy-host", "running"),
  );
  migrationService.close();
  migrationService = undefined;
  const versionEight = new DatabaseSync(databasePath);
  versionEight.exec(`
    DROP TABLE task_sync_receipts;
    DROP TABLE task_sync_targets;
    DROP TABLE task_sync_runs;
    DROP TABLE task_sync_checkpoints;
    PRAGMA user_version = 8;
  `);
  versionEight.close();
  migrationService = new DynaApplicationService({ databasePath, clock });
  migrationService.close();
  migrationService = undefined;
  const verified = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(verified.prepare("PRAGMA user_version").get().user_version, 10);
  assert.deepEqual(
    {
      ...verified
        .prepare(
          "SELECT task_id, host_id, version, cursor, last_turn_id FROM task_sync_checkpoints",
        )
        .get(),
    },
    {
      task_id: "legacy-task",
      host_id: "legacy-host",
      version: 0,
      cursor: null,
      last_turn_id: null,
    },
  );
  assert.equal(
    verified
      .prepare(
        "SELECT COUNT(*) AS total FROM pragma_table_info('task_sync_runs') WHERE name = 'incomplete_metadata_tasks'",
      )
      .get().total,
    1,
  );
  verified.close();

  const missingLedgerPath = join(directory, "missing-task-sync-ledger.sqlite3");
  copyFileSync(databasePath, missingLedgerPath);
  const missingLedger = new DatabaseSync(missingLedgerPath);
  missingLedger.exec("DROP TABLE task_sync_receipts");
  missingLedger.close();
  assert.throws(
    () => new DynaApplicationService({ databasePath: missingLedgerPath, clock }),
    /task-synchronization ledger task_sync_receipts is missing/u,
  );
  const missingLedgerCheck = new DatabaseSync(missingLedgerPath, { readOnly: true });
  assert.equal(
    missingLedgerCheck
      .prepare(
        "SELECT COUNT(*) AS total FROM sqlite_schema WHERE type = 'table' AND name = 'task_sync_receipts'",
      )
      .get().total,
    0,
  );
  missingLedgerCheck.close();

  const malformedLedgerPath = join(directory, "malformed-task-sync-ledger.sqlite3");
  copyFileSync(databasePath, malformedLedgerPath);
  const malformedLedger = new DatabaseSync(malformedLedgerPath);
  malformedLedger.exec(`
    DROP TABLE task_sync_receipts;
    CREATE TABLE task_sync_receipts (
      id TEXT,
      run_id TEXT,
      kind TEXT,
      task_id TEXT,
      request_hash TEXT,
      result_json TEXT,
      created_at TEXT
    );
    CREATE UNIQUE INDEX idx_dyna_task_sync_observation_receipt
      ON task_sync_receipts(task_id, request_hash)
      WHERE kind = 'observation' AND task_id IS NOT NULL;
  `);
  malformedLedger.close();
  assert.throws(
    () => new DynaApplicationService({ databasePath: malformedLedgerPath, clock }),
    /task-synchronization ledger task_sync_receipts is invalid/u,
  );

  const nonUniqueIndexPath = join(directory, "non-unique-task-sync-index.sqlite3");
  copyFileSync(databasePath, nonUniqueIndexPath);
  const nonUniqueIndex = new DatabaseSync(nonUniqueIndexPath);
  nonUniqueIndex.exec(`
    DROP INDEX idx_dyna_active_task_sync_run;
    CREATE INDEX idx_dyna_active_task_sync_run
      ON task_sync_runs(dashboard_id)
      WHERE state IN ('prepared', 'delivered', 'claimed', 'syncing');
  `);
  nonUniqueIndex.close();
  assert.throws(
    () => new DynaApplicationService({ databasePath: nonUniqueIndexPath, clock }),
    /task-synchronization ledger index idx_dyna_active_task_sync_run is invalid/u,
  );
} finally {
  migrationService?.close();
  rmSync(directory, { recursive: true, force: true });
}

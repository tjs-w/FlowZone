import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { loadDynaApplicationService } from "./application-service-test-bundle.mjs";

const { serviceModule, cleanup } = await loadDynaApplicationService();
const { DynaApplicationService, DynaCliStoreError, canonicalDynaTaskTitle } = serviceModule;

let now = Date.parse("2026-09-13T12:00:00.000Z");
const service = new DynaApplicationService({
  databasePath: ":memory:",
  clock: () => new Date(now),
});

function createTodo(dashboardId, title, priority, requestId = randomUUID()) {
  now += 1_000;
  return service.createTodo(dashboardId, {
    requestId,
    title,
    priority,
    labels: [],
  });
}

try {
  const dashboard = service.createDashboard("Application boundary", "Atomic CLI operations");
  const todoRequestId = randomUUID();
  const firstTodo = createTodo(dashboard.id, "Retry-safe to-do", "normal", todoRequestId);
  const firstTodoRetry = service.createTodo(dashboard.id, {
    requestId: todoRequestId,
    title: "Retry-safe to-do",
    priority: "normal",
    labels: [],
  });
  assert.equal(firstTodoRetry.itemId, firstTodo.itemId);
  assert.equal(firstTodoRetry.fingerprint, firstTodo.fingerprint);
  assert.equal(firstTodoRetry.deduplicated, true);

  const normalOne = createTodo(dashboard.id, "Normal one", "normal");
  createTodo(dashboard.id, "Normal two", "normal");
  createTodo(dashboard.id, "Normal three", "normal");
  const highOne = createTodo(dashboard.id, "High one", "high");
  createTodo(dashboard.id, "High two", "high");

  const before = service.snapshot(dashboard.id);
  const normalCards = before.cards.filter(
    (card) => card.priority === "normal" && card.workflowState !== "completed",
  );
  const highCards = before.cards.filter(
    (card) => card.priority === "high" && card.workflowState !== "completed",
  );
  const selectedNormal = normalCards.find((card) => card.id === normalOne.itemId) ?? normalCards[0];
  const selectedHigh = highCards.find((card) => card.id === highOne.itemId) ?? highCards[0];
  assert.ok(selectedNormal);
  assert.ok(selectedHigh);
  const placeRequestId = randomUUID();
  const placeInput = {
    requestId: placeRequestId,
    targetPriority: "normal",
    items: [
      { itemId: selectedNormal.id, expectedFingerprint: selectedNormal.fingerprint },
      { itemId: selectedHigh.id, expectedFingerprint: selectedHigh.fingerprint },
    ],
  };
  const placed = service.placeMany(dashboard.id, before.revision, placeInput);
  assert.equal(placed.changed, true);
  assert.equal(placed.changedCount, 2);

  const after = service.snapshot(dashboard.id);
  const normalIds = after.cards
    .filter((card) => card.priority === "normal" && card.workflowState !== "completed")
    .map((card) => card.id);
  assert.deepEqual(normalIds.slice(-2), [selectedHigh.id, selectedNormal.id]);
  const replay = service.placeMany(dashboard.id, before.revision, {
    ...placeInput,
    items: [...placeInput.items].reverse(),
  });
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.changedCount, 2);

  assert.throws(
    () =>
      service.placeMany(dashboard.id, after.revision, {
        requestId: randomUUID(),
        targetPriority: "low",
        items: [
          { itemId: selectedHigh.id, expectedFingerprint: "0".repeat(64) },
          { itemId: selectedNormal.id, expectedFingerprint: selectedNormal.fingerprint },
        ],
      }),
    (error) => error instanceof DynaCliStoreError && error.code === "stale_item",
  );
  assert.equal(service.snapshot(dashboard.id).revision, after.revision);

  const orderingDashboard = service.createDashboard("Queue ordering", "Stable application order");
  const firstHigh = createTodo(orderingDashboard.id, "High A", "high");
  const secondHigh = createTodo(orderingDashboard.id, "High B", "high");
  const critical = createTodo(orderingDashboard.id, "Critical", "critical");
  const [lexicalFirst, lexicalLast] = [firstHigh, secondHigh].sort((left, right) =>
    left.itemId.localeCompare(right.itemId),
  );
  let orderingSnapshot = service.snapshot(orderingDashboard.id);
  service.placeItem(
    orderingDashboard.id,
    lexicalLast.itemId,
    orderingSnapshot.revision,
    lexicalLast.fingerprint,
    {
      requestId: randomUUID(),
      targetPriority: "high",
      beforeItemId: lexicalFirst.itemId,
    },
  );
  orderingSnapshot = service.snapshot(orderingDashboard.id);
  service.placeItem(
    orderingDashboard.id,
    critical.itemId,
    orderingSnapshot.revision,
    critical.fingerprint,
    { requestId: randomUUID(), targetPriority: "high" },
  );
  orderingSnapshot = service.snapshot(orderingDashboard.id);
  service.placeItem(
    orderingDashboard.id,
    critical.itemId,
    orderingSnapshot.revision,
    critical.fingerprint,
    { requestId: randomUUID(), targetPriority: "critical" },
  );
  const preservedHighOrder = service
    .snapshot(orderingDashboard.id)
    .cards.filter((card) => card.priority === "high")
    .map((card) => card.id);
  assert.deepEqual(preservedHighOrder, [lexicalLast.itemId, lexicalFirst.itemId]);

  const projectedTodo = createTodo(dashboard.id, "Live projected work", "normal");
  const taskObservedAt = new Date(now).toISOString();
  service.updateTask(dashboard.id, projectedTodo.itemId, {
    taskId: "projection-task",
    hostId: "local",
    title: canonicalDynaTaskTitle(projectedTodo.itemNumber, "Live projection task"),
    state: "running",
    statusUpdatedAt: taskObservedAt,
    observedAt: taskObservedAt,
  });
  const workAttemptId = randomUUID();
  now += 1_000;
  service.recordWorkUpdate(dashboard.id, projectedTodo.itemId, projectedTodo.fingerprint, {
    requestId: randomUUID(),
    workAttemptId,
    kind: "blocked",
    body: "Pipeline is unavailable.",
    artifacts: [],
    task: { taskId: "projection-task", hostId: "local" },
  });
  const blocked = service
    .snapshot(dashboard.id)
    .cards.find((card) => card.id === projectedTodo.itemId);
  assert.equal(blocked?.workflowState, "executing");
  assert.equal(blocked?.blocked, true);
  assert.equal(blocked?.workState, "blocked");
  now += 1_000;
  service.recordWorkUpdate(dashboard.id, projectedTodo.itemId, projectedTodo.fingerprint, {
    requestId: randomUUID(),
    workAttemptId,
    kind: "progress",
    body: "Pipeline recovered.",
    artifacts: [],
    task: { taskId: "projection-task", hostId: "local" },
  });
  const recovered = service
    .snapshot(dashboard.id)
    .cards.find((card) => card.id === projectedTodo.itemId);
  assert.equal(recovered?.workflowState, "executing");
  assert.equal(recovered?.blocked, false);
  assert.equal(recovered?.workState, "progress");

  const retentionDashboard = service.createDashboard("Retention projection", "", 1);
  const retained = createTodo(retentionDashboard.id, "Recently completed", "high");
  const completedAt = new Date(now).toISOString();
  service.updateTask(retentionDashboard.id, retained.itemId, {
    taskId: "completed-task",
    hostId: "local",
    title: canonicalDynaTaskTitle(retained.itemNumber, "Completed projection task"),
    state: "succeeded",
    statusUpdatedAt: completedAt,
    observedAt: completedAt,
    outcome: "Projection completed.",
  });
  assert.equal(service.snapshot(retentionDashboard.id).cards[0]?.workflowState, "completed");
  now += 2 * 60 * 60 * 1_000;
  assert.equal(service.snapshot(retentionDashboard.id).cards.length, 0);
  const retainedArchive = service.snapshot(retentionDashboard.id, "", "archive");
  assert.equal(retainedArchive.cards[0]?.archive?.mode, "automatic");
  assert.equal(retainedArchive.cards[0]?.outcome, "Projection completed.");
  assert.equal(
    service.showItem(retentionDashboard.id, retained.itemId).item.archive?.mode,
    "automatic",
  );

  const canonical = canonicalDynaTaskTitle(
    projectedTodo.itemNumber,
    `\u202e:${String(projectedTodo.itemNumber)}: Existing :999: \u2066 task`,
  );
  assert.equal(canonical, `:${String(projectedTodo.itemNumber)}: Existing :999: task`);
  assert.equal(canonicalDynaTaskTitle(projectedTodo.itemNumber, canonical), canonical);
  assert.equal(canonical.startsWith(`:${String(projectedTodo.itemNumber)}: `), true);
  assert.equal(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(canonical), false);
  assert.equal(
    canonicalDynaTaskTitle(projectedTodo.itemNumber, ":999991: :999992: Existing task suffix"),
    `:${String(projectedTodo.itemNumber)}: Existing task suffix`,
  );
  const longCanonical = canonicalDynaTaskTitle(projectedTodo.itemNumber, "🧭".repeat(300));
  assert.equal(Array.from(longCanonical).length, 200);

  const associationItem = createTodo(orderingDashboard.id, "Association owner", "normal");
  const otherAssociationItem = createTodo(orderingDashboard.id, "Association conflict", "normal");
  const associationReservationRequestId = randomUUID();
  const associationCheck = service.checkTaskAssociation(
    orderingDashboard.id,
    associationItem.itemId,
    "owned-task",
    associationReservationRequestId,
  );
  assert.equal(associationCheck.association, "attachable");
  assert.equal(associationCheck.reservationId, associationReservationRequestId);
  assert.equal(typeof associationCheck.expiresAt, "string");
  const associationObservedAt = new Date(now).toISOString();
  assert.throws(
    () =>
      service.updateTask(
        orderingDashboard.id,
        associationItem.itemId,
        {
          taskId: "owned-task",
          hostId: "local",
          title: "Missing item prefix",
          state: "running",
          statusUpdatedAt: associationObservedAt,
          observedAt: associationObservedAt,
        },
        associationReservationRequestId,
      ),
    (error) => error instanceof DynaCliStoreError && error.code === "invalid_input",
  );
  assert.throws(
    () =>
      service.updateTask(
        orderingDashboard.id,
        associationItem.itemId,
        {
          taskId: "owned-task",
          hostId: "local",
          title: `${canonicalDynaTaskTitle(associationItem.itemNumber, "Association worker")} `,
          state: "running",
          statusUpdatedAt: associationObservedAt,
          observedAt: associationObservedAt,
        },
        associationReservationRequestId,
      ),
    (error) => error instanceof DynaCliStoreError && error.code === "invalid_input",
  );
  service.updateTask(
    orderingDashboard.id,
    associationItem.itemId,
    {
      taskId: "owned-task",
      hostId: "local",
      title: canonicalDynaTaskTitle(associationItem.itemNumber, "Association worker"),
      state: "running",
      statusUpdatedAt: associationObservedAt,
      observedAt: associationObservedAt,
    },
    associationReservationRequestId,
  );
  assert.deepEqual(
    service.checkTaskAssociation(
      orderingDashboard.id,
      associationItem.itemId,
      "owned-task",
      randomUUID(),
    ),
    { association: "same_item", hostId: "local" },
  );
  assert.deepEqual(
    service.checkTaskAssociation(
      orderingDashboard.id,
      otherAssociationItem.itemId,
      "owned-task",
      randomUUID(),
    ),
    { association: "not_attachable" },
  );
  now += 1_000;
  const handedOffAt = new Date(now).toISOString();
  service.updateTask(orderingDashboard.id, associationItem.itemId, {
    taskId: "owned-task",
    hostId: "remote-host",
    title: canonicalDynaTaskTitle(associationItem.itemNumber, "Association worker"),
    state: "running",
    statusUpdatedAt: handedOffAt,
    observedAt: handedOffAt,
  });
  assert.deepEqual(
    service.checkTaskAssociation(
      orderingDashboard.id,
      associationItem.itemId,
      "owned-task",
      randomUUID(),
    ),
    { association: "same_item", hostId: "remote-host" },
  );

  now += 1_000;
  const legacyObservedAt = new Date(now).toISOString();
  service.compatibilityUpsertTaskStatus(associationItem.itemId, {
    taskId: "legacy-title-task",
    hostId: "local",
    title: "Legacy cached title",
    state: "running",
    statusUpdatedAt: legacyObservedAt,
    observedAt: legacyObservedAt,
  });
  const titleRepairRetryInput = {
    requestId: randomUUID(),
    workAttemptId: randomUUID(),
    kind: "progress",
    body: "Continue after synchronizing the linked task title.",
    artifacts: [],
    task: { taskId: "legacy-title-task", hostId: "local" },
  };
  assert.throws(
    () =>
      service.recordWorkUpdate(
        orderingDashboard.id,
        associationItem.itemId,
        associationItem.fingerprint,
        titleRepairRetryInput,
      ),
    (error) =>
      error instanceof DynaCliStoreError &&
      error.code === "invalid_input" &&
      error.message.includes(`:${String(associationItem.itemNumber)}:`) &&
      error.message.includes("retry"),
  );
  assert.equal(
    service.snapshot(orderingDashboard.id).cards.find((card) => card.id === associationItem.itemId)
      ?.titleSyncNeeded,
    true,
  );
  now += 1_000;
  const titleSyncedAt = new Date(now).toISOString();
  service.updateTask(orderingDashboard.id, associationItem.itemId, {
    taskId: "legacy-title-task",
    hostId: "local",
    title: canonicalDynaTaskTitle(associationItem.itemNumber, "Legacy cached title"),
    state: "running",
    statusUpdatedAt: titleSyncedAt,
    observedAt: titleSyncedAt,
  });
  const titleRepairRetry = service.recordWorkUpdate(
    orderingDashboard.id,
    associationItem.itemId,
    associationItem.fingerprint,
    titleRepairRetryInput,
  );
  assert.equal(titleRepairRetry.requestId, titleRepairRetryInput.requestId);
  assert.equal(titleRepairRetry.deduplicated, false);
  assert.equal(
    service.snapshot(orderingDashboard.id).cards.find((card) => card.id === associationItem.itemId)
      ?.titleSyncNeeded,
    false,
  );
  assert.throws(
    () =>
      service.updateTask(orderingDashboard.id, otherAssociationItem.itemId, {
        taskId: "owned-task",
        hostId: "remote-host",
        title: canonicalDynaTaskTitle(otherAssociationItem.itemNumber, "Association worker"),
        state: "running",
        statusUpdatedAt: handedOffAt,
        observedAt: handedOffAt,
      }),
    (error) => error instanceof DynaCliStoreError && error.code === "request_conflict",
  );

  const searchDashboard = service.createDashboard("Numeric search", "Exact number ranking");
  const exactNumberItem = createTodo(searchDashboard.id, "Target item", "normal");
  for (let index = 0; index < 25; index += 1) {
    createTodo(
      searchDashboard.id,
      `Collision ${String(index)} mentions ${String(exactNumberItem.itemNumber)}`,
      "critical",
    );
  }
  const numericSearch = service.searchItems(
    searchDashboard.id,
    String(exactNumberItem.itemNumber),
    "active",
  );
  assert.equal(numericSearch.items.length, 20);
  assert.equal(numericSearch.items[0]?.itemId, exactNumberItem.itemId);

  service.updateDashboard(dashboard.id, { archived: true });
  const archivedRetry = service.createTodo(dashboard.id, {
    requestId: todoRequestId,
    title: "Retry-safe to-do",
    priority: "normal",
    labels: [],
  });
  assert.equal(archivedRetry.itemId, firstTodo.itemId);
  assert.equal(archivedRetry.deduplicated, true);
  assert.throws(
    () =>
      service.createTodo(dashboard.id, {
        requestId: todoRequestId,
        title: "Conflicting to-do",
        priority: "normal",
        labels: [],
      }),
    (error) => error instanceof DynaCliStoreError && error.code === "request_conflict",
  );

  const receiptDirectory = mkdtempSync(join(tmpdir(), "flowzone-dyna-v1-receipt-"));
  const receiptDatabasePath = join(receiptDirectory, "dyna.sqlite3");
  let receiptService = new DynaApplicationService({ databasePath: receiptDatabasePath });
  try {
    const receiptDashboard = receiptService.createDashboard("Receipt replay", "Compatibility");
    const receiptSource = receiptService.createTodo(receiptDashboard.id, {
      requestId: randomUUID(),
      title: "Completed source",
      priority: "normal",
      labels: [],
    });
    const receiptPayload = receiptService.render(receiptDashboard.id);
    receiptService.setItemStatus({
      viewToken: receiptPayload.viewToken,
      itemId: receiptSource.itemId,
      targetStage: "done",
      outcome: "Source complete.",
      expectedRevision: receiptPayload.snapshot.revision,
      expectedFingerprint: receiptSource.fingerprint,
      clientRequestId: randomUUID(),
    });
    const completedSource = receiptService.showItem(receiptDashboard.id, receiptSource.itemId);
    const followUpRequestId = randomUUID();
    const followUpInput = {
      requestId: followUpRequestId,
      title: "Continue verified work",
      priority: "normal",
      labels: [],
    };
    const firstFollowUp = receiptService.createFollowUp(
      receiptDashboard.id,
      receiptSource.itemId,
      completedSource.revision,
      receiptSource.fingerprint,
      followUpInput,
    );
    receiptService.close();
    receiptService = undefined;

    const receiptDatabase = new DatabaseSync(receiptDatabasePath);
    receiptDatabase.prepare("UPDATE cli_requests SET result_json = ? WHERE request_id = ?").run(
      JSON.stringify({
        schema: "dyna/follow-up-create-result-v1",
        requestId: firstFollowUp.requestId,
        itemId: firstFollowUp.itemId,
        sourceItemId: firstFollowUp.sourceItemId,
        fingerprint: firstFollowUp.fingerprint,
        deduplicated: false,
      }),
      followUpRequestId,
    );
    receiptDatabase.close();

    receiptService = new DynaApplicationService({ databasePath: receiptDatabasePath });
    const replayedFollowUp = receiptService.createFollowUp(
      receiptDashboard.id,
      receiptSource.itemId,
      completedSource.revision,
      receiptSource.fingerprint,
      followUpInput,
    );
    assert.equal(replayedFollowUp.schema, "dyna/follow-up-create-result-v2");
    assert.equal(replayedFollowUp.itemNumber, firstFollowUp.itemNumber);
    assert.equal(replayedFollowUp.sourceItemNumber, receiptSource.itemNumber);
    assert.equal(replayedFollowUp.deduplicated, true);
  } finally {
    receiptService?.close();
    rmSync(receiptDirectory, { recursive: true, force: true });
  }

  let reservationClockMs = now;
  const reservationService = new DynaApplicationService({
    databasePath: ":memory:",
    clock: () => new Date(reservationClockMs),
    actor: {
      kind: "mcp_host",
      capabilities: ["dashboard:manage", "item:read", "item:write", "task:observe"],
    },
  });
  try {
    const reservationDashboard = reservationService.createDashboard(
      "Association reservations",
      "Race-safe task ownership",
    );
    const firstOwner = reservationService.createTodo(reservationDashboard.id, {
      requestId: randomUUID(),
      title: "First reservation owner",
      priority: "normal",
      labels: [],
    });
    const secondOwner = reservationService.createTodo(reservationDashboard.id, {
      requestId: randomUUID(),
      title: "Second reservation owner",
      priority: "normal",
      labels: [],
    });
    const reservationRequestId = randomUUID();
    const reserved = reservationService.checkTaskAssociation(
      reservationDashboard.id,
      firstOwner.itemId,
      "race-task",
      reservationRequestId,
    );
    assert.equal(reserved.association, "attachable");
    assert.equal(reserved.reservationId, reservationRequestId);
    assert.equal(typeof reserved.expiresAt, "string");
    assert.deepEqual(
      reservationService.checkTaskAssociation(
        reservationDashboard.id,
        firstOwner.itemId,
        "race-task",
        reservationRequestId,
      ),
      reserved,
    );
    assert.deepEqual(
      reservationService.checkTaskAssociation(
        reservationDashboard.id,
        secondOwner.itemId,
        "race-task",
        randomUUID(),
      ),
      { association: "not_attachable" },
    );
    const observedAt = new Date(now).toISOString();
    const status = {
      taskId: "race-task",
      hostId: "local",
      title: canonicalDynaTaskTitle(firstOwner.itemNumber, "Race-safe task"),
      state: "running",
      statusUpdatedAt: observedAt,
      observedAt,
    };
    assert.throws(
      () => reservationService.updateTask(reservationDashboard.id, firstOwner.itemId, status),
      (error) => error instanceof DynaCliStoreError && error.code === "request_conflict",
    );
    reservationService.updateTask(
      reservationDashboard.id,
      firstOwner.itemId,
      status,
      reservationRequestId,
    );
    assert.deepEqual(
      reservationService.checkTaskAssociation(
        reservationDashboard.id,
        secondOwner.itemId,
        "race-task",
        randomUUID(),
      ),
      { association: "not_attachable" },
    );

    const capacityOwner = reservationService.createTodo(reservationDashboard.id, {
      requestId: randomUUID(),
      title: "Expired reservation capacity",
      priority: "normal",
      labels: [],
    });
    for (let index = 0; index < 8; index += 1) {
      assert.equal(
        reservationService.checkTaskAssociation(
          reservationDashboard.id,
          capacityOwner.itemId,
          `expired-capacity-task-${String(index)}`,
          randomUUID(),
        ).association,
        "attachable",
      );
    }
    reservationClockMs += 5 * 60 * 1_000 + 1;
    assert.equal(
      reservationService.checkTaskAssociation(
        reservationDashboard.id,
        capacityOwner.itemId,
        "capacity-after-expiry",
        randomUUID(),
      ).association,
      "attachable",
    );
  } finally {
    reservationService.close();
  }

  const taskActorDirectory = mkdtempSync(join(tmpdir(), "flowzone-dyna-task-actor-"));
  const taskActorDatabasePath = join(taskActorDirectory, "dyna.sqlite3");
  const taskActorSeed = new DynaApplicationService({
    databasePath: taskActorDatabasePath,
    clock: () => new Date(now),
  });
  let taskActorWorker;
  try {
    const taskActorDashboard = taskActorSeed.createDashboard(
      "Task actor attribution",
      "Receiving-task preflight",
    );
    const taskActorItem = taskActorSeed.createTodo(taskActorDashboard.id, {
      requestId: randomUUID(),
      title: "Keep a task-authored update attributable",
      priority: "normal",
      labels: [],
    });
    const legacyUnattributedNote = {
      requestId: randomUUID(),
      workAttemptId: randomUUID(),
      kind: "note",
      body: "A durable note accepted before receiving-task attribution became mandatory.",
      artifacts: [],
    };
    assert.equal(
      taskActorSeed.recordWorkUpdate(
        taskActorDashboard.id,
        taskActorItem.itemId,
        taskActorItem.fingerprint,
        legacyUnattributedNote,
      ).deduplicated,
      false,
    );
    now += 1_000;
    const unprefixedAt = new Date(now).toISOString();
    taskActorSeed.compatibilityUpsertTaskStatus(taskActorItem.itemId, {
      taskId: "receiving-task",
      hostId: "local",
      title: "Receiving task suffix",
      state: "running",
      statusUpdatedAt: unprefixedAt,
      observedAt: unprefixedAt,
    });
    taskActorWorker = new DynaApplicationService({
      databasePath: taskActorDatabasePath,
      clock: () => new Date(now),
      actor: {
        kind: "codex_task",
        capabilities: ["dashboard:read", "item:read", "item:write"],
      },
    });
    assert.equal(
      taskActorWorker.recordWorkUpdate(
        taskActorDashboard.id,
        taskActorItem.itemId,
        taskActorItem.fingerprint,
        legacyUnattributedNote,
      ).deduplicated,
      true,
    );
    const taskActorRequest = {
      requestId: randomUUID(),
      workAttemptId: randomUUID(),
      kind: "decision",
      body: "Use the verified implementation path.",
      artifacts: [],
    };
    assert.throws(
      () =>
        taskActorWorker.recordWorkUpdate(
          taskActorDashboard.id,
          taskActorItem.itemId,
          taskActorItem.fingerprint,
          taskActorRequest,
        ),
      (error) =>
        error instanceof DynaCliStoreError &&
        error.code === "invalid_input" &&
        error.message.includes("receiving linked Codex task"),
    );
    assert.throws(
      () =>
        taskActorWorker.recordWorkUpdate(
          taskActorDashboard.id,
          taskActorItem.itemId,
          taskActorItem.fingerprint,
          {
            requestId: randomUUID(),
            workAttemptId: randomUUID(),
            kind: "note",
            body: "This note must still identify the receiving task.",
            artifacts: [],
          },
        ),
      (error) => error instanceof DynaCliStoreError && error.code === "invalid_input",
    );
    const attributedTaskActorRequest = {
      ...taskActorRequest,
      task: { taskId: "receiving-task", hostId: "local" },
    };
    assert.throws(
      () =>
        taskActorWorker.recordWorkUpdate(
          taskActorDashboard.id,
          taskActorItem.itemId,
          taskActorItem.fingerprint,
          attributedTaskActorRequest,
        ),
      (error) =>
        error instanceof DynaCliStoreError &&
        error.code === "invalid_input" &&
        error.message.includes("title is not synchronized"),
    );
    now += 1_000;
    const repairedAt = new Date(now).toISOString();
    taskActorSeed.updateTask(taskActorDashboard.id, taskActorItem.itemId, {
      taskId: "receiving-task",
      hostId: "local",
      title: canonicalDynaTaskTitle(taskActorItem.itemNumber, "Receiving task suffix"),
      state: "running",
      statusUpdatedAt: repairedAt,
      observedAt: repairedAt,
    });
    const acceptedTaskActorUpdate = taskActorWorker.recordWorkUpdate(
      taskActorDashboard.id,
      taskActorItem.itemId,
      taskActorItem.fingerprint,
      attributedTaskActorRequest,
    );
    assert.equal(acceptedTaskActorUpdate.deduplicated, false);
    assert.equal(
      taskActorWorker.recordWorkUpdate(
        taskActorDashboard.id,
        taskActorItem.itemId,
        taskActorItem.fingerprint,
        attributedTaskActorRequest,
      ).deduplicated,
      true,
    );
  } finally {
    taskActorWorker?.close();
    taskActorSeed.close();
    rmSync(taskActorDirectory, { recursive: true, force: true });
  }

  globalThis.process.stdout.write(
    JSON.stringify({
      todoReplay: true,
      archivedReplay: true,
      bulkBlock: true,
      normalizedReplay: true,
      atomicRollback: true,
      queueOrderPreserved: true,
      liveProjection: true,
      serviceRetention: true,
      canonicalTaskTitles: true,
      spoofSafeTaskTitles: true,
      exclusiveTaskOwnership: true,
      hostRouting: true,
      titleSyncProjection: true,
      numericSearchRanking: true,
      associationReservation: true,
      expiredReservationCapacity: true,
      legacyReceiptReplay: true,
    }),
  );
} finally {
  service.close();
  cleanup();
}

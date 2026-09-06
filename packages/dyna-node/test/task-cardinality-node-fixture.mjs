import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DynaStore } from "../src/store.ts";

const now = "2026-09-03T20:00:00.000Z";
let clockMs = Date.parse(now);
const legacyObservedAt = "2026-09-02T20:00:00.000Z";
const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-task-limit-"));
const databasePath = join(directory, "dyna.sqlite3");

try {
  const store = new DynaStore({ databasePath, clock: () => new Date(clockMs) });
  const dashboard = store.createDashboard("Tasks", "Task binding guard");
  const { publisher, secret } = store.createPublisher(
    "Task schedule",
    undefined,
    undefined,
    "local_preview",
  );
  store.bindSchedule(dashboard.id, publisher.id, {
    id: "task-schedule",
    title: "Task schedule",
    state: "active",
    staleAfterMinutes: 60,
  });
  store.publish(
    publisher.id,
    secret,
    [
      {
        externalId: "task-item",
        sourceRef: {
          source: "codex",
          taskId: "source-task",
        },
        sourceScope: "local",
        title: "Track linked tasks",
        summary: "The oldest legacy task must still affect workflow state.",
        priority: "normal",
        priorityReason: "Regression coverage.",
        sourceUpdatedAt: now,
        labels: [],
      },
      {
        externalId: "reconciliation-reservation-item",
        sourceRef: {
          source: "codex",
          taskId: "reconciliation-reservation-source-task",
        },
        sourceScope: "local",
        title: "Preserve reconciliation task identity",
        summary: "An uncertain external creation keeps its final binding slot until resolved.",
        priority: "high",
        priorityReason: "Reconciliation capacity regression.",
        sourceUpdatedAt: now,
        labels: [],
      },
      {
        externalId: "reservation-item",
        sourceRef: {
          source: "codex",
          taskId: "reservation-source-task",
        },
        sourceScope: "local",
        title: "Preserve reserved task identity",
        summary: "A claimed task creation owns the final available binding slot.",
        priority: "high",
        priorityReason: "Capacity interleaving regression.",
        sourceUpdatedAt: now,
        labels: [],
      },
    ],
    { runId: "task-run", sourceCompletedAt: now, mode: "replace", status: "succeeded" },
  );
  const initialSnapshot = store.snapshot(dashboard.id);
  const item = initialSnapshot.cards.find((card) => card.title === "Track linked tasks");
  const reservationItem = initialSnapshot.cards.find(
    (card) => card.title === "Preserve reserved task identity",
  );
  const reconciliationItem = initialSnapshot.cards.find(
    (card) => card.title === "Preserve reconciliation task identity",
  );
  assert.ok(item);
  assert.ok(reservationItem);
  assert.ok(reconciliationItem);

  for (let index = 0; index < 7; index += 1) {
    store.upsertTaskStatus(reservationItem.id, {
      taskId: `reservation-existing-${index}`,
      hostId: "local",
      title: `Reservation existing ${index}`,
      state: "running",
      statusUpdatedAt: now,
      observedAt: now,
    });
  }
  const reservationSnapshot = store.snapshot(dashboard.id);
  const currentReservationItem = reservationSnapshot.cards.find(
    (card) => card.id === reservationItem.id,
  );
  assert.ok(currentReservationItem);
  const reservationViewToken = store.createView(dashboard.id);
  const createRequest = store.prepareAction(reservationViewToken, "create_codex_task", {
    itemId: reservationItem.id,
    expectedRevision: reservationSnapshot.revision,
    expectedFingerprint: currentReservationItem.fingerprint,
    idempotencyKey: "reserved-eighth-task",
  });
  store.markDelivered(reservationViewToken, createRequest.id);
  const claimed = store.claimAction(createRequest.id);
  assert.equal(
    store.prepareAction(reservationViewToken, "create_codex_task", {
      itemId: reservationItem.id,
      expectedRevision: reservationSnapshot.revision,
      expectedFingerprint: currentReservationItem.fingerprint,
      idempotencyKey: "reserved-eighth-task",
    }).id,
    createRequest.id,
  );
  assert.equal(
    store.prepareAction(reservationViewToken, "create_codex_task", {
      itemId: reservationItem.id,
      expectedRevision: reservationSnapshot.revision,
      expectedFingerprint: currentReservationItem.fingerprint,
      idempotencyKey: "reserved-eighth-task-logical-retry",
    }).id,
    createRequest.id,
  );
  assert.throws(
    () =>
      store.upsertTaskStatus(reservationItem.id, {
        taskId: "competing-eighth-task",
        hostId: "local",
        title: "Competing eighth task",
        state: "running",
        statusUpdatedAt: now,
        observedAt: now,
      }),
    /cannot link more than eight Codex tasks/,
  );
  const completedCreation = store.completeAction(createRequest.id, claimed.claimToken, {
    outcome: "succeeded",
    task: {
      taskId: "externally-created-eighth-task",
      hostId: "local",
      title: "Externally created eighth task",
      state: "queued",
      statusUpdatedAt: now,
      observedAt: now,
    },
  });
  assert.equal(completedCreation.state, "succeeded");
  assert.equal(
    store.prepareAction(reservationViewToken, "create_codex_task", {
      itemId: reservationItem.id,
      expectedRevision: reservationSnapshot.revision,
      expectedFingerprint: currentReservationItem.fingerprint,
      idempotencyKey: "reserved-eighth-task",
    }).id,
    createRequest.id,
  );
  const reservedCard = store
    .snapshot(dashboard.id)
    .cards.find((card) => card.id === reservationItem.id);
  assert.ok(reservedCard);
  assert.equal(reservedCard.linkedTasks.length, 8);
  assert.equal(
    reservedCard.linkedTasks.some((task) => task.taskId === "externally-created-eighth-task"),
    true,
  );

  for (let index = 0; index < 7; index += 1) {
    store.upsertTaskStatus(reconciliationItem.id, {
      taskId: `reconciliation-existing-${index}`,
      hostId: "local",
      title: `Reconciliation existing ${index}`,
      state: "running",
      statusUpdatedAt: now,
      observedAt: now,
    });
  }
  const reconciliationSnapshot = store.snapshot(dashboard.id);
  const currentReconciliationItem = reconciliationSnapshot.cards.find(
    (card) => card.id === reconciliationItem.id,
  );
  assert.ok(currentReconciliationItem);
  const reconciliationViewToken = store.createView(dashboard.id);
  const uncertainRequest = store.prepareAction(reconciliationViewToken, "create_codex_task", {
    itemId: reconciliationItem.id,
    expectedRevision: reconciliationSnapshot.revision,
    expectedFingerprint: currentReconciliationItem.fingerprint,
    idempotencyKey: "uncertain-reserved-eighth-task",
  });
  store.markDelivered(reconciliationViewToken, uncertainRequest.id);
  store.claimAction(uncertainRequest.id);
  clockMs += 5 * 60_000 + 1;
  assert.equal(
    store.actionStatusForView(reconciliationViewToken, uncertainRequest.id).state,
    "needs_reconciliation",
  );
  const reconciliationNow = new Date(clockMs).toISOString();
  assert.throws(
    () =>
      store.upsertTaskStatus(reconciliationItem.id, {
        taskId: "competing-reconciliation-eighth-task",
        hostId: "local",
        title: "Competing reconciliation eighth task",
        state: "running",
        statusUpdatedAt: reconciliationNow,
        observedAt: reconciliationNow,
      }),
    /cannot link more than eight Codex tasks/,
  );
  assert.equal(
    store.resolveActionReconciliation(uncertainRequest.id, {
      outcome: "task_linked",
      task: {
        taskId: "reconciled-externally-created-task",
        hostId: "local",
        title: "Reconciled externally created task",
        state: "queued",
        statusUpdatedAt: reconciliationNow,
        observedAt: reconciliationNow,
      },
    }).state,
    "succeeded",
  );
  const reconciledCard = store
    .snapshot(dashboard.id)
    .cards.find((card) => card.id === reconciliationItem.id);
  assert.ok(reconciledCard);
  assert.equal(reconciledCard.linkedTasks.length, 8);
  assert.equal(
    reconciledCard.linkedTasks.some((task) => task.taskId === "reconciled-externally-created-task"),
    true,
  );

  for (let index = 0; index < 8; index += 1) {
    store.upsertTaskStatus(item.id, {
      taskId: `task-${index}`,
      hostId: "local",
      title: `Task ${index}`,
      state: "succeeded",
      outcome: `Task ${index} completed successfully.`,
      statusUpdatedAt: now,
      observedAt: now,
    });
  }
  assert.throws(
    () =>
      store.upsertTaskStatus(item.id, {
        taskId: "task-8",
        hostId: "local",
        title: "Task 8",
        state: "running",
        statusUpdatedAt: now,
        observedAt: now,
      }),
    /cannot link more than eight Codex tasks/,
  );
  const fullSnapshot = store.snapshot(dashboard.id);
  assert.equal(fullSnapshot.cards.find((card) => card.id === item.id)?.linkedTasks.length, 8);
  const viewToken = store.createView(dashboard.id);
  assert.throws(
    () =>
      store.prepareAction(viewToken, "create_codex_task", {
        itemId: item.id,
        expectedRevision: fullSnapshot.revision,
        expectedFingerprint: item.fingerprint,
        idempotencyKey: "ninth-task-action",
      }),
    /cannot link more than eight Codex tasks/,
  );
  store.close();

  const raw = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
    timeout: 5_000,
  });
  raw
    .prepare(
      `INSERT INTO task_bindings (
         item_id, task_id, host_id, project_id, title, state,
         status_updated_at, status_updated_ms, observed_at, observed_ms, outcome
       ) VALUES (?, ?, ?, NULL, ?, 'failed', ?, ?, ?, ?, NULL)`,
    )
    .run(
      item.id,
      "legacy-hidden-failure",
      "local",
      "Legacy hidden failure",
      legacyObservedAt,
      Date.parse(legacyObservedAt),
      legacyObservedAt,
      Date.parse(legacyObservedAt),
    );
  raw.close();

  const legacy = new DynaStore({ databasePath, clock: () => new Date(clockMs) });
  const legacyCard = legacy.snapshot(dashboard.id).cards.find((card) => card.id === item.id);
  assert.ok(legacyCard);
  assert.equal(legacyCard.linkedTasks.length, 8);
  assert.equal(
    legacyCard.linkedTasks.some((task) => task.state === "failed"),
    false,
  );
  assert.equal(legacyCard.workflowState, "attention");
  legacy.close();

  globalThis.process.stdout.write(
    JSON.stringify({
      maximum: 8,
      reservationPreserved: true,
      reconciliationReservationPreserved: true,
      legacyNineTaskState: "attention",
    }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

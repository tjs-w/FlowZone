import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SqliteDynaRepository } from "../src/repository.ts";

const createdAt = "2026-09-13T12:00:00.000Z";
const expiresAt = "2026-09-13T12:05:00.000Z";
const transitionedAt = "2026-09-13T12:01:00.000Z";
const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-task-reservation-"));
const databasePath = join(directory, "dyna.sqlite3");

try {
  const repository = new SqliteDynaRepository({
    databasePath,
    clock: () => new Date(createdAt),
  });
  const dashboard = repository.createDashboard(
    "Task reservation repository",
    "Repository-only reservation persistence",
  );
  const firstItem = repository.createTodoFromCli(dashboard.id, {
    requestId: randomUUID(),
    title: "First item",
    priority: "normal",
    labels: [],
  });
  const secondItem = repository.createTodoFromCli(dashboard.id, {
    requestId: randomUUID(),
    title: "Second item",
    priority: "normal",
    labels: [],
  });
  const firstRequestId = randomUUID();
  const uncertainRequestId = randomUUID();

  repository.write((unitOfWork) => {
    unitOfWork.insertTaskAssociationReservation({
      requestId: firstRequestId,
      taskId: "task-one",
      itemId: firstItem.itemId,
      state: "reserved",
      expiresAt,
      createdAt,
      updatedAt: createdAt,
    });
    unitOfWork.insertTaskAssociationReservation({
      requestId: uncertainRequestId,
      taskId: "task-two",
      itemId: firstItem.itemId,
      state: "uncertain",
      createdAt,
      updatedAt: createdAt,
    });
  });

  assert.deepEqual(
    repository.read((unitOfWork) => unitOfWork.findTaskAssociationReservation(firstRequestId)),
    {
      requestId: firstRequestId,
      taskId: "task-one",
      itemId: firstItem.itemId,
      state: "reserved",
      expiresAt,
      createdAt,
      updatedAt: createdAt,
    },
  );
  assert.equal(
    repository.read((unitOfWork) => unitOfWork.findActiveTaskAssociationReservation("task-one"))
      ?.requestId,
    firstRequestId,
  );
  assert.equal(
    repository.read((unitOfWork) =>
      unitOfWork.countActiveTaskAssociationReservationsForItem(firstItem.itemId),
    ),
    2,
  );
  assert.equal(
    repository.read((unitOfWork) =>
      unitOfWork.countActiveTaskAssociationReservationsForItem(firstItem.itemId, firstRequestId),
    ),
    1,
  );
  assert.equal(
    repository.read((unitOfWork) => unitOfWork.countTaskBindingsForItem(firstItem.itemId)),
    0,
  );

  assert.throws(
    () =>
      repository.write((unitOfWork) => {
        unitOfWork.insertTaskAssociationReservation({
          requestId: randomUUID(),
          taskId: "task-one",
          itemId: secondItem.itemId,
          state: "reserved",
          expiresAt,
          createdAt,
          updatedAt: createdAt,
        });
      }),
    /unique constraint/i,
  );

  repository.write((unitOfWork) => {
    for (let index = 3; index <= 8; index += 1) {
      unitOfWork.insertTaskAssociationReservation({
        requestId: randomUUID(),
        taskId: `task-${String(index)}`,
        itemId: firstItem.itemId,
        state: "reserved",
        expiresAt,
        createdAt,
        updatedAt: createdAt,
      });
    }
  });
  assert.equal(
    repository.read((unitOfWork) =>
      unitOfWork.countActiveTaskAssociationReservationsForItem(firstItem.itemId),
    ),
    8,
  );
  repository.write((unitOfWork) => {
    unitOfWork.persistTaskStatusForDashboard(
      dashboard.id,
      firstItem.itemId,
      {
        taskId: "task-one",
        hostId: "local",
        title: `:${String(firstItem.itemNumber)}: First task`,
        state: "running",
        statusUpdatedAt: transitionedAt,
        observedAt: transitionedAt,
      },
      undefined,
      firstRequestId,
    );
    unitOfWork.transitionTaskAssociationReservation(firstRequestId, "consumed", transitionedAt);
  });
  assert.equal(
    repository.read((unitOfWork) => unitOfWork.findActiveTaskAssociationReservation("task-one")),
    undefined,
  );
  assert.equal(
    repository.read((unitOfWork) => unitOfWork.findTaskAssociationReservation(firstRequestId))
      ?.state,
    "consumed",
  );
  assert.equal(
    repository.read((unitOfWork) => unitOfWork.findTaskAssociationReservation(firstRequestId))
      ?.updatedAt,
    transitionedAt,
  );

  assert.equal(
    repository.read((unitOfWork) => unitOfWork.countTaskBindingsForItem(firstItem.itemId)),
    1,
  );
  assert.throws(
    () =>
      repository.write((unitOfWork) => {
        unitOfWork.persistTaskStatusForDashboard(dashboard.id, firstItem.itemId, {
          taskId: "task-over-capacity",
          hostId: "local",
          title: `:${String(firstItem.itemNumber)}: Overflow task`,
          state: "running",
          statusUpdatedAt: transitionedAt,
          observedAt: transitionedAt,
        });
      }),
    /cannot link more than eight/i,
  );
  assert.throws(
    () =>
      repository.write((unitOfWork) => {
        unitOfWork.transitionTaskAssociationReservation(randomUUID(), "released", transitionedAt);
      }),
    /was not found/i,
  );
  repository.write((unitOfWork) => {
    assert.equal(unitOfWork.expireTaskAssociationReservations("2026-09-13T12:06:00.000Z"), 6);
  });
  assert.equal(
    repository.read((unitOfWork) =>
      unitOfWork.countActiveTaskAssociationReservationsForItem(firstItem.itemId),
    ),
    1,
  );
  assert.equal(
    repository.read((unitOfWork) => unitOfWork.findTaskAssociationReservation(uncertainRequestId))
      ?.state,
    "uncertain",
  );
  repository.close();

  const repair = new DatabaseSync(databasePath);
  repair.exec("DROP INDEX idx_dyna_task_reservation_expiry;");
  repair.close();
  const reopened = new SqliteDynaRepository({ databasePath });
  assert.equal(
    reopened.read((unitOfWork) => unitOfWork.findTaskAssociationReservation(uncertainRequestId))
      ?.state,
    "uncertain",
  );
  reopened.close();

  const schema = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(
    schema
      .prepare(
        "SELECT COUNT(*) AS total FROM sqlite_schema WHERE type = 'index' AND name IN ('idx_dyna_active_task_reservation', 'idx_dyna_task_reservation_expiry')",
      )
      .get().total,
    2,
  );
  schema.close();

  globalThis.process.stdout.write(
    JSON.stringify({
      requestLookup: true,
      activeLookup: true,
      ownershipExclusion: true,
      itemCapacityCounts: true,
      expiredCapacityReleased: true,
      uncertainReservationPreserved: true,
      transitionRetention: true,
      reopenPersistence: true,
      schemaIndexes: true,
    }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

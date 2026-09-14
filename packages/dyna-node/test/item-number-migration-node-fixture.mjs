import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, URL } from "node:url";

import { SqliteDynaRepository } from "../src/repository.ts";
import { DynaStore } from "../src/store.ts";

const now = "2026-09-13T12:00:00.000Z";
const later = "2026-09-13T12:00:01.000Z";
const latest = "2026-09-13T12:00:02.000Z";
const newest = "2026-09-13T12:00:03.000Z";
const afterNewest = "2026-09-13T12:00:04.000Z";
const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-item-number-migration-"));
const databasePath = join(directory, "dyna.sqlite3");
const conflictPath = join(directory, "conflicting-task.sqlite3");
const missingLedgerPath = join(directory, "missing-ledger.sqlite3");
const missingMappingPath = join(directory, "missing-mapping.sqlite3");
const repairPath = join(directory, "supplemental-repair.sqlite3");
const exhaustionPath = join(directory, "safe-integer-exhaustion.sqlite3");
const concurrentWorker = fileURLToPath(
  new URL("./item-number-concurrent-create-worker.mjs", import.meta.url),
);

function createTodoInChild(dashboardId, title) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      globalThis.process.execPath,
      [concurrentWorker, databasePath, dashboardId, randomUUID(), title],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `Concurrent item creation exited with ${String(code)}.`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}

function duplicateTaskBinding(
  database,
  taskId,
  itemId,
  hostId,
  statusUpdatedAt,
  observedAt,
  overrides = {},
) {
  const existing = database
    .prepare("SELECT * FROM task_bindings WHERE task_id = ? LIMIT 1")
    .get(taskId);
  assert.ok(existing);
  database
    .prepare(
      `INSERT INTO task_bindings (
         item_id, task_id, host_id, project_id, title, state,
         status_updated_at, status_updated_ms, observed_at, observed_ms, outcome
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      itemId,
      taskId,
      hostId,
      overrides.projectId ?? existing.project_id,
      overrides.title ?? existing.title,
      overrides.state ?? existing.state,
      statusUpdatedAt,
      Date.parse(statusUpdatedAt),
      observedAt,
      Date.parse(observedAt),
      overrides.outcome === undefined ? existing.outcome : overrides.outcome,
    );
}

function removeVersionEightObjects(database) {
  database.exec(`
    DROP TABLE IF EXISTS task_association_reservations;
    DROP TABLE IF EXISTS item_follow_ups;
    DROP TRIGGER IF EXISTS trg_dyna_item_number_allocate;
    DROP TRIGGER IF EXISTS trg_dyna_item_number_immutable_update;
    DROP TRIGGER IF EXISTS trg_dyna_item_number_immutable_delete;
    DROP INDEX IF EXISTS idx_dyna_task_bindings_task;
    DROP TABLE IF EXISTS item_numbers;
    PRAGMA user_version = 7;
  `);
}

try {
  const original = new DynaStore({ databasePath, clock: () => new Date(now) });
  const dashboard = original.createDashboard("Number migration", "Stable human item numbers");
  const { publisher, secret } = original.createPublisher(
    "Number migration publisher",
    undefined,
    undefined,
    "local_preview",
  );
  assert.ok(secret);
  original.bindSchedule(dashboard.id, publisher.id, {
    id: "number-migration-schedule",
    title: "Number migration schedule",
    state: "active",
    staleAfterMinutes: 60,
  });
  original.publish(
    publisher.id,
    secret,
    ["Alpha", "Bravo", "Charlie"].map((title, index) => ({
      externalId: title.toLowerCase(),
      sourceRef: {
        source: "gitlab",
        instanceId: "corp",
        projectPath: "team/project",
        iid: index + 1,
        entityType: "merge_request",
      },
      sourceScope: "team/project",
      title,
      summary: `${title} migration evidence.`,
      priority: "normal",
      priorityReason: "Migration fixture.",
      sourceUpdatedAt: now,
      labels: [],
    })),
    { runId: "number-migration-run", sourceCompletedAt: now, mode: "replace", status: "succeeded" },
  );
  original.close();
  copyFileSync(databasePath, missingLedgerPath);
  copyFileSync(databasePath, missingMappingPath);
  copyFileSync(databasePath, repairPath);

  const missingLedger = new DatabaseSync(missingLedgerPath, {
    enableForeignKeyConstraints: false,
  });
  missingLedger.exec(`
    DROP TABLE item_follow_ups;
    DROP TRIGGER trg_dyna_item_number_allocate;
    DROP TRIGGER trg_dyna_item_number_immutable_update;
    DROP TRIGGER trg_dyna_item_number_immutable_delete;
    DROP TABLE item_numbers;
  `);
  missingLedger.close();
  assert.throws(
    () => new SqliteDynaRepository({ databasePath: missingLedgerPath }),
    /item-number ledger is missing.*could renumber/i,
  );
  const ledgerStayedMissing = new DatabaseSync(missingLedgerPath, { readOnly: true });
  assert.equal(
    ledgerStayedMissing
      .prepare(
        "SELECT COUNT(*) AS total FROM sqlite_schema WHERE type = 'table' AND name = 'item_numbers'",
      )
      .get().total,
    0,
  );
  ledgerStayedMissing.close();

  const missingMapping = new DatabaseSync(missingMappingPath);
  missingMapping.exec("DROP TRIGGER trg_dyna_item_number_immutable_delete;");
  missingMapping
    .prepare(
      "DELETE FROM item_numbers WHERE item_id = (SELECT id FROM items WHERE title = 'Charlie')",
    )
    .run();
  missingMapping.close();
  assert.throws(
    () => new SqliteDynaRepository({ databasePath: missingMappingPath }),
    /item-number ledger is incomplete or invalid/i,
  );
  const mappingStayedMissing = new DatabaseSync(missingMappingPath, { readOnly: true });
  assert.equal(
    mappingStayedMissing.prepare("SELECT COUNT(*) AS total FROM item_numbers").get().total,
    2,
  );
  assert.equal(
    mappingStayedMissing
      .prepare(
        "SELECT COUNT(*) AS total FROM sqlite_schema WHERE type = 'trigger' AND name = 'trg_dyna_item_number_immutable_delete'",
      )
      .get().total,
    0,
  );
  mappingStayedMissing.close();

  const repair = new DatabaseSync(repairPath);
  repair.exec("DROP TRIGGER trg_dyna_item_number_allocate;");
  repair.close();
  const repaired = new SqliteDynaRepository({ databasePath: repairPath });
  repaired.close();
  const repairedDatabase = new DatabaseSync(repairPath, { readOnly: true });
  assert.equal(
    repairedDatabase
      .prepare(
        "SELECT COUNT(*) AS total FROM sqlite_schema WHERE type = 'trigger' AND name = 'trg_dyna_item_number_allocate'",
      )
      .get().total,
    1,
  );
  assert.deepEqual(
    repairedDatabase
      .prepare("SELECT number FROM item_numbers ORDER BY number")
      .all()
      .map(({ number }) => number),
    [1, 2, 3],
  );
  repairedDatabase.close();

  const seeded = new DatabaseSync(databasePath, { readOnly: true });
  const initialCards = seeded
    .prepare(
      `SELECT item.id, item.title, item_number.number AS itemNumber
       FROM items item JOIN item_numbers item_number ON item_number.item_id = item.id
       ORDER BY item.rowid`,
    )
    .all();
  seeded.close();
  assert.deepEqual(
    initialCards.map(({ itemNumber }) => itemNumber).sort((left, right) => left - right),
    [1, 2, 3],
  );
  const alpha = initialCards.find(({ title }) => title === "Alpha");
  const bravo = initialCards.find(({ title }) => title === "Bravo");
  const charlie = initialCards.find(({ title }) => title === "Charlie");
  assert.ok(alpha && bravo && charlie);
  const seededRepository = new SqliteDynaRepository({
    databasePath,
    clock: () => new Date(latest),
  });
  seededRepository.write((unitOfWork) => {
    unitOfWork.persistTaskStatus(alpha.id, {
      taskId: "stable-task",
      hostId: "old-host",
      title: `:${alpha.itemNumber}: Alpha completed task`,
      state: "succeeded",
      statusUpdatedAt: later,
      observedAt: later,
      outcome: "Alpha completed safely.",
    });
  });
  seededRepository.close();

  copyFileSync(databasePath, conflictPath);

  const legacy = new DatabaseSync(databasePath);
  legacy.exec("DROP INDEX idx_dyna_task_bindings_task;");
  duplicateTaskBinding(legacy, "stable-task", alpha.id, "new-host", now, latest, {
    projectId: "moved-project",
    title: `:${alpha.itemNumber}: Stale routed task`,
    state: "running",
    outcome: null,
  });
  legacy
    .prepare("UPDATE items SET follow_up_of_item_id = ? WHERE id = ?")
    .run(bravo.id, charlie.id);
  removeVersionEightObjects(legacy);
  legacy.close();

  const migrated = new SqliteDynaRepository({ databasePath, clock: () => new Date(afterNewest) });
  const projection = migrated.read((unitOfWork) => unitOfWork.listProjectionItems(dashboard.id));
  const byId = new Map(projection.map((item) => [item.id, item]));
  assert.deepEqual(
    projection.map(({ itemNumber }) => itemNumber).sort((left, right) => left - right),
    [1, 2, 3],
  );
  assert.equal(byId.get(alpha.id)?.itemNumber, 1);
  assert.equal(byId.get(bravo.id)?.itemNumber, 2);
  assert.equal(byId.get(charlie.id)?.itemNumber, 3);
  assert.deepEqual(
    migrated.read((unitOfWork) => unitOfWork.findTaskOwner("stable-task")),
    {
      itemId: alpha.id,
      hostId: "new-host",
    },
  );
  const migratedTask = migrated
    .read((unitOfWork) => unitOfWork.loadItemContext(alpha.id))
    .linkedTasks.find(({ taskId }) => taskId === "stable-task");
  assert.equal(migratedTask?.hostId, "new-host");
  assert.equal(migratedTask?.projectId, "moved-project");
  assert.equal(migratedTask?.state, "succeeded");
  assert.equal(migratedTask?.statusUpdatedAt, later);
  assert.equal(migratedTask?.observedAt, latest);
  assert.equal(migratedTask?.title, `:${alpha.itemNumber}: Alpha completed task`);
  assert.equal(migratedTask?.outcome, "Alpha completed safely.");

  migrated.write((unitOfWork) => {
    unitOfWork.persistTaskStatus(alpha.id, {
      taskId: "stable-task",
      hostId: "moved-host",
      title: `:${alpha.itemNumber}: Alpha canonical title repaired`,
      state: "succeeded",
      statusUpdatedAt: later,
      observedAt: newest,
      outcome: "Alpha completed safely.",
    });
  });
  assert.deepEqual(
    migrated.read((unitOfWork) => unitOfWork.findTaskOwner("stable-task")),
    {
      itemId: alpha.id,
      hostId: "moved-host",
    },
  );
  assert.equal(
    migrated
      .read((unitOfWork) => unitOfWork.loadItemContext(alpha.id))
      .linkedTasks.find(({ taskId }) => taskId === "stable-task")?.title,
    `:${alpha.itemNumber}: Alpha canonical title repaired`,
  );
  assert.throws(
    () =>
      migrated.write((unitOfWork) => {
        unitOfWork.persistTaskStatus(alpha.id, {
          taskId: "stable-task",
          hostId: "moved-again-host",
          title: `:${alpha.itemNumber}: Alpha canonical title repaired`,
          state: "succeeded",
          statusUpdatedAt: later,
          observedAt: afterNewest,
          outcome: "Conflicting completion evidence.",
        });
      }),
    /conflicting Codex task data at the same status timestamp/,
  );
  assert.throws(
    () =>
      migrated.write((unitOfWork) => {
        unitOfWork.persistTaskStatus(bravo.id, {
          taskId: "stable-task",
          hostId: "other-host",
          title: `:${bravo.itemNumber}: Bravo task`,
          state: "running",
          statusUpdatedAt: newest,
          observedAt: newest,
        });
      }),
    /already linked to another Dyna item/,
  );
  assert.deepEqual(
    migrated.read((unitOfWork) => unitOfWork.findTaskOwner("stable-task")),
    {
      itemId: alpha.id,
      hostId: "moved-host",
    },
  );
  migrated.close();

  const migratedSchema = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(
    migratedSchema
      .prepare(
        "SELECT COUNT(*) AS total FROM sqlite_schema WHERE type = 'table' AND name = 'task_association_reservations'",
      )
      .get().total,
    1,
  );
  assert.equal(
    migratedSchema
      .prepare(
        "SELECT COUNT(*) AS total FROM sqlite_schema WHERE type = 'index' AND name IN ('idx_dyna_active_task_reservation', 'idx_dyna_task_reservation_expiry')",
      )
      .get().total,
    2,
  );
  migratedSchema.close();

  const projectedRelations = new SqliteDynaRepository({
    databasePath,
    clock: () => new Date(latest),
  });
  const charlieProjection = projectedRelations
    .read((unitOfWork) => unitOfWork.listProjectionItems(dashboard.id))
    .find(({ id }) => id === charlie.id);
  assert.equal(charlieProjection?.followUpOfItemNumber, bravo.itemNumber);
  const charlieContext = projectedRelations.read((unitOfWork) =>
    unitOfWork.loadItemContext(charlie.id),
  );
  assert.equal(charlieContext.itemNumber, charlie.itemNumber);
  assert.equal(charlieContext.followUpOfItemNumber, bravo.itemNumber);
  const charlieHistory = projectedRelations.read((unitOfWork) =>
    unitOfWork.loadItemHistory(dashboard.id, charlie.id),
  );
  assert.equal(charlieHistory.itemNumber, charlie.itemNumber);
  assert.equal(charlieHistory.followUpOfItemNumber, bravo.itemNumber);
  assert.equal(
    projectedRelations.read((unitOfWork) =>
      unitOfWork.loadItemActivityPage(dashboard.id, charlie.id),
    ).itemNumber,
    charlie.itemNumber,
  );
  assert.deepEqual(
    [
      ...projectedRelations.read((unitOfWork) =>
        unitOfWork.matchingProjectionItemIds(dashboard.id, "active", [":2:"]),
      ),
    ],
    [bravo.id],
  );
  projectedRelations.close();

  const followUpStore = new DynaStore({ databasePath, clock: () => new Date(afterNewest) });
  const followUpId = followUpStore.addTodo(
    followUpStore.createView(dashboard.id),
    {
      title: "Durable cross-publisher follow-up",
      summary: "Retain source provenance after publisher purge.",
      priority: "normal",
      labels: ["follow-up"],
      followUpOfItemId: bravo.id,
    },
    randomUUID(),
  );
  const followUpBeforePurge = followUpStore.itemContext(followUpId);
  assert.equal(followUpBeforePurge.followUpOfItemId, bravo.id);
  assert.equal(followUpBeforePurge.followUpOfItemNumber, bravo.itemNumber);
  assert.equal(followUpBeforePurge.itemNumber, 4);
  followUpStore.revokePublisher(publisher.id, true);
  const followUpAfterPurge = followUpStore.itemContext(followUpId);
  assert.equal(followUpAfterPurge.followUpOfItemId, bravo.id);
  assert.equal(followUpAfterPurge.followUpOfItemNumber, bravo.itemNumber);
  followUpStore.close();

  const tombstone = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
  assert.throws(
    () => tombstone.prepare("UPDATE item_numbers SET number = 99 WHERE item_id = ?").run(alpha.id),
    /immutable/,
  );
  assert.throws(
    () => tombstone.prepare("DELETE FROM item_numbers WHERE item_id = ?").run(alpha.id),
    /never recycled/,
  );
  assert.equal(
    tombstone.prepare("SELECT number FROM item_numbers WHERE item_id = ?").get(alpha.id).number,
    alpha.itemNumber,
  );
  tombstone.close();

  const afterDeletion = new DynaStore({ databasePath, clock: () => new Date(latest) });
  const created = afterDeletion.createTodoFromCli(dashboard.id, {
    requestId: randomUUID(),
    title: "Delta",
    summary: "A new item after a deleted source item.",
    priority: "normal",
    labels: [],
  });
  assert.equal(created.itemNumber, 5);
  afterDeletion.close();

  const verified = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(verified.prepare("PRAGMA user_version").get().user_version, 9);
  assert.deepEqual(
    verified
      .prepare("SELECT number FROM item_numbers ORDER BY number")
      .all()
      .map(({ number }) => number),
    [1, 2, 3, 4, 5],
  );
  assert.equal(
    verified.prepare("SELECT follow_up_of_item_id FROM items WHERE id = ?").get(followUpId)
      .follow_up_of_item_id,
    null,
  );
  const durableFollowUp = verified
    .prepare(
      "SELECT source_item_id AS sourceItemId, source_item_number AS sourceItemNumber FROM item_follow_ups WHERE item_id = ?",
    )
    .get(followUpId);
  assert.equal(durableFollowUp.sourceItemId, bravo.id);
  assert.equal(durableFollowUp.sourceItemNumber, bravo.itemNumber);
  assert.equal(
    verified
      .prepare("SELECT COUNT(*) AS total FROM task_bindings WHERE task_id = 'stable-task'")
      .get().total,
    0,
  );
  assert.equal(
    verified
      .prepare(
        "SELECT COUNT(*) AS total FROM sqlite_schema WHERE type = 'index' AND name = 'idx_dyna_task_bindings_task'",
      )
      .get().total,
    1,
  );
  verified.close();

  const concurrentItems = await Promise.all([
    createTodoInChild(dashboard.id, "Concurrent item A"),
    createTodoInChild(dashboard.id, "Concurrent item B"),
  ]);
  assert.notEqual(concurrentItems[0].itemId, concurrentItems[1].itemId);
  assert.deepEqual(
    concurrentItems.map(({ itemNumber }) => itemNumber).sort((left, right) => left - right),
    [6, 7],
  );

  copyFileSync(databasePath, exhaustionPath);
  const nearExhaustion = new DatabaseSync(exhaustionPath);
  nearExhaustion
    .prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'item_numbers'")
    .run(Number.MAX_SAFE_INTEGER - 1);
  nearExhaustion.close();
  const exhaustion = new DynaStore({
    databasePath: exhaustionPath,
    clock: () => new Date(afterNewest),
  });
  const lastNumber = exhaustion.createTodoFromCli(dashboard.id, {
    requestId: randomUUID(),
    title: "Last safe number",
    priority: "normal",
    labels: [],
  });
  assert.equal(lastNumber.itemNumber, Number.MAX_SAFE_INTEGER);
  assert.throws(
    () =>
      exhaustion.createTodoFromCli(dashboard.id, {
        requestId: randomUUID(),
        title: "Beyond the safe integer boundary",
        priority: "normal",
        labels: [],
      }),
    /constraint|item number/i,
  );
  exhaustion.close();
  const exhaustedDatabase = new DatabaseSync(exhaustionPath, { readOnly: true });
  assert.equal(
    exhaustedDatabase.prepare("SELECT MAX(number) AS maximum FROM item_numbers").get().maximum,
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(
    exhaustedDatabase
      .prepare(
        "SELECT COUNT(*) AS total FROM items WHERE title = 'Beyond the safe integer boundary'",
      )
      .get().total,
    0,
  );
  exhaustedDatabase.close();

  const conflicting = new DatabaseSync(conflictPath);
  conflicting.exec("DROP INDEX idx_dyna_task_bindings_task;");
  duplicateTaskBinding(conflicting, "stable-task", bravo.id, "conflicting-host", later, later);
  removeVersionEightObjects(conflicting);
  conflicting.close();
  assert.throws(
    () => new SqliteDynaRepository({ databasePath: conflictPath }),
    /links one Codex task to multiple items/,
  );
  const unchanged = new DatabaseSync(conflictPath, { readOnly: true });
  assert.equal(unchanged.prepare("PRAGMA user_version").get().user_version, 7);
  assert.equal(
    unchanged
      .prepare("SELECT COUNT(*) AS total FROM task_bindings WHERE task_id = 'stable-task'")
      .get().total,
    2,
  );
  assert.equal(
    unchanged
      .prepare(
        "SELECT COUNT(*) AS total FROM sqlite_schema WHERE type = 'table' AND name = 'item_numbers'",
      )
      .get().total,
    0,
  );
  assert.equal(
    unchanged
      .prepare(
        "SELECT COUNT(*) AS total FROM sqlite_schema WHERE type = 'table' AND name = 'task_association_reservations'",
      )
      .get().total,
    0,
  );
  unchanged.close();

  globalThis.process.stdout.write(
    JSON.stringify({
      deterministicBackfill: true,
      immutableLedger: true,
      neverRecycled: true,
      projections: true,
      followUpProvenance: true,
      taskHostMovement: true,
      taskStatusEvidencePreserved: true,
      sameTimestampRoutingRepair: true,
      taskOwnershipConflict: true,
      migrationRollback: true,
      reopenFailClosed: true,
      supplementalRepair: true,
      reservationSchemaMigration: true,
      safeIntegerExhaustion: true,
      concurrentAllocation: true,
    }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

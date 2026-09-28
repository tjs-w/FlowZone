import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdout } from "node:process";
import { DatabaseSync } from "node:sqlite";

import { loadDynaApplicationService } from "./application-service-test-bundle.mjs";

const { serviceModule, cleanup } = await loadDynaApplicationService();
const { DynaApplicationService } = serviceModule;

let now = Date.now() - 60_000;
const clock = () => new Date(now);
const advance = () => new Date((now += 1_000)).toISOString();

function deliverAndClaim(service, dashboardId, inventory) {
  const view = service.render(dashboardId);
  const begun = service.beginTaskSyncForView(view.viewToken, { kind: "dashboard" }, inventory);
  if (!begun.deliveryRequired) return { view, begun };
  service.markTaskSyncDeliveredForView(view.viewToken, begun.summary.runId);
  return { view, begun, claim: service.claimTaskSync(begun.summary.runId) };
}

const service = new DynaApplicationService({ databasePath: ":memory:", clock });
const migrationDirectory = mkdtempSync(join(tmpdir(), "flowzone-dyna-discovery-migration-"));
try {
  const dashboard = service.createDashboard("Discovery", "Ordinary Codex tasks");
  const { publisher: seedPublisher, secret: seedSecret } = service.createPublisher(
    "Discovery source seed",
    undefined,
    undefined,
    "local_preview",
  );
  service.bindSchedule(dashboard.id, seedPublisher.id, {
    id: "discovery-source-seed",
    title: "Discovery source seed",
    state: "active",
    staleAfterMinutes: 60,
  });
  service.publish(
    seedPublisher.id,
    seedSecret,
    [
      {
        externalId: "adopted-task",
        sourceRef: { source: "codex", taskId: "adopted-task" },
        sourceScope: "codex:discovery-seed",
        title: "Adopt existing Codex source item",
        summary: "Existing source item awaits a native task association.",
        priority: "normal",
        priorityReason: "Source inventory",
        sourceUpdatedAt: advance(),
        labels: [],
      },
    ],
    {
      runId: "discovery-source-seed-run",
      sourceCompletedAt: advance(),
      mode: "replace",
      status: "succeeded",
    },
  );
  const first = deliverAndClaim(service, dashboard.id, {
    state: "available",
    taskIds: ["scheduled-task"],
  });
  assert.equal(first.claim.discovery.state, "required");
  assert.equal(first.claim.targets.length, 0);
  assert.equal(JSON.stringify(first.claim).includes("scheduled-task"), false);

  const discoveryRequestId = randomUUID();
  const candidates = [
    {
      taskId: "scheduled-task",
      hostId: "host-local",
      title: "Scheduled collector",
      updatedAt: advance(),
    },
    {
      taskId: "adopted-task",
      hostId: "host-local",
      title: "Adopt existing Codex source item",
      updatedAt: advance(),
    },
    {
      taskId: "ordinary-task",
      hostId: "host-local",
      projectId: "project-local",
      title: "Investigate release schedule health",
      updatedAt: advance(),
    },
  ];
  const discovered = service.submitTaskDiscoveryBatch(first.claim.runId, first.claim.claimToken, {
    requestId: discoveryRequestId,
    candidates,
  });
  assert.equal(discovered.deduplicated, false);
  assert.equal(discovered.acceptedCandidates, 3);
  assert.equal(discovered.repairTargets.length, 2);
  assert.equal(discovered.summary.inspectedSessions, 3);
  assert.equal(discovered.summary.importedItems, 1);
  assert.equal(discovered.summary.adoptedItems, 1);
  const replay = service.submitTaskDiscoveryBatch(first.claim.runId, first.claim.claimToken, {
    requestId: discoveryRequestId,
    candidates,
  });
  assert.equal(replay.deduplicated, true);
  assert.throws(
    () =>
      service.submitTaskDiscoveryBatch(first.claim.runId, first.claim.claimToken, {
        requestId: discoveryRequestId,
        candidates: [candidates[2]],
      }),
    /reused for different input/u,
  );

  const repair = discovered.repairTargets.find((target) => target.taskId === "ordinary-task");
  const adoptedRepair = discovered.repairTargets.find((target) => target.taskId === "adopted-task");
  assert.ok(repair);
  assert.ok(adoptedRepair);
  assert.match(repair.canonicalTitle, new RegExp(`^:${String(repair.itemNumber)}: `, "u"));
  service.submitTaskSyncBatch(first.claim.runId, first.claim.claimToken, {
    requestId: randomUUID(),
    observations: [
      {
        taskId: repair.taskId,
        checkpointVersion: repair.checkpointVersion,
        task: {
          taskId: repair.taskId,
          hostId: repair.hostId,
          projectId: "project-local",
          title: repair.canonicalTitle,
          state: "succeeded",
          statusUpdatedAt: advance(),
          observedAt: advance(),
          outcome: "Release health investigation completed.",
        },
        summaryCoverage: "available",
      },
      {
        taskId: adoptedRepair.taskId,
        checkpointVersion: adoptedRepair.checkpointVersion,
        task: {
          taskId: adoptedRepair.taskId,
          hostId: adoptedRepair.hostId,
          title: adoptedRepair.canonicalTitle,
          state: "running",
          statusUpdatedAt: advance(),
          observedAt: advance(),
        },
        summaryCoverage: "available",
      },
    ],
    unavailable: [],
  });
  const completed = service.completeTaskSync(first.claim.runId, first.claim.claimToken, {
    requestId: randomUUID(),
    inventoryState: "complete",
  });
  assert.equal(completed.summary.state, "updated");
  assert.equal(completed.summary.importedItems, 1);
  assert.equal(completed.summary.adoptedItems, 1);
  assert.equal(completed.summary.skippedSessions, 0);
  const snapshot = service.snapshot(dashboard.id);
  assert.equal(snapshot.cards.length, 2);
  const importedCard = snapshot.cards.find((card) => card.sourceRef.taskId === "ordinary-task");
  const adoptedCard = snapshot.cards.find((card) => card.sourceRef.taskId === "adopted-task");
  assert.ok(importedCard);
  assert.ok(adoptedCard);
  assert.equal(importedCard.title, "Investigate release schedule health");
  assert.equal(importedCard.linkedTasks[0].title, repair.canonicalTitle);
  assert.equal(importedCard.workflowState, "completed");
  assert.equal(adoptedCard.linkedTasks[0].title, adoptedRepair.canonicalTitle);
  assert.equal(adoptedCard.workflowState, "executing");

  const otherDashboard = service.createDashboard("Other", "Do not duplicate tracked work");
  const other = deliverAndClaim(service, otherDashboard.id, {
    state: "available",
    taskIds: [],
  });
  const elsewhere = service.submitTaskDiscoveryBatch(other.claim.runId, other.claim.claimToken, {
    requestId: randomUUID(),
    candidates: [candidates[2]],
  });
  assert.equal(elsewhere.repairTargets.length, 0);
  assert.equal(elsewhere.summary.skippedSessions, 1);
  const otherCompleted = service.completeTaskSync(other.claim.runId, other.claim.claimToken, {
    requestId: randomUUID(),
    inventoryState: "complete",
  });
  assert.equal(otherCompleted.summary.state, "partial");
  assert.equal(service.snapshot(otherDashboard.id).cards.length, 0);

  const unavailableDashboard = service.createDashboard("Unavailable", "Fail closed");
  const unavailable = deliverAndClaim(service, unavailableDashboard.id, {
    state: "unavailable",
  });
  assert.equal(unavailable.begun.deliveryRequired, false);
  assert.equal(unavailable.begun.summary.state, "partial");
  assert.equal(unavailable.begun.summary.discoveryState, "unavailable");

  const cappedDashboard = service.createDashboard("Capped", "Bounded discovery inventory");
  const scheduledIds = Array.from({ length: 201 }, (_, index) => `scheduled-${String(index)}`);
  const capped = deliverAndClaim(service, cappedDashboard.id, {
    state: "available",
    taskIds: scheduledIds,
  });
  for (let offset = 0; offset < 200; offset += 8) {
    const batch = scheduledIds.slice(offset, offset + 8).map((taskId) => ({
      taskId,
      hostId: "host-local",
      title: `Scheduled task ${taskId}`,
      updatedAt: advance(),
    }));
    service.submitTaskDiscoveryBatch(capped.claim.runId, capped.claim.claimToken, {
      requestId: randomUUID(),
      candidates: batch,
    });
  }
  assert.throws(
    () =>
      service.submitTaskDiscoveryBatch(capped.claim.runId, capped.claim.claimToken, {
        requestId: randomUUID(),
        candidates: [
          {
            taskId: scheduledIds[200],
            hostId: "host-local",
            title: "Scheduled overflow",
            updatedAt: advance(),
          },
        ],
      }),
    /cannot inspect more than 200 Codex tasks/u,
  );
  const cappedComplete = service.completeTaskSync(capped.claim.runId, capped.claim.claimToken, {
    requestId: randomUUID(),
    inventoryState: "truncated",
  });
  assert.equal(cappedComplete.summary.state, "partial");
  assert.equal(cappedComplete.summary.inspectedSessions, 200);
  assert.equal(cappedComplete.summary.inventoryTruncated, true);

  const versionTwelvePath = join(migrationDirectory, "version-twelve.sqlite3");
  const seededMigration = new DynaApplicationService({ databasePath: versionTwelvePath, clock });
  seededMigration.createDashboard("Migration", "Discovery schema migration");
  seededMigration.close();
  const versionTwelve = new DatabaseSync(versionTwelvePath);
  versionTwelve.exec(`
    DROP TABLE task_sync_discoveries;
    DROP TABLE task_sync_exclusions;
    ALTER TABLE task_sync_runs DROP COLUMN discovery_state;
    ALTER TABLE task_sync_runs DROP COLUMN inspected_sessions;
    ALTER TABLE task_sync_runs DROP COLUMN imported_items;
    ALTER TABLE task_sync_runs DROP COLUMN adopted_items;
    ALTER TABLE task_sync_runs DROP COLUMN skipped_sessions;
    ALTER TABLE task_sync_runs DROP COLUMN inventory_truncated;
    PRAGMA user_version = 12;
  `);
  versionTwelve.close();

  const corruptPath = join(migrationDirectory, "corrupt.sqlite3");
  copyFileSync(versionTwelvePath, corruptPath);
  const corrupt = new DatabaseSync(corruptPath);
  corrupt.exec("CREATE TABLE task_sync_discoveries (broken TEXT);");
  corrupt.close();
  assert.throws(
    () => new DynaApplicationService({ databasePath: corruptPath, clock }),
    /task_sync_discoveries|run_id/u,
  );
  const rolledBack = new DatabaseSync(corruptPath);
  assert.equal(rolledBack.prepare("PRAGMA user_version").get().user_version, 12);
  assert.equal(
    rolledBack
      .prepare("PRAGMA table_info(task_sync_runs)")
      .all()
      .some((column) => column.name === "discovery_state"),
    false,
  );
  rolledBack.close();

  const migrated = new DynaApplicationService({ databasePath: versionTwelvePath, clock });
  migrated.close();
  const verifiedMigration = new DatabaseSync(versionTwelvePath);
  assert.equal(verifiedMigration.prepare("PRAGMA user_version").get().user_version, 14);
  assert.ok(
    verifiedMigration
      .prepare("PRAGMA table_info(task_sync_runs)")
      .all()
      .some((column) => column.name === "discovery_state"),
  );
  assert.equal(
    verifiedMigration
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('task_sync_discoveries', 'task_sync_exclusions')",
      )
      .get().count,
    2,
  );
  verifiedMigration.close();

  stdout.write(
    JSON.stringify({
      scheduledExcluded: true,
      ordinaryImported: true,
      ordinaryScheduleTitleEligible: true,
      codexSourceAdopted: true,
      succeededImportCompleted: true,
      stableNumberAllocated: true,
      replaySafe: true,
      boundedAtTwoHundred: true,
      versionTwelveMigrated: true,
      migrationRollback: true,
      crossDashboardSkipped: true,
      unavailableFailsClosed: true,
    }),
  );
} finally {
  service.close();
  cleanup();
  rmSync(migrationDirectory, { recursive: true, force: true });
}

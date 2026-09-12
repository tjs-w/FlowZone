import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { DynaCliStoreError, DynaStore } from "../src/store.ts";

const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-ledger-race-"));
const databasePath = join(directory, "dyna.sqlite3");
const worker = resolve(import.meta.dirname, "cli-ledger-race-worker.mjs");

function runWorker(arguments_) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(globalThis.process.execPath, [worker, ...arguments_], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolveResult({ status, stdout, stderr }));
  });
}

try {
  const seed = new DynaStore({ databasePath });
  const dashboard = seed.createDashboard("Race", "CLI idempotency race");
  const { publisher, secret } = seed.createPublisher(
    "Race publisher",
    undefined,
    undefined,
    "local_preview",
  );
  seed.bindSchedule(dashboard.id, publisher.id, {
    id: "race-schedule",
    title: "Race schedule",
    state: "active",
    staleAfterMinutes: 60,
  });
  seed.publish(
    publisher.id,
    secret,
    [
      {
        externalId: "race-item",
        sourceRef: {
          source: "gitlab",
          instanceId: "gitlab.example.com",
          projectPath: "team/service",
          iid: 99,
          entityType: "merge_request",
        },
        sourceScope: "team/service",
        title: "Race item",
        summary: "Concurrent writers target one logical request.",
        priority: "normal",
        priorityReason: "Test",
        sourceUpdatedAt: "2026-09-10T18:00:00.000Z",
        labels: [],
      },
    ],
    {
      runId: "race-run",
      sourceCompletedAt: "2026-09-10T18:00:00.000Z",
      mode: "replace",
      status: "succeeded",
    },
  );
  const item = seed.snapshot(dashboard.id).cards[0];
  assert.ok(item);
  seed.close();

  const requestId = randomUUID();
  const workAttemptId = randomUUID();
  const arguments_ = [
    databasePath,
    dashboard.id,
    item.id,
    item.fingerprint,
    requestId,
    workAttemptId,
  ];
  const [left, right] = await Promise.all([runWorker(arguments_), runWorker(arguments_)]);
  assert.equal(left.status, 0, left.stderr);
  assert.equal(right.status, 0, right.stderr);
  const results = [JSON.parse(left.stdout), JSON.parse(right.stdout)];
  assert.equal(results[0].workUpdateId, results[1].workUpdateId);
  assert.deepEqual(results.map((result) => result.deduplicated).sort(), [false, true]);

  const verify = new DynaStore({ databasePath });
  assert.equal(verify.showItem(dashboard.id, item.id).item.workUpdates.length, 1);
  const rollbackRequest = randomUUID();
  assert.throws(
    () =>
      verify.recordWorkUpdate(dashboard.id, item.id, item.fingerprint, {
        requestId: rollbackRequest,
        workAttemptId: randomUUID(),
        kind: "progress",
        body: "This attribution is invalid.",
        artifacts: [],
        task: { taskId: "missing", hostId: "local" },
      }),
    (error) => error instanceof DynaCliStoreError && error.code === "task_not_linked",
  );
  const afterRollback = verify.recordWorkUpdate(dashboard.id, item.id, item.fingerprint, {
    requestId: rollbackRequest,
    workAttemptId: randomUUID(),
    kind: "note",
    body: "The failed transaction did not reserve this request ID.",
    artifacts: [],
  });
  assert.equal(afterRollback.deduplicated, false);
  verify.close();

  globalThis.process.stdout.write(JSON.stringify({ concurrent: true, rollback: true }));
} finally {
  rmSync(directory, { recursive: true, force: true });
}

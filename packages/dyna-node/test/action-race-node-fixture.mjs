import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { DynaStore } from "../src/store.ts";

const now = "2026-09-03T20:00:00.000Z";

if (process.argv[2] === "worker") {
  process.once("message", (configuration) => {
    const store = new DynaStore({
      databasePath: configuration.databasePath,
      clock: () => new Date(now),
    });
    try {
      store.authorizeView(configuration.viewToken, configuration.itemId);
      // Synchronize the race after authorization so both independent SQLite
      // connections contend on prepareAction's logical dedupe transaction.
      store.authorizeView = () => configuration.dashboardId;
      process.send?.({ ready: true });
      process.once("message", () => {
        try {
          const request = store.prepareAction(configuration.viewToken, "open_source", {
            itemId: configuration.itemId,
            expectedRevision: configuration.revision,
            expectedFingerprint: configuration.fingerprint,
            idempotencyKey: configuration.idempotencyKey,
          });
          process.send?.({ requestId: request.id });
        } catch (error) {
          process.send?.({ error: error instanceof Error ? error.message : String(error) });
        } finally {
          store.close();
          process.disconnect();
        }
      });
    } catch (error) {
      process.send?.({ error: error instanceof Error ? error.message : String(error) });
      store.close();
      process.disconnect();
    }
  });
} else {
  const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-action-race-"));
  const databasePath = join(directory, "dyna.sqlite3");
  try {
    const seed = new DynaStore({ databasePath, clock: () => new Date(now) });
    const dashboard = seed.createDashboard("Action race", "Cross-process logical dedupe");
    const { publisher, secret } = seed.createPublisher("Action schedule");
    seed.bindSchedule(dashboard.id, publisher.id, {
      id: "action-schedule",
      title: "Action schedule",
      state: "active",
      staleAfterMinutes: 60,
    });
    seed.publish(
      publisher.id,
      secret,
      [
        {
          externalId: "action-item",
          sourceRef: {
            source: "gitlab",
            instanceId: "corp",
            projectPath: "team/project",
            iid: 11,
            entityType: "merge_request",
          },
          sourceScope: "team/project",
          title: "Open source",
          summary: "Only one logical action may be prepared.",
          priority: "high",
          priorityReason: "Race regression.",
          sourceUpdatedAt: now,
          labels: [],
        },
      ],
      { runId: "action-run", sourceCompletedAt: now, mode: "replace", status: "succeeded" },
    );
    const snapshot = seed.snapshot(dashboard.id);
    const item = snapshot.cards[0];
    assert.ok(item);
    const viewToken = seed.createView(dashboard.id);
    seed.close();

    const raw = new DatabaseSync(databasePath, { timeout: 5_000 });
    raw.exec(`
      CREATE TRIGGER slow_action_insert BEFORE INSERT ON action_requests BEGIN
        SELECT randomblob(4000000);
      END;
    `);
    raw.close();

    const workers = [0, 1].map(() =>
      fork(fileURLToPath(import.meta.url), ["worker"], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      }),
    );
    const configuration = (index) => ({
      databasePath,
      dashboardId: dashboard.id,
      viewToken,
      itemId: item.id,
      revision: snapshot.revision,
      fingerprint: item.fingerprint,
      idempotencyKey: `race-${index}`,
    });
    workers.forEach((worker, index) => worker.send(configuration(index)));
    const ready = await Promise.all(workers.map((worker) => once(worker, "message")));
    for (const [message] of ready) assert.equal(message.ready, true, message.error);

    workers.forEach((worker) => worker.send({ go: true }));
    const results = await Promise.all(workers.map((worker) => once(worker, "message")));
    for (const [message] of results) assert.ok(message.requestId, message.error);
    assert.equal(results[0][0].requestId, results[1][0].requestId);
    await Promise.all(
      workers.map((worker) =>
        worker.exitCode === null ? once(worker, "exit") : Promise.resolve([worker.exitCode]),
      ),
    );

    const count = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(count.prepare("SELECT COUNT(*) AS total FROM action_requests").get().total, 1);
    count.close();

    const first = new DynaStore({ databasePath, clock: () => new Date(now) });
    const otherDashboard = first.createDashboard("Other", "Wrong view token");
    const wrongView = first.createView(otherDashboard.id);
    assert.throws(
      () => first.markDelivered(wrongView, results[0][0].requestId),
      /cannot be delivered/,
    );
    assert.equal(first.actionStatus(results[0][0].requestId).state, "prepared");
    assert.equal(first.markDelivered(viewToken, results[0][0].requestId).state, "delivered");
    assert.equal(first.markDelivered(viewToken, results[0][0].requestId).state, "delivered");
    assert.equal(first.claimAction(results[0][0].requestId).request.state, "claimed");
    assert.equal(first.markDelivered(viewToken, results[0][0].requestId).state, "claimed");
    first.close();

    globalThis.process.stdout.write(
      JSON.stringify({ crossProcessDedupe: true, deliveryCas: true }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

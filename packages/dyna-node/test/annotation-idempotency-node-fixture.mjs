import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import { DynaStore } from "../src/store.ts";

const now = "2026-09-03T20:00:00.000Z";

if (!isMainThread) {
  const store = new DynaStore({
    databasePath: workerData.databasePath,
    clock: () => new Date(now),
  });
  parentPort?.postMessage({ ready: true });
  parentPort?.once("message", () => {
    try {
      const annotation = store.addAnnotation(
        workerData.viewToken,
        workerData.itemId,
        workerData.clientRequestId,
        "Must not be attached after unbinding.",
      );
      parentPort?.postMessage({ annotationId: annotation.id });
    } catch (error) {
      parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      store.close();
      parentPort?.close();
    }
  });
} else {
  const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-annotation-"));
  const databasePath = join(directory, "dyna.sqlite3");
  try {
    const store = new DynaStore({ databasePath, clock: () => new Date(now) });
    const dashboard = store.createDashboard("Annotation", "Retry and membership checks");
    const siblingDashboard = store.createDashboard("Annotation sibling", "Scope check");
    const { publisher, secret } = store.createPublisher("Annotation source");
    for (const target of [dashboard, siblingDashboard]) {
      store.bindSchedule(target.id, publisher.id, {
        id: "annotation-source",
        title: "Annotation source",
        state: "active",
        staleAfterMinutes: 60,
      });
    }
    store.publish(
      publisher.id,
      secret,
      [
        {
          externalId: "annotation-item",
          sourceRef: { source: "codex", taskId: "annotation-source-task" },
          sourceScope: "local",
          title: "Annotate this item",
          summary: "A stable item for annotation retries.",
          priority: "normal",
          priorityReason: "Test fixture.",
          sourceUpdatedAt: now,
          labels: [],
        },
      ],
      { runId: "annotation-run", sourceCompletedAt: now, mode: "replace", status: "succeeded" },
    );
    const item = store.snapshot(dashboard.id).cards[0];
    assert.ok(item);
    const viewToken = store.createView(dashboard.id);
    const siblingViewToken = store.createView(siblingDashboard.id);
    const clientRequestId = "30c5e632-4287-4e4d-b5b1-b46a81b2ad43";
    const first = store.addAnnotation(viewToken, item.id, clientRequestId, "  Review in Codex.  ");
    const retry = store.addAnnotation(viewToken, item.id, clientRequestId, "Review in Codex.");
    assert.deepEqual(retry, first);
    assert.throws(
      () => store.addAnnotation(viewToken, item.id, clientRequestId, "Different content."),
      /request ID reused with different content/,
    );

    const sibling = store.addAnnotation(
      siblingViewToken,
      item.id,
      clientRequestId,
      "Review in Codex.",
    );
    assert.notEqual(sibling.id, first.id);
    store.close();

    const worker = new Worker(new URL(import.meta.url), {
      workerData: {
        databasePath,
        viewToken,
        itemId: item.id,
        clientRequestId: "43125328-b2db-44ca-a83f-3357ee332f79",
      },
    });
    const [ready] = await once(worker, "message");
    assert.equal(ready.ready, true);

    const writer = new DatabaseSync(databasePath, { timeout: 5_000 });
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;");
    writer
      .prepare("DELETE FROM dashboard_publishers WHERE dashboard_id = ? AND publisher_id = ?")
      .run(dashboard.id, publisher.id);
    worker.postMessage({ annotate: true });
    await delay(50);
    writer.exec("COMMIT");
    writer.close();

    const [result] = await once(worker, "message");
    assert.match(result.error, /outside this dashboard view/);
    await once(worker, "exit");

    const verifier = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(verifier.prepare("SELECT COUNT(*) AS total FROM annotations").get().total, 2);
    verifier.close();

    globalThis.process.stdout.write(
      JSON.stringify({
        exactRetry: true,
        conflictRejected: true,
        scoped: true,
        membershipRace: true,
      }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

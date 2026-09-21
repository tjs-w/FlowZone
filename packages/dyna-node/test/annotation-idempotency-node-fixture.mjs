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
      parentPort?.postMessage({ annotationId: annotation.annotationId });
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
    const { publisher, secret } = store.createPublisher(
      "Annotation source",
      undefined,
      undefined,
      "local_preview",
    );
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
    assert.equal(first.deduplicated, false);
    assert.equal(retry.deduplicated, true);
    assert.equal(retry.annotationId, first.annotationId);
    assert.equal(retry.version, first.version);
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
    assert.notEqual(sibling.annotationId, first.annotationId);

    const editRequestId = "9e029ca7-0f44-439f-adf1-cd9f6e456546";
    const edited = store.editAnnotation({
      viewToken: siblingViewToken,
      itemId: item.id,
      annotationId: first.annotationId,
      clientRequestId: editRequestId,
      expectedVersion: 1,
      body: "deleted-only-marker-938",
    });
    const editRetry = store.editAnnotation({
      viewToken: siblingViewToken,
      itemId: item.id,
      annotationId: first.annotationId,
      clientRequestId: editRequestId,
      expectedVersion: 1,
      body: "deleted-only-marker-938",
    });
    assert.equal(edited.version, 2);
    assert.equal(editRetry.deduplicated, true);
    assert.equal(editRetry.version, 2);
    assert.throws(
      () =>
        store.editAnnotation({
          viewToken,
          itemId: item.id,
          annotationId: first.annotationId,
          clientRequestId: "be637516-a9dc-4219-896e-20875ca44b21",
          expectedVersion: 1,
          body: "Stale content.",
        }),
      /note changed/i,
    );
    assert.throws(
      () =>
        store.deleteAnnotation({
          viewToken: siblingViewToken,
          itemId: item.id,
          annotationId: first.annotationId,
          clientRequestId: editRequestId,
          expectedVersion: 2,
        }),
      /request ID reused/i,
    );
    const deleteRequestId = "6558ad32-d8b2-42a2-9d4c-729937938976";
    const deleted = store.deleteAnnotation({
      viewToken,
      itemId: item.id,
      annotationId: first.annotationId,
      clientRequestId: deleteRequestId,
      expectedVersion: 2,
    });
    const deleteRetry = store.deleteAnnotation({
      viewToken,
      itemId: item.id,
      annotationId: first.annotationId,
      clientRequestId: deleteRequestId,
      expectedVersion: 2,
    });
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.version, 3);
    assert.equal(deleteRetry.deduplicated, true);
    assert.equal(
      store
        .itemContext(item.id)
        .annotations.some((annotation) => annotation.id === first.annotationId),
      false,
    );
    assert.equal(
      store.searchItems(dashboard.id, "deleted-only-marker-938", "active").items.length,
      0,
    );
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

    const verifier = new DatabaseSync(databasePath);
    assert.equal(verifier.prepare("SELECT COUNT(*) AS total FROM annotations").get().total, 2);
    assert.deepEqual(
      {
        ...verifier
          .prepare("SELECT body, version, deleted_at FROM annotations WHERE id = ?")
          .get(first.annotationId),
      },
      { body: "", version: 3, deleted_at: now },
    );
    assert.equal(
      verifier.prepare("SELECT COUNT(*) AS total FROM annotation_events").get().total,
      4,
    );
    assert.throws(() => verifier.prepare("DELETE FROM annotation_events").run(), /append-only/);
    verifier.close();

    const migrationPath = join(directory, "dyna-v9.sqlite3");
    const legacy = new DynaStore({ databasePath: migrationPath, clock: () => new Date(now) });
    const legacyDashboard = legacy.createDashboard("Legacy notes", "V9 annotation replay");
    const legacyPublisher = legacy.createPublisher(
      "Legacy annotation source",
      undefined,
      undefined,
      "local_preview",
    );
    legacy.bindSchedule(legacyDashboard.id, legacyPublisher.publisher.id, {
      id: "legacy-annotation-source",
      title: "Legacy annotation source",
      state: "active",
      staleAfterMinutes: 60,
    });
    legacy.publish(
      legacyPublisher.publisher.id,
      legacyPublisher.secret,
      [
        {
          externalId: "legacy-annotation-item",
          sourceRef: { source: "codex", taskId: "legacy-annotation-task" },
          sourceScope: "local",
          title: "Migrate this note",
          summary: "Preserve exact add-note replay during v9 migration.",
          priority: "normal",
          priorityReason: "Migration fixture.",
          sourceUpdatedAt: now,
          labels: [],
        },
      ],
      {
        runId: "legacy-annotation-run",
        sourceCompletedAt: now,
        mode: "replace",
        status: "succeeded",
      },
    );
    const legacyItem = legacy.snapshot(legacyDashboard.id).cards[0];
    assert.ok(legacyItem);
    const legacyView = legacy.createView(legacyDashboard.id);
    const legacyRequestId = "b7cd5afd-01e5-45d2-b957-ab6c6143197a";
    const legacyCreated = legacy.addAnnotation(
      legacyView,
      legacyItem.id,
      legacyRequestId,
      "Preserve this v9 note.",
    );
    legacy.close();

    const downgrade = new DatabaseSync(migrationPath);
    downgrade.exec(`
      DROP TABLE annotation_events;
      DROP INDEX idx_dyna_annotations_item_created;
      ALTER TABLE annotations RENAME TO annotations_v10_seed;
      CREATE TABLE annotations (
        id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        body TEXT NOT NULL, created_at TEXT NOT NULL
      );
      INSERT INTO annotations (id, item_id, body, created_at)
      SELECT id, item_id, body, created_at FROM annotations_v10_seed;
      DROP TABLE annotations_v10_seed;
      CREATE INDEX idx_dyna_annotations_item_created
        ON annotations(item_id, created_at DESC);
      PRAGMA user_version = 9;
    `);
    downgrade.close();

    const migrated = new DynaStore({ databasePath: migrationPath, clock: () => new Date(now) });
    const legacyRetry = migrated.addAnnotation(
      legacyView,
      legacyItem.id,
      legacyRequestId,
      "Preserve this v9 note.",
    );
    assert.equal(legacyRetry.annotationId, legacyCreated.annotationId);
    assert.equal(legacyRetry.deduplicated, true);
    migrated.close();
    const migratedDatabase = new DatabaseSync(migrationPath, { readOnly: true });
    assert.equal(migratedDatabase.prepare("PRAGMA user_version").get().user_version, 11);
    assert.deepEqual(
      {
        ...migratedDatabase
          .prepare("SELECT updated_at, version, deleted_at FROM annotations WHERE id = ?")
          .get(legacyCreated.annotationId),
      },
      { updated_at: now, version: 1, deleted_at: null },
    );
    assert.equal(
      migratedDatabase.prepare("SELECT COUNT(*) AS total FROM annotation_events").get().total,
      1,
    );
    migratedDatabase.close();

    const corruptPath = join(directory, "dyna-corrupt-v10.sqlite3");
    const current = new DynaStore({ databasePath: corruptPath, clock: () => new Date(now) });
    current.close();
    const corrupt = new DatabaseSync(corruptPath);
    corrupt.exec(`
      DROP TABLE annotation_events;
      CREATE TABLE annotation_events (
        id TEXT, annotation_id TEXT, item_id TEXT, operation TEXT,
        result_version INTEGER, occurred_at TEXT, occurred_at_ms INTEGER
      );
    `);
    corrupt.close();
    assert.throws(
      () => new DynaStore({ databasePath: corruptPath, clock: () => new Date(now) }),
      /annotation ledger annotation_events is invalid/i,
    );

    globalThis.process.stdout.write(
      JSON.stringify({
        exactRetry: true,
        conflictRejected: true,
        scoped: true,
        membershipRace: true,
        optimisticEdit: true,
        sharedDashboardEdit: true,
        softDelete: true,
        appendOnlyEvents: true,
        v9MigrationReplay: true,
        corruptV10Rejected: true,
      }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

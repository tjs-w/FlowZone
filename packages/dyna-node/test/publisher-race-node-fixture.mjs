import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
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
      store.publish(workerData.publisherId, workerData.secret, [], {
        runId: workerData.runId,
        sourceCompletedAt: now,
        mode: "upsert",
        status: "succeeded",
      });
      parentPort?.postMessage({ published: true });
    } catch (error) {
      parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      store.close();
      parentPort?.close();
    }
  });
} else {
  const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-publisher-race-"));
  const databasePath = join(directory, "dyna.sqlite3");
  try {
    const seed = new DynaStore({ databasePath, clock: () => new Date(now) });
    const revoked = seed.createPublisher("Revocation race");
    const rotated = seed.createPublisher("Rotation race");
    seed.close();

    async function assertBlockedPublicationFails(publisher, runId, mutate) {
      const worker = new Worker(new URL(import.meta.url), {
        workerData: {
          databasePath,
          publisherId: publisher.publisher.id,
          secret: publisher.secret,
          runId,
        },
      });
      const [ready] = await once(worker, "message");
      assert.equal(ready.ready, true);

      const writer = new DatabaseSync(databasePath, { timeout: 5_000 });
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;");
      mutate(writer, publisher.publisher.id);
      worker.postMessage({ publish: true });
      await delay(50);
      writer.exec("COMMIT");
      writer.close();

      const [result] = await once(worker, "message");
      assert.match(result.error, /credentials are invalid/);
      await once(worker, "exit");
    }

    await assertBlockedPublicationFails(revoked, "revoke-race", (writer, publisherId) => {
      writer.prepare("UPDATE publishers SET revoked_at = ? WHERE id = ?").run(now, publisherId);
    });
    await assertBlockedPublicationFails(rotated, "rotate-race", (writer, publisherId) => {
      writer
        .prepare("UPDATE publishers SET token_hash = ? WHERE id = ?")
        .run(Buffer.alloc(32, 7), publisherId);
    });

    globalThis.process.stdout.write(JSON.stringify({ revokeRace: true, rotateRace: true }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

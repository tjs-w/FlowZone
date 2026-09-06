import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DynaStore } from "../src/store.ts";

const now = "2026-09-03T20:00:00.000Z";
const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-backup-"));
const databasePath = join(directory, "dyna.sqlite3");
const backupDirectory = join(directory, "private-backups");
const backupPath = join(backupDirectory, "executive's-backup.sqlite3");
const restoredPath = join(directory, "restored.sqlite3");

try {
  mkdirSync(backupDirectory, { mode: 0o700 });
  const store = new DynaStore({ databasePath, clock: () => new Date(now) });
  const dashboard = store.createDashboard("Backup", "Point-in-time restore");
  const { publisher, secret } = store.createPublisher(
    "Backup schedule",
    undefined,
    undefined,
    "local_preview",
  );
  store.bindSchedule(dashboard.id, publisher.id, {
    id: "backup-schedule",
    title: "Backup schedule",
    state: "active",
    staleAfterMinutes: 60,
  });
  store.publish(
    publisher.id,
    secret,
    [
      {
        externalId: "backup-item",
        sourceRef: {
          source: "gitlab",
          instanceId: "corp",
          projectPath: "team/project",
          iid: 7,
          entityType: "merge_request",
        },
        sourceScope: "team/project",
        title: "Persist me",
        summary: "This record must survive an offline restore.",
        priority: "high",
        priorityReason: "Restore verification.",
        sourceUpdatedAt: now,
        labels: ["backup"],
      },
    ],
    { runId: "backup-run", sourceCompletedAt: now, mode: "replace", status: "succeeded" },
  );

  assert.equal(
    store.backup(backupPath),
    join(realpathSync(backupDirectory), "executive's-backup.sqlite3"),
  );
  assert.equal(statSync(backupDirectory).mode & 0o777, 0o700);
  assert.equal(statSync(backupPath).mode & 0o777, 0o600);
  assert.throws(() => store.backup(backupPath), /already exists/);

  const linkedTarget = join(backupDirectory, "linked-target.sqlite3");
  symlinkSync(databasePath, linkedTarget);
  assert.throws(() => store.backup(linkedTarget), /already exists/);
  unlinkSync(linkedTarget);

  const realDirectory = join(directory, "real-private-backups");
  const linkedDirectory = join(directory, "linked-private-backups");
  mkdirSync(realDirectory, { mode: 0o700 });
  symlinkSync(realDirectory, linkedDirectory);
  assert.throws(
    () => store.backup(join(linkedDirectory, "backup.sqlite3")),
    /must be a private regular directory/,
  );

  const verified = new DatabaseSync(backupPath, { readOnly: true });
  assert.equal(verified.prepare("PRAGMA user_version").get().user_version, 4);
  assert.equal(verified.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.deepEqual(verified.prepare("PRAGMA foreign_key_check").all(), []);
  verified.close();
  store.close();

  // Restore is deliberately offline: the source connection is closed before the
  // verified snapshot is copied into a different database path.
  copyFileSync(backupPath, restoredPath);
  chmodSync(restoredPath, 0o600);
  const restored = new DynaStore({ databasePath: restoredPath, clock: () => new Date(now) });
  const snapshot = restored.snapshot(dashboard.id);
  assert.equal(snapshot.cards.length, 1);
  assert.equal(snapshot.cards[0]?.title, "Persist me");
  restored.close();

  globalThis.process.stdout.write(
    JSON.stringify({ backupVerified: true, offlineRestore: true, privatePermissions: true }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

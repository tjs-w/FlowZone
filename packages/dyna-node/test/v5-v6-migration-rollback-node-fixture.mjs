import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DynaStore } from "../src/store.ts";

const instant = "2026-09-10T20:00:00.000Z";

function createTrueVersionFive(databasePath, scenario) {
  const seed = new DynaStore({ databasePath, clock: () => new Date(instant) });
  const dashboard = seed.createDashboard("Migration rollback", "Fail-closed v5 backfill");
  const { publisher, secret } = seed.createPublisher(
    "Migration source",
    undefined,
    undefined,
    "local_preview",
  );
  seed.bindSchedule(dashboard.id, publisher.id, {
    id: `migration-${scenario}`,
    title: "Migration source",
    state: "active",
    staleAfterMinutes: 60,
  });
  seed.publish(
    publisher.id,
    secret,
    [
      {
        externalId: `migration-${scenario}`,
        sourceRef: {
          source: "gitlab",
          instanceId: "gitlab.example.com",
          projectPath: "team/service",
          iid: scenario === "unmapped" ? 501 : 502,
          entityType: "merge_request",
        },
        sourceScope: "team/service",
        title: "Preserve every pending action",
        summary: "Unsafe backfills must fail without data loss.",
        priority: "normal",
        priorityReason: "Migration integrity coverage",
        sourceUpdatedAt: instant,
        labels: [],
      },
    ],
    {
      runId: `run-${scenario}`,
      sourceCompletedAt: instant,
      mode: "replace",
      status: "succeeded",
    },
  );
  const snapshot = seed.snapshot(dashboard.id);
  const item = snapshot.cards[0];
  assert.ok(item);
  const viewToken = seed.createView(dashboard.id);
  seed.prepareAction(viewToken, "open_source", {
    itemId: item.id,
    expectedRevision: snapshot.revision,
    expectedFingerprint: item.fingerprint,
    idempotencyKey: "duplicate-sensitive-key",
  });
  seed.close();

  const database = new DatabaseSync(databasePath);
  database.exec(`
    ALTER TABLE action_requests RENAME TO action_requests_v6_seed;
    CREATE TABLE action_requests (
      id TEXT PRIMARY KEY, view_token_hash BLOB NOT NULL, dashboard_id TEXT,
      kind TEXT NOT NULL, item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
      item_fingerprint TEXT, dashboard_revision INTEGER, task_id TEXT, host_id TEXT,
      idempotency_key TEXT, state TEXT NOT NULL, claim_token_hash BLOB, claim_expires_at TEXT,
      result_task_id TEXT, failure_message TEXT, uncertain_effect INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO action_requests (
      id, view_token_hash, dashboard_id, kind, item_id, item_fingerprint,
      dashboard_revision, task_id, host_id, idempotency_key, state,
      claim_token_hash, claim_expires_at, result_task_id, failure_message,
      uncertain_effect, expires_at, created_at, updated_at
    )
    SELECT id, view_token_hash, NULL, kind, item_id, item_fingerprint,
      dashboard_revision, task_id, host_id, idempotency_key, state,
      claim_token_hash, claim_expires_at, result_task_id, failure_message,
      uncertain_effect, expires_at, created_at, updated_at
    FROM action_requests_v6_seed;
    DROP TABLE action_requests_v6_seed;
    DROP TABLE cli_requests;
    DROP TABLE work_updates;
    PRAGMA user_version = 5;
  `);
  if (scenario === "duplicate") {
    database
      .prepare(
        `INSERT INTO action_requests (
           id, view_token_hash, dashboard_id, kind, item_id, item_fingerprint,
           dashboard_revision, task_id, host_id, idempotency_key, state,
           claim_token_hash, claim_expires_at, result_task_id, failure_message,
           uncertain_effect, expires_at, created_at, updated_at
         )
         SELECT ?, view_token_hash, NULL, kind, item_id, item_fingerprint,
           dashboard_revision, task_id, host_id, idempotency_key, state,
           claim_token_hash, claim_expires_at, result_task_id, failure_message,
           uncertain_effect, expires_at, created_at, updated_at
         FROM action_requests LIMIT 1`,
      )
      .run(randomUUID());
  } else {
    database.exec("DELETE FROM view_sessions;");
  }
  const expectedActions = scenario === "duplicate" ? 2 : 1;
  assert.equal(
    database.prepare("SELECT COUNT(*) AS total FROM action_requests").get().total,
    expectedActions,
  );
  database.close();
  chmodSync(databasePath, 0o600);
  return expectedActions;
}

function assertMigrationRollsBack(scenario) {
  const directory = mkdtempSync(join(tmpdir(), `flowzone-dyna-v5-${scenario}-`));
  const databasePath = join(directory, "dyna.sqlite3");
  try {
    const expectedActions = createTrueVersionFive(databasePath, scenario);
    assert.throws(() => new DynaStore({ databasePath }));

    const verified = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(verified.prepare("PRAGMA user_version").get().user_version, 5);
    assert.equal(
      verified.prepare("SELECT COUNT(*) AS total FROM action_requests").get().total,
      expectedActions,
    );
    assert.equal(
      verified
        .prepare("PRAGMA table_info(action_requests)")
        .all()
        .find((column) => column.name === "dashboard_id")?.notnull,
      0,
    );
    assert.equal(
      verified
        .prepare(
          `SELECT COUNT(*) AS total FROM sqlite_schema
           WHERE type = 'table' AND name IN (
             'action_requests_v6_migration', 'work_updates', 'cli_requests'
           )`,
        )
        .get().total,
      0,
    );
    verified.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

assertMigrationRollsBack("unmapped");
assertMigrationRollsBack("duplicate");

globalThis.process.stdout.write(
  JSON.stringify({ unmappedRollback: true, duplicateIdempotencyRollback: true }),
);

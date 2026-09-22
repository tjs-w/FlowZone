import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DynaStore } from "../src/store.ts";

const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-v11-v12-"));
const databasePath = join(directory, "dyna.sqlite3");

try {
  const current = new DynaStore({ databasePath });
  current.close();

  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    ALTER TABLE item_preferences DROP COLUMN backlog_until;
    ALTER TABLE item_preferences DROP COLUMN backlogged_at;
    PRAGMA user_version = 11;
  `);
  legacy.close();

  const migrated = new DynaStore({ databasePath });
  migrated.close();

  const verified = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(verified.prepare("PRAGMA user_version").get().user_version, 12);
  const columns = new Set(
    verified
      .prepare("PRAGMA table_info(item_preferences)")
      .all()
      .map((row) => row.name),
  );
  assert.equal(columns.has("backlogged_at"), true);
  assert.equal(columns.has("backlog_until"), true);
  verified.close();
  globalThis.process.stdout.write(JSON.stringify({ migrated: true }));
} finally {
  rmSync(directory, { recursive: true, force: true });
}

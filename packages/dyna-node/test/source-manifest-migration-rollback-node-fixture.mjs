import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DynaStore } from "../src/store.ts";

const now = "2026-09-06T20:00:00.000Z";
const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-manifest-migration-rollback-"));
const databasePath = join(directory, "dyna.sqlite3");

try {
  const seed = new DynaStore({ databasePath, clock: () => new Date(now) });
  seed.close();

  const corruptVersionOne = new DatabaseSync(databasePath);
  corruptVersionOne.exec("PRAGMA foreign_keys = OFF");
  corruptVersionOne.exec("ALTER TABLE publishers DROP COLUMN required_source_slices");
  corruptVersionOne
    .prepare("INSERT INTO dashboard_publishers (dashboard_id, publisher_id) VALUES (?, ?)")
    .run("missing-dashboard", "missing-publisher");
  corruptVersionOne.exec("PRAGMA user_version = 1");
  corruptVersionOne.close();

  assert.throws(
    () => new DynaStore({ databasePath, clock: () => new Date(now) }),
    /invalid relationships.*migration was rolled back/,
  );

  const unchanged = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(unchanged.prepare("PRAGMA user_version").get().user_version, 1);
  assert.equal(
    unchanged
      .prepare("PRAGMA table_info(publishers)")
      .all()
      .some((column) => column.name === "required_source_slices"),
    false,
  );
  assert.equal(
    unchanged.prepare("SELECT COUNT(*) AS total FROM dashboard_publishers").get().total,
    1,
  );
  unchanged.close();

  globalThis.process.stdout.write(JSON.stringify({ versionOneMigrationRolledBack: true }));
} finally {
  rmSync(directory, { recursive: true, force: true });
}

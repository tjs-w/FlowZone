import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DynaStore } from "../src/store.ts";

const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-schema-version-"));
const databasePath = join(directory, "future.sqlite3");

try {
  const future = new DatabaseSync(databasePath);
  future.exec("PRAGMA user_version = 3");
  future.close();
  chmodSync(databasePath, 0o600);

  assert.throws(
    () => new DynaStore({ databasePath }),
    /newer FlowZone version.*cannot be opened safely/,
  );

  const unchanged = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(unchanged.prepare("PRAGMA user_version").get().user_version, 3);
  assert.equal(unchanged.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
  assert.equal(
    unchanged.prepare("SELECT COUNT(*) AS total FROM sqlite_schema WHERE type = 'table'").get()
      .total,
    0,
  );
  unchanged.close();

  globalThis.process.stdout.write(JSON.stringify({ futureVersionRejected: true }));
} finally {
  rmSync(directory, { recursive: true, force: true });
}

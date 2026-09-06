import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DynaStore } from "../src/store.ts";

const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-schedule-limit-"));
const databasePath = join(directory, "dyna.sqlite3");

try {
  const store = new DynaStore({ databasePath });
  const dashboard = store.createDashboard("Schedules", "Cardinality guard");
  const first = store.createPublisher("Schedule 0");
  store.bindSchedule(dashboard.id, first.publisher.id, {
    id: "schedule-0",
    title: "Schedule 0",
    state: "active",
    staleAfterMinutes: 60,
  });
  store.bindSchedule(dashboard.id, first.publisher.id, {
    id: "schedule-0",
    title: "Schedule 0 renamed",
    state: "paused",
    staleAfterMinutes: 90,
  });
  assert.throws(
    () =>
      store.bindSchedule(dashboard.id, first.publisher.id, {
        id: "schedule-replacement",
        title: "Replacement",
        state: "active",
        staleAfterMinutes: 60,
      }),
    /identifier is immutable/,
  );

  const duplicate = store.createPublisher("Duplicate native schedule");
  assert.throws(
    () =>
      store.bindSchedule(dashboard.id, duplicate.publisher.id, {
        id: "schedule-0",
        title: "Duplicate",
        state: "active",
        staleAfterMinutes: 60,
      }),
    /already registered/,
  );

  for (let index = 1; index < 50; index += 1) {
    const created = store.createPublisher(`Schedule ${index}`, {
      id: `schedule-${index}`,
      title: `Schedule ${index}`,
      state: "active",
      staleAfterMinutes: 60,
    });
    store.bindSchedule(dashboard.id, created.publisher.id, {
      id: `schedule-${index}`,
      title: `Schedule ${index}`,
      state: "active",
      staleAfterMinutes: 60,
    });
  }

  const overflow = store.createPublisher("Schedule overflow", {
    id: "schedule-50",
    title: "Schedule 50",
    state: "active",
    staleAfterMinutes: 60,
  });
  assert.throws(
    () =>
      store.bindSchedule(dashboard.id, overflow.publisher.id, {
        id: "schedule-50",
        title: "Schedule 50",
        state: "active",
        staleAfterMinutes: 60,
      }),
    /cannot bind more than 50 schedules/,
  );
  assert.equal(store.snapshot(dashboard.id).schedules.length, 50);
  store.close();

  const raw = new DatabaseSync(databasePath);
  assert.throws(
    () =>
      raw.prepare("UPDATE publishers SET schedule_id = NULL WHERE id = ?").run(first.publisher.id),
    /identifiers are immutable/,
  );
  assert.equal(
    raw
      .prepare(
        `SELECT COUNT(*) AS total FROM dashboard_publishers dp
         JOIN publishers p ON p.id = dp.publisher_id
         WHERE dp.dashboard_id = ? AND p.schedule_id IS NULL`,
      )
      .get(dashboard.id).total,
    0,
  );
  assert.equal(
    raw
      .prepare(
        `SELECT COUNT(*) AS total FROM dashboard_publishers dp
         JOIN publishers p ON p.id = dp.publisher_id
         WHERE dp.dashboard_id = ?`,
      )
      .get(dashboard.id).total,
    50,
  );
  raw
    .prepare("INSERT INTO dashboard_publishers (dashboard_id, publisher_id) VALUES (?, ?)")
    .run(dashboard.id, overflow.publisher.id);
  raw.exec("PRAGMA user_version = 0");
  raw.close();

  assert.throws(
    () => new DynaStore({ databasePath }),
    /more than 50 schedules.*reduce its bindings before upgrading/,
  );
  const unchanged = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(unchanged.prepare("PRAGMA user_version").get().user_version, 0);
  assert.equal(
    unchanged
      .prepare("SELECT COUNT(*) AS total FROM dashboard_publishers WHERE dashboard_id = ?")
      .get(dashboard.id).total,
    51,
  );
  unchanged.close();

  globalThis.process.stdout.write(JSON.stringify({ immutable: true, unique: true, maximum: 50 }));
} finally {
  rmSync(directory, { recursive: true, force: true });
}

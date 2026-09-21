import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadDynaApplicationService } from "./application-service-test-bundle.mjs";

const { serviceModule, cleanup } = await loadDynaApplicationService();
const { DynaApplicationCapabilityError, DynaApplicationService } = serviceModule;

const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-application-"));
const databasePath = join(directory, "dyna.sqlite3");

try {
  const admin = new DynaApplicationService({ databasePath });
  const dashboard = admin.createDashboard("Executive", "Bounded capability test");
  admin.close();

  const reader = new DynaApplicationService({
    databasePath,
    actor: { kind: "codex_task", capabilities: ["dashboard:read"] },
  });
  assert.deepEqual(
    reader.listDashboards().dashboards.map(({ id }) => id),
    [dashboard.id],
  );
  assert.equal(reader.showDashboard(dashboard.id).name, "Executive");
  assert.throws(
    () => reader.createDashboard("Denied", "Must not reach SQLite"),
    (error) =>
      error instanceof DynaApplicationCapabilityError &&
      error.code === "capability_denied" &&
      error.actorKind === "codex_task" &&
      error.capability === "dashboard:manage",
  );
  reader.close();

  const verifier = new DynaApplicationService({ databasePath });
  assert.equal(verifier.listDashboards().total, 1);
  verifier.close();

  const worker = new DynaApplicationService({
    databasePath,
    actor: { kind: "codex_task", capabilities: ["todo:create"] },
  });
  const created = worker.createTodo(dashboard.id, {
    requestId: "10000000-0000-4000-8000-000000000001",
    title: "Record the durable result",
    priority: "normal",
    labels: ["test"],
  });
  assert.equal(created.schema, "dyna/todo-create-result-v2");
  assert.equal(Number.isSafeInteger(created.itemNumber), true);
  assert.throws(
    () => worker.searchItems(dashboard.id, "", "active"),
    (error) => error instanceof DynaApplicationCapabilityError && error.capability === "item:read",
  );
  assert.throws(
    () => worker.listDashboards(),
    (error) =>
      error instanceof DynaApplicationCapabilityError && error.capability === "dashboard:read",
  );
  worker.close();

  assert.throws(
    () =>
      new DynaApplicationService({
        databasePath,
        actor: {
          kind: "codex_task",
          capabilities: ["item:read", "item:read"],
        },
      }),
    /capabilities are invalid/u,
  );
  assert.throws(
    () =>
      new DynaApplicationService({
        databasePath,
        actor: { kind: "codex_task", capabilities: ["arbitrary:sql"] },
      }),
    /capabilities are invalid/u,
  );

  globalThis.process.stdout.write(
    JSON.stringify({
      boundedRead: true,
      deniedBeforePersistence: true,
      todoCreateIsolation: true,
      invalidDescriptorsRejected: true,
    }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
  cleanup();
}

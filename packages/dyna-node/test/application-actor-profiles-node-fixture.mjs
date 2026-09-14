import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadDynaApplicationService } from "./application-service-test-bundle.mjs";

const { serviceModule, cleanup } = await loadDynaApplicationService();
const { DynaApplicationCapabilityError, DynaApplicationService } = serviceModule;

const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-actor-profiles-"));
const databasePath = join(directory, "dyna.sqlite3");
let fixedProfileRejected = false;
let codexTaskDeniedController = false;
let controllerAllowed = false;

try {
  let invalidPublisher;
  try {
    invalidPublisher = new DynaApplicationService({
      databasePath,
      actor: { kind: "publisher", capabilities: ["dashboard:manage"] },
    });
  } catch (error) {
    fixedProfileRejected =
      error instanceof TypeError || error instanceof DynaApplicationCapabilityError;
  } finally {
    invalidPublisher?.close();
  }

  const admin = new DynaApplicationService({ databasePath });
  const dashboard = admin.createDashboard("Actor profiles", "Controller authority fixture");
  const item = admin.createTodo(dashboard.id, {
    requestId: randomUUID(),
    title: "Controller-only status update",
    priority: "normal",
    labels: [],
  });
  admin.close();

  const worker = new DynaApplicationService({
    databasePath,
    actor: { kind: "codex_task", capabilities: ["item:write"] },
  });
  try {
    worker.updateTask(dashboard.id, item.itemId, {
      taskId: "task-reported-success",
      hostId: "local",
      title: "Unverified worker report",
      state: "succeeded",
      statusUpdatedAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      outcome: "A task-authored update must not certify completion.",
    });
  } catch (error) {
    codexTaskDeniedController =
      error instanceof DynaApplicationCapabilityError && error.capability === "task:observe";
  } finally {
    worker.close();
  }

  let controller;
  try {
    controller = new DynaApplicationService({
      databasePath,
      actor: { kind: "controller", capabilities: ["task:observe"] },
    });
    controller.updateTask(dashboard.id, item.itemId, {
      taskId: "controller-verified-success",
      hostId: "local",
      title: `:${String(item.itemNumber)}: Controller-verified task`,
      state: "succeeded",
      statusUpdatedAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      outcome: "Controller verified completion.",
    });
    controllerAllowed = true;
  } catch {
    controllerAllowed = false;
  } finally {
    controller?.close();
  }

  globalThis.process.stdout.write(
    JSON.stringify({ fixedProfileRejected, codexTaskDeniedController, controllerAllowed }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
  cleanup();
}

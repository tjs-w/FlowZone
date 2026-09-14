import { SqliteDynaRepository } from "../src/repository.ts";

const [databasePath, dashboardId, requestId, title] = globalThis.process.argv.slice(2);
if (!databasePath || !dashboardId || !requestId || !title) {
  throw new Error("The concurrent item-number fixture arguments are incomplete.");
}

const repository = new SqliteDynaRepository({ databasePath });
try {
  const result = repository.createTodoFromCli(dashboardId, {
    requestId,
    title,
    priority: "normal",
    labels: [],
  });
  globalThis.process.stdout.write(
    JSON.stringify({ itemId: result.itemId, itemNumber: result.itemNumber }),
  );
} finally {
  repository.close();
}

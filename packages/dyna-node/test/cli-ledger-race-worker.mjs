import { DynaStore } from "../src/store.ts";

const [databasePath, dashboardId, itemId, fingerprint, requestId, workAttemptId] =
  globalThis.process.argv.slice(2);
if (!databasePath || !dashboardId || !itemId || !fingerprint || !requestId || !workAttemptId) {
  globalThis.process.exit(2);
}
const store = new DynaStore({ databasePath });
try {
  const result = store.recordWorkUpdate(dashboardId, itemId, fingerprint, {
    requestId,
    workAttemptId,
    kind: "note",
    body: "One logical concurrent work update.",
    artifacts: [],
  });
  globalThis.process.stdout.write(JSON.stringify(result));
} finally {
  store.close();
}

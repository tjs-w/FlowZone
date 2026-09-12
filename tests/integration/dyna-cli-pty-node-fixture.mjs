import { DynaStore } from "../../packages/dyna-node/src/store.ts";

const [mode, databasePath, dashboardId, itemId] = globalThis.process.argv.slice(2);
if (!databasePath) throw new Error("Expected a database path.");
const store = new DynaStore({ databasePath });
try {
  if (mode === "setup") {
    const dashboard = store.createDashboard("PTY", "Dyna update PTY test");
    const { publisher, secret } = store.createPublisher(
      "PTY source",
      undefined,
      undefined,
      "local_preview",
    );
    store.bindSchedule(dashboard.id, publisher.id, {
      id: "dyna-pty-schedule",
      title: "Dyna PTY schedule",
      state: "active",
      staleAfterMinutes: 60,
    });
    const now = new Date().toISOString();
    store.publish(
      publisher.id,
      secret,
      [
        {
          externalId: "dyna-pty-item",
          sourceRef: {
            source: "gitlab",
            instanceId: "gitlab.example.com",
            projectPath: "team/service",
            iid: 101,
            entityType: "merge_request",
          },
          sourceScope: "team/service",
          title: "PTY work update",
          summary: "Ensure terminal privacy.",
          priority: "normal",
          priorityReason: "Test",
          sourceUpdatedAt: now,
          labels: [],
        },
      ],
      {
        runId: "dyna-pty-run",
        sourceCompletedAt: now,
        mode: "replace",
        status: "succeeded",
      },
    );
    const item = store.snapshot(dashboard.id).cards[0];
    if (!item) throw new Error("Dyna PTY fixture item is missing.");
    globalThis.process.stdout.write(
      JSON.stringify({
        dashboardId: dashboard.id,
        itemId: item.id,
        fingerprint: item.fingerprint,
      }),
    );
  } else if (mode === "snapshot" && dashboardId && itemId) {
    globalThis.process.stdout.write(
      JSON.stringify({ body: store.showItem(dashboardId, itemId).item.workUpdates[0]?.body }),
    );
  } else {
    throw new Error("Expected setup or snapshot mode.");
  }
} finally {
  store.close();
}

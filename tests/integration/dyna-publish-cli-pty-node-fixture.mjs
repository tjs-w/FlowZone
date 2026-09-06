import process from "node:process";

import { DynaStore } from "../../packages/dyna-node/src/store.ts";

const [mode, databasePath, dashboardId] = process.argv.slice(2);
if (!databasePath) throw new Error("Expected a database path.");

const store = new DynaStore({ databasePath });
try {
  if (mode === "setup") {
    const sourceSlices = [{ source: "codex", sourceScope: "codex:local" }];
    const dashboard = store.createDashboard("PTY", "PTY publisher test");
    const created = store.createPublisher(
      "Scheduled PTY",
      { id: "pty-schedule", title: "PTY schedule", state: "active" },
      sourceSlices,
      "local_cli",
    );
    store.bindSchedule(dashboard.id, created.publisher.id, {
      id: "pty-schedule",
      title: "PTY schedule",
      state: "active",
      staleAfterMinutes: 60,
      requiredSourceSlices: sourceSlices,
    });
    process.stdout.write(
      JSON.stringify({ dashboardId: dashboard.id, publisherId: created.publisher.id }),
    );
  } else if (mode === "snapshot" && dashboardId) {
    process.stdout.write(
      JSON.stringify({ summary: store.snapshot(dashboardId).cards[0]?.summary }),
    );
  } else {
    throw new Error("Expected setup or snapshot mode.");
  }
} finally {
  store.close();
}

import assert from "node:assert/strict";

import { DynaStore } from "../src/store.ts";

const now = "2026-09-03T20:00:00.000Z";
const store = new DynaStore({ databasePath: ":memory:", clock: () => new Date(now) });

try {
  const dashboards = [];
  for (let index = 0; index < 100; index += 1) {
    dashboards.push(store.createDashboard(`Dashboard ${String(index + 1)}`, "Capacity fixture"));
  }
  store.updateDashboard(dashboards[0].id, { archived: true });
  assert.equal(store.listDashboards().length, 100);
  assert.throws(
    () => store.createDashboard("Dashboard 101", "Must be rejected"),
    /cannot create more than 100 dashboards/,
  );

  const publishers = [];
  for (let index = 0; index < 100; index += 1) {
    publishers.push(store.createPublisher(`Publisher ${String(index + 1)}`).publisher);
  }
  store.revokePublisher(publishers[0].id, false);
  assert.equal(store.listPublishers().length, 100);
  assert.throws(
    () => store.createPublisher("Publisher 101"),
    /cannot create more than 100 publishers/,
  );

  const dashboard = dashboards[1];
  const viewToken = store.createView(dashboard.id);
  const todo = {
    title: "Capacity-bound to-do",
    priority: "normal",
    labels: [],
  };
  assert.throws(
    () => store.addTodo(viewToken, todo, "59623796-d73c-4597-8cd6-28a960bd82b0"),
    /cannot create more than 100 publishers/,
  );
  assert.equal(store.snapshot(dashboard.id).cards.length, 0);

  store.revokePublisher(publishers[0].id, true);
  const todoId = store.addTodo(viewToken, todo, "59623796-d73c-4597-8cd6-28a960bd82b0");
  assert.equal(store.snapshot(dashboard.id).cards[0]?.id, todoId);
  assert.equal(store.listPublishers().length, 99);
  assert.throws(
    () => store.createPublisher("Publisher after manual slot"),
    /cannot create more than 100 publishers/,
  );

  globalThis.process.stdout.write(
    JSON.stringify({
      dashboardMaximum: 100,
      archivedDashboardCounted: true,
      publisherMaximum: 100,
      revokedPublisherCounted: true,
      manualPublisherCounted: true,
      failedTodoRolledBack: true,
    }),
  );
} finally {
  store.close();
}

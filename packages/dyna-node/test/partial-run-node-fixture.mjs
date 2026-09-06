import assert from "node:assert/strict";

import { DynaStore } from "../src/store.ts";

let clockMs = Date.now();
const store = new DynaStore({ databasePath: ":memory:", clock: () => new Date(clockMs) });

function item(externalId, iid, title, sourceUpdatedAt) {
  return {
    externalId,
    sourceRef: {
      source: "gitlab",
      instanceId: "test",
      projectPath: "group/project",
      iid,
      entityType: "merge_request",
    },
    sourceScope: "group/project",
    title,
    summary: `${title} summary`,
    priority: "high",
    priorityReason: "Release is waiting.",
    sourceUpdatedAt,
    labels: [],
  };
}

try {
  const dashboard = store.createDashboard("Partial run", "Preserve successful source slices");
  const { publisher, secret } = store.createPublisher("Executive rollup");
  store.bindSchedule(dashboard.id, publisher.id, {
    id: "executive-rollup",
    title: "Executive rollup",
    state: "active",
    staleAfterMinutes: 60,
  });

  const initialAt = new Date(clockMs).toISOString();
  store.publish(
    publisher.id,
    secret,
    [
      item("project!1", 1, "Original review", initialAt),
      item("project!2", 2, "Retain me", initialAt),
    ],
    {
      runId: "complete-1",
      sourceCompletedAt: initialAt,
      mode: "replace",
      status: "succeeded",
    },
  );

  clockMs += 1_000;
  const partialAt = new Date(clockMs).toISOString();
  const partial = store.publish(
    publisher.id,
    secret,
    [item("project!1", 1, "Updated review", partialAt)],
    {
      runId: "partial-1",
      sourceCompletedAt: partialAt,
      mode: "upsert",
      status: "partial",
      failureMessage: "Outlook could not be read; GitLab results are current.",
    },
  );

  assert.equal(partial.status, "partial");
  assert.equal(partial.accepted, 1);
  const snapshot = store.snapshot(dashboard.id);
  assert.equal(snapshot.freshness, "stale");
  assert.equal(snapshot.cards.length, 2);
  assert.ok(snapshot.cards.some((card) => card.title === "Updated review"));
  assert.ok(snapshot.cards.some((card) => card.title === "Retain me"));
  const [schedule] = snapshot.schedules;
  assert.equal(schedule?.lastRunStatus, "partial");
  assert.match(schedule?.lastRunError ?? "", /Outlook/);

  assert.throws(
    () =>
      store.publish(publisher.id, secret, [item("project!3", 3, "Unsafe replace", partialAt)], {
        runId: "partial-replace",
        sourceCompletedAt: new Date(clockMs + 1_000).toISOString(),
        mode: "replace",
        status: "partial",
        failureMessage: "One source failed.",
      }),
    /requires upsert mode/,
  );

  globalThis.process.stdout.write(
    JSON.stringify({
      appliedSuccessfulSlice: true,
      retainedPreviousSlice: true,
      visiblyStale: true,
    }),
  );
} finally {
  store.close();
}

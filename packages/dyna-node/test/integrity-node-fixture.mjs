import assert from "node:assert/strict";

import { DynaStore } from "../src/store.ts";

const now = "2026-09-03T20:00:00.000Z";
const store = new DynaStore({ databasePath: ":memory:", clock: () => new Date(now) });

try {
  const dashboardA = store.createDashboard("A", "Primary");
  const dashboardB = store.createDashboard("B", "Neighbor");
  const { publisher, secret } = store.createPublisher("Shared schedule");
  for (const dashboard of [dashboardA, dashboardB]) {
    store.bindSchedule(dashboard.id, publisher.id, {
      id: "shared",
      title: "Shared schedule",
      state: "active",
      staleAfterMinutes: 60,
    });
  }
  const sourceRef = {
    source: "gitlab",
    instanceId: "corp",
    projectPath: "team/project",
    iid: 7,
    entityType: "merge_request",
  };
  store.publish(
    publisher.id,
    secret,
    [
      {
        externalId: "mr-7",
        sourceRef,
        sourceScope: "team/project",
        title: "Original signal",
        summary: "Owned by the first publisher.",
        priority: "normal",
        priorityReason: "Needs review.",
        sourceUpdatedAt: now,
        labels: [],
      },
      {
        externalId: "mr-8",
        sourceRef: { ...sourceRef, iid: 8 },
        sourceScope: "team/project",
        title: "Second signal",
        summary: "Ordering peer.",
        priority: "normal",
        priorityReason: "Needs review.",
        sourceUpdatedAt: now,
        labels: [],
      },
    ],
    { runId: "shared-1", sourceCompletedAt: now, mode: "replace", status: "succeeded" },
  );

  const initialA = store.snapshot(dashboardA.id);
  const initialB = store.snapshot(dashboardB.id);
  const item = initialA.cards.find((card) => card.title === "Original signal");
  assert.ok(item);
  const viewA = store.createView(dashboardA.id);
  assert.deepEqual(
    store.organizeItem(viewA, item.id, "bump", initialA.revision, item.fingerprint),
    { changed: true },
  );
  assert.equal(
    store.snapshot(dashboardA.id).cards.find((card) => card.id === item.id)?.priority,
    "high",
  );
  assert.equal(
    store.snapshot(dashboardB.id).cards.find((card) => card.id === item.id)?.priority,
    "normal",
  );
  assert.equal(store.snapshot(dashboardB.id).revision, initialB.revision);

  const todoRequestId = "4a495488-8223-4b42-b516-120bea757755";
  const todoInput = { title: "Retry-safe to-do", priority: "normal", labels: [] };
  const firstTodo = store.addTodo(viewA, todoInput, todoRequestId);
  assert.equal(store.addTodo(viewA, todoInput, todoRequestId), firstTodo);
  assert.throws(
    () => store.addTodo(viewA, { ...todoInput, title: "Different" }, todoRequestId),
    /reused with different content/,
  );

  assert.throws(
    () =>
      store.applyEnrichment(item.id, {
        expectedFingerprint: "0".repeat(64),
        summary: "Stale analysis",
        provenance: "test",
      }),
    /retrieve its latest context/,
  );
  store.applyEnrichment(item.id, {
    expectedFingerprint: item.fingerprint,
    people: [
      {
        displayName: "Verified VP",
        leadershipLevel: "vp",
        relationship: "neighboring_org",
        involvement: "sender",
        provenance: "twg_org_tree",
        confidence: "high",
      },
    ],
    provenance: "verified-org-lookup",
  });
  assert.equal(
    store.snapshot(dashboardB.id).cards.find((card) => card.id === item.id)?.priority,
    "high",
  );
  store.applyEnrichment(item.id, {
    expectedFingerprint: item.fingerprint,
    summary: "Fresh replacement overlay",
    provenance: "replacement-analysis",
  });
  const replacedOverlay = store.snapshot(dashboardB.id).cards.find((card) => card.id === item.id);
  assert.equal(replacedOverlay?.priority, "normal");
  assert.deepEqual(replacedOverlay?.people, []);

  store.upsertTaskStatus(item.id, {
    taskId: "done",
    hostId: "local",
    title: "Completed session",
    state: "succeeded",
    outcome: "Decision recorded.",
    statusUpdatedAt: now,
    observedAt: now,
  });
  store.upsertTaskStatus(item.id, {
    taskId: "active",
    hostId: "local",
    title: "Active session",
    state: "running",
    statusUpdatedAt: now,
    observedAt: now,
  });
  assert.equal(
    store.snapshot(dashboardA.id).cards.find((card) => card.id === item.id)?.workflowState,
    "executing",
  );
  store.upsertTaskStatus(item.id, {
    taskId: "failed",
    hostId: "local",
    title: "Failed session",
    state: "failed",
    statusUpdatedAt: now,
    observedAt: now,
  });
  assert.equal(
    store.snapshot(dashboardA.id).cards.find((card) => card.id === item.id)?.workflowState,
    "attention",
  );
  store.upsertTaskStatus(item.id, {
    taskId: "waiting",
    hostId: "local",
    title: "Waiting session",
    state: "waiting",
    statusUpdatedAt: now,
    observedAt: now,
  });
  assert.equal(
    store.snapshot(dashboardA.id).cards.find((card) => card.id === item.id)?.workflowState,
    "paused",
  );

  const second = store.createPublisher("Untrusted second publisher");
  store.bindSchedule(dashboardB.id, second.publisher.id, {
    id: "second",
    title: "Second",
    state: "active",
    staleAfterMinutes: 60,
  });
  store.publish(
    second.publisher.id,
    second.secret,
    [
      {
        externalId: "spoof",
        sourceRef,
        sourceScope: "team/project",
        title: "Spoofed replacement",
        summary: "Must not overwrite the first publisher.",
        priority: "critical",
        priorityReason: "Untrusted urgency.",
        sourceUpdatedAt: "2026-09-03T20:00:01.000Z",
        labels: [],
      },
    ],
    {
      runId: "second-1",
      sourceCompletedAt: "2026-09-03T20:00:01.000Z",
      mode: "replace",
      status: "succeeded",
    },
  );
  assert.equal(
    store.snapshot(dashboardA.id).cards.some((card) => card.title === "Spoofed replacement"),
    false,
  );
  assert.equal(store.snapshot(dashboardB.id).cards.length, 3);

  const searchDashboard = store.createDashboard("Search", "Bounded window");
  const bulk = store.createPublisher("Bulk");
  const needle = store.createPublisher("Needle");
  for (const source of [bulk.publisher, needle.publisher]) {
    store.bindSchedule(searchDashboard.id, source.id, {
      id: source.id,
      title: source.name,
      state: "active",
      staleAfterMinutes: 60,
    });
  }
  store.publish(
    bulk.publisher.id,
    bulk.secret,
    Array.from({ length: 200 }, (_, index) => ({
      externalId: `bulk-${index}`,
      sourceRef: { ...sourceRef, iid: 1_000 + index },
      sourceScope: "team/project",
      title: `Critical signal ${index}`,
      summary: "Fills the default bounded window.",
      priority: "critical",
      priorityReason: "Test fixture.",
      sourceUpdatedAt: now,
      labels: [],
    })),
    { runId: "bulk-1", sourceCompletedAt: now, mode: "replace", status: "succeeded" },
  );
  store.publish(
    needle.publisher.id,
    needle.secret,
    [
      {
        externalId: "needle",
        sourceRef: { ...sourceRef, iid: 9_999 },
        sourceScope: "team/project",
        title: "Needle Alpha",
        summary: "Must remain searchable outside the default card window.",
        priority: "normal",
        priorityReason: "Test fixture.",
        sourceUpdatedAt: now,
        labels: [],
      },
    ],
    { runId: "needle-1", sourceCompletedAt: now, mode: "replace", status: "succeeded" },
  );
  const bounded = store.snapshot(searchDashboard.id);
  assert.equal(bounded.counts.total, 201);
  assert.equal(bounded.cards.length, 200);
  const found = store.snapshot(searchDashboard.id, "needle alpha");
  assert.equal(found.counts.total, 1);
  assert.equal(found.cards[0]?.title, "Needle Alpha");

  globalThis.process.stdout.write(
    JSON.stringify({ isolated: true, idempotent: true, aggregate: true, search: true }),
  );
} finally {
  store.close();
}

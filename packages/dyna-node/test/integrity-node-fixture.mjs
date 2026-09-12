import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { DynaStore } from "../src/store.ts";

const now = "2026-09-03T20:00:00.000Z";
const store = new DynaStore({ databasePath: ":memory:", clock: () => new Date(now) });

try {
  const dashboardA = store.createDashboard("A", "Primary");
  const dashboardB = store.createDashboard("B", "Neighbor");
  const { publisher, secret } = store.createPublisher(
    "Shared schedule",
    undefined,
    undefined,
    "local_preview",
  );
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
  const afterTodo = store.snapshot(dashboardA.id);
  const manualTodo = afterTodo.cards.find((card) => card.id === firstTodo);
  assert.ok(manualTodo);
  assert.throws(
    () =>
      store.prepareAction(viewA, "open_source", {
        itemId: manualTodo.id,
        expectedRevision: afterTodo.revision,
        expectedFingerprint: manualTodo.fingerprint,
        idempotencyKey: "e713c319-a25a-4aab-b0d7-481591dd99dc",
      }),
    /no originating source to open/,
  );

  assert.throws(
    () =>
      store.applyEnrichment(item.id, {
        expectedFingerprint: "0".repeat(64),
        expectedEnrichmentVersion: 0,
        summary: "Stale analysis",
        provenance: "test",
      }),
    /retrieve its latest context/,
  );
  store.applyEnrichment(item.id, {
    expectedFingerprint: item.fingerprint,
    expectedEnrichmentVersion: 0,
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
  assert.throws(
    () =>
      store.applyEnrichment(item.id, {
        expectedFingerprint: item.fingerprint,
        expectedEnrichmentVersion: 0,
        summary: "Conflicting replacement",
        provenance: "stale-writer",
      }),
    /enrichment changed/,
  );
  store.applyEnrichment(item.id, {
    expectedFingerprint: item.fingerprint,
    expectedEnrichmentVersion: 1,
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
    "attention",
  );
  const secondItem = initialA.cards.find((card) => card.title === "Second signal");
  assert.ok(secondItem);
  store.upsertTaskStatus(secondItem.id, {
    taskId: "waiting-only",
    hostId: "local",
    title: "Waiting-only session",
    state: "waiting",
    statusUpdatedAt: now,
    observedAt: now,
  });
  assert.equal(
    store.snapshot(dashboardA.id).cards.find((card) => card.id === secondItem.id)?.workflowState,
    "paused",
  );
  const completedAt = "2026-09-03T20:00:01.000Z";
  store.upsertTaskStatus(secondItem.id, {
    taskId: "waiting-only",
    hostId: "local",
    title: "Waiting-only session",
    state: "succeeded",
    outcome: "The queued decision was completed.",
    statusUpdatedAt: completedAt,
    observedAt: completedAt,
  });
  const activeNormal = store.snapshot(dashboardB.id).cards.find((card) => card.id === item.id);
  assert.equal(activeNormal?.canMoveEarlier, false);
  assert.equal(activeNormal?.canMoveLater, false);

  const nextSourceTime = "2026-09-03T20:00:02.000Z";
  store.publish(
    publisher.id,
    secret,
    [
      {
        externalId: "mr-7",
        sourceRef,
        sourceScope: "team/project",
        title: "Original signal",
        summary: "New source content must supersede stale enrichment.",
        priority: "normal",
        priorityReason: "Needs a fresh review.",
        sourceUpdatedAt: nextSourceTime,
        labels: [],
      },
    ],
    {
      runId: "shared-2",
      sourceCompletedAt: nextSourceTime,
      mode: "replace",
      status: "succeeded",
    },
  );
  const staleCard = store.snapshot(dashboardA.id).cards.find((card) => card.id === item.id);
  assert.equal(staleCard?.summary, "New source content must supersede stale enrichment.");
  assert.equal(staleCard?.enrichmentState, "stale");
  const staleContext = store.itemContext(item.id);
  assert.equal(staleContext.summary, "New source content must supersede stale enrichment.");
  assert.equal(staleContext.enrichment?.state, "stale");
  assert.equal(staleContext.enrichment?.version, 2);

  const second = store.createPublisher(
    "Untrusted second publisher",
    undefined,
    undefined,
    "local_preview",
  );
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
  assert.equal(store.snapshot(dashboardB.id).cards.length, 2);
  const beforeUnbind = store.snapshot(dashboardB.id).revision;
  store.unbindSchedule(dashboardB.id, second.publisher.id);
  assert.equal(store.snapshot(dashboardB.id).revision, beforeUnbind + 1);
  assert.equal(
    store.snapshot(dashboardB.id).cards.some((card) => card.title === "Spoofed replacement"),
    false,
  );
  const rotatedSecret = store.rotatePublisherSecret(second.publisher.id);
  assert.throws(
    () =>
      store.publish(second.publisher.id, second.secret, [], {
        runId: "rejected-old-secret",
        sourceCompletedAt: "2026-09-03T20:00:03.000Z",
        mode: "upsert",
        status: "succeeded",
      }),
    /credentials are invalid/,
  );
  store.revokePublisher(second.publisher.id, false);
  assert.equal(
    store.listPublishers().find(({ id }) => id === second.publisher.id)?.scheduleState,
    "unknown",
  );
  assert.throws(
    () =>
      store.publish(second.publisher.id, rotatedSecret, [], {
        runId: "rejected-revoked-publisher",
        sourceCompletedAt: "2026-09-03T20:00:04.000Z",
        mode: "upsert",
        status: "succeeded",
      }),
    /credentials are invalid/,
  );
  const disposable = store.createDashboard("Disposable", "Purge test");
  assert.throws(() => store.purgeDashboard(disposable.id, dashboardA.id), /confirmation/);
  store.purgeDashboard(disposable.id, disposable.id);
  assert.throws(() => store.getDashboard(disposable.id), /not found/);

  const searchDashboard = store.createDashboard("Search", "Bounded window");
  const bulk = store.createPublisher("Bulk", undefined, undefined, "local_preview");
  const needle = store.createPublisher("Needle", undefined, undefined, "local_preview");
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
      {
        externalId: "needle-beta",
        sourceRef: { ...sourceRef, iid: 10_000 },
        sourceScope: "team/project",
        title: "Needle Beta",
        summary: "A sequencing peer outside the default card window.",
        priority: "normal",
        priorityReason: "Test fixture.",
        sourceUpdatedAt: now,
        labels: [],
      },
    ],
    { runId: "needle-1", sourceCompletedAt: now, mode: "replace", status: "succeeded" },
  );
  const bounded = store.snapshot(searchDashboard.id);
  assert.equal(bounded.counts.total, 202);
  assert.equal(bounded.cards.length, 200);
  const found = store.snapshot(searchDashboard.id, "needle alpha");
  assert.equal(found.counts.total, 1);
  assert.equal(found.cards[0]?.title, "Needle Alpha");
  assert.equal(Boolean(found.cards[0]?.canMoveEarlier || found.cards[0]?.canMoveLater), true);
  const searchView = store.createView(searchDashboard.id);
  const needles = store.snapshot(searchDashboard.id, "needle");
  const movable = needles.cards.find((card) => card.canMoveLater) ?? needles.cards[0];
  assert.ok(movable);
  assert.deepEqual(
    store.organizeItem(
      searchView,
      movable.id,
      movable.canMoveLater ? "later" : "earlier",
      needles.revision,
      movable.fingerprint,
    ),
    { changed: true },
  );
  const afterSequence = store.snapshot(searchDashboard.id, "needle alpha");
  const alpha = afterSequence.cards[0];
  assert.ok(alpha);
  assert.deepEqual(
    store.organizeItem(searchView, alpha.id, "bump", afterSequence.revision, alpha.fingerprint),
    { changed: true },
  );
  assert.equal(store.snapshot(searchDashboard.id, "needle alpha").cards[0]?.priority, "high");
  const beforePlacement = store.snapshot(searchDashboard.id, "needle");
  const placedAlpha = beforePlacement.cards.find((card) => card.title === "Needle Alpha");
  const placedBeta = beforePlacement.cards.find((card) => card.title === "Needle Beta");
  assert.ok(placedAlpha);
  assert.ok(placedBeta);
  assert.deepEqual(
    store.placeItem(
      searchView,
      placedBeta.id,
      "high",
      placedAlpha.id,
      beforePlacement.revision,
      placedBeta.fingerprint,
    ),
    { changed: true },
  );
  const afterPlacement = store.snapshot(searchDashboard.id, "needle");
  assert.deepEqual(
    afterPlacement.cards.map((card) => [card.title, card.priority]),
    [
      ["Needle Beta", "high"],
      ["Needle Alpha", "high"],
    ],
  );

  const bulkDashboard = store.createDashboard("Bulk", "Atomic priority-group changes");
  const bulkView = store.createView(bulkDashboard.id);
  for (const [title, priority] of [
    ["Critical one", "critical"],
    ["Critical two", "critical"],
    ["High one", "high"],
    ["Target one", "normal"],
    ["Target two", "normal"],
    ["Low one", "low"],
    ["Low two", "low"],
  ]) {
    store.addTodo(bulkView, { title, priority, labels: [] }, randomUUID());
  }
  const beforeBulk = store.snapshot(bulkDashboard.id);
  const selectedTitles = new Set(["Critical two", "High one", "Target two", "Low one"]);
  const selectedCards = beforeBulk.cards.filter((card) => selectedTitles.has(card.title));
  assert.equal(selectedCards.length, selectedTitles.size);
  const existingTargetOrder = beforeBulk.cards
    .filter((card) => card.priority === "normal")
    .map((card) => card.id);
  const incomingOrder = beforeBulk.cards
    .filter((card) => selectedTitles.has(card.title) && card.priority !== "normal")
    .map((card) => card.id);
  const remainingSourceOrders = new Map(
    ["critical", "high", "low"].map((priority) => [
      priority,
      beforeBulk.cards
        .filter((card) => card.priority === priority && !incomingOrder.includes(card.id))
        .map((card) => card.id),
    ]),
  );
  assert.deepEqual(
    store.groupItems(
      bulkView,
      selectedCards.map((card) => ({
        itemId: card.id,
        expectedFingerprint: card.fingerprint,
      })),
      "normal",
      beforeBulk.revision,
    ),
    { changed: true, changedCount: 3 },
  );
  const afterBulk = store.snapshot(bulkDashboard.id);
  assert.equal(afterBulk.revision, beforeBulk.revision + 1);
  assert.deepEqual(
    afterBulk.cards.filter((card) => card.priority === "normal").map((card) => card.id),
    [...existingTargetOrder, ...incomingOrder],
  );
  for (const [priority, expectedIds] of remainingSourceOrders) {
    assert.deepEqual(
      afterBulk.cards.filter((card) => card.priority === priority).map((card) => card.id),
      expectedIds,
    );
  }
  for (const itemId of incomingOrder) {
    const event = store.itemHistory(bulkDashboard.id, itemId).organization[0];
    assert.equal(event?.priority, "normal");
    assert.match(event?.action ?? "", /^(bump|lower)$/);
  }
  const targetSelected = afterBulk.cards.find((card) => card.title === "Target two");
  assert.ok(targetSelected);
  assert.equal(
    store.itemHistory(bulkDashboard.id, targetSelected.id).organization[0]?.action,
    "resequence",
  );
  assert.deepEqual(
    store.groupItems(
      bulkView,
      [{ itemId: targetSelected.id, expectedFingerprint: targetSelected.fingerprint }],
      "normal",
      afterBulk.revision,
    ),
    { changed: false, changedCount: 0 },
  );
  assert.equal(store.snapshot(bulkDashboard.id).revision, afterBulk.revision);

  const staleRevisionCandidate = afterBulk.cards.find((card) => card.priority === "low");
  assert.ok(staleRevisionCandidate);
  assert.throws(
    () =>
      store.groupItems(
        bulkView,
        [
          {
            itemId: staleRevisionCandidate.id,
            expectedFingerprint: staleRevisionCandidate.fingerprint,
          },
        ],
        "critical",
        afterBulk.revision - 1,
      ),
    /dashboard changed/,
  );
  assert.equal(store.snapshot(bulkDashboard.id).revision, afterBulk.revision);

  const staleAttempt = store.snapshot(bulkDashboard.id);
  const staleCandidates = staleAttempt.cards
    .filter((card) => card.priority !== "critical")
    .slice(0, 2);
  assert.equal(staleCandidates.length, 2);
  assert.throws(
    () =>
      store.groupItems(
        bulkView,
        staleCandidates.map((card, index) => ({
          itemId: card.id,
          expectedFingerprint: index === 0 ? card.fingerprint : "0".repeat(64),
        })),
        "critical",
        staleAttempt.revision,
      ),
    /selected Dyna item changed/,
  );
  assert.equal(store.snapshot(bulkDashboard.id).revision, staleAttempt.revision);
  assert.deepEqual(
    store.snapshot(bulkDashboard.id).cards.map((card) => [card.id, card.priority]),
    staleAttempt.cards.map((card) => [card.id, card.priority]),
  );

  const foreignDashboard = store.createDashboard("Foreign", "Membership guard");
  const foreignView = store.createView(foreignDashboard.id);
  const foreignId = store.addTodo(
    foreignView,
    { title: "Foreign item", priority: "low", labels: [] },
    randomUUID(),
  );
  const foreignCard = store
    .snapshot(foreignDashboard.id)
    .cards.find((card) => card.id === foreignId);
  assert.ok(foreignCard);
  const membershipAttempt = store.snapshot(bulkDashboard.id);
  const localCandidate = membershipAttempt.cards.find((card) => card.priority === "low");
  assert.ok(localCandidate);
  assert.throws(
    () =>
      store.groupItems(
        bulkView,
        [
          { itemId: localCandidate.id, expectedFingerprint: localCandidate.fingerprint },
          { itemId: foreignCard.id, expectedFingerprint: foreignCard.fingerprint },
        ],
        "high",
        membershipAttempt.revision,
      ),
    /active, unfinished queue items/,
  );
  assert.equal(store.snapshot(bulkDashboard.id).revision, membershipAttempt.revision);
  assert.equal(
    store.snapshot(bulkDashboard.id).cards.find((card) => card.id === localCandidate.id)?.priority,
    "low",
  );

  const completionCandidate = store
    .snapshot(bulkDashboard.id)
    .cards.find((card) => card.priority === "low");
  assert.ok(completionCandidate);
  store.setItemStatus({
    viewToken: bulkView,
    itemId: completionCandidate.id,
    targetStage: "done",
    outcome: "No further work remains.",
    expectedRevision: store.snapshot(bulkDashboard.id).revision,
    expectedFingerprint: completionCandidate.fingerprint,
    clientRequestId: randomUUID(),
  });
  const completedAttempt = store.snapshot(bulkDashboard.id);
  const activeCandidate = completedAttempt.cards.find(
    (card) => card.id !== completionCandidate.id && card.priority === "normal",
  );
  const completedCard = completedAttempt.cards.find((card) => card.id === completionCandidate.id);
  assert.ok(activeCandidate);
  assert.ok(completedCard);
  assert.throws(
    () =>
      store.groupItems(
        bulkView,
        [
          { itemId: activeCandidate.id, expectedFingerprint: activeCandidate.fingerprint },
          { itemId: completedCard.id, expectedFingerprint: completedCard.fingerprint },
        ],
        "critical",
        completedAttempt.revision,
      ),
    /active, unfinished queue items/,
  );
  assert.equal(store.snapshot(bulkDashboard.id).revision, completedAttempt.revision);
  assert.equal(
    store.snapshot(bulkDashboard.id).cards.find((card) => card.id === activeCandidate.id)?.priority,
    "normal",
  );

  assert.throws(
    () =>
      store.groupItems(
        bulkView,
        [
          { itemId: activeCandidate.id, expectedFingerprint: activeCandidate.fingerprint },
          { itemId: activeCandidate.id, expectedFingerprint: activeCandidate.fingerprint },
        ],
        "critical",
        completedAttempt.revision,
      ),
    /only once/,
  );
  assert.equal(store.snapshot(bulkDashboard.id).revision, completedAttempt.revision);

  globalThis.process.stdout.write(
    JSON.stringify({
      isolated: true,
      idempotent: true,
      aggregate: true,
      search: true,
      dragPlacement: true,
      bulkGrouping: true,
    }),
  );
} finally {
  store.close();
}

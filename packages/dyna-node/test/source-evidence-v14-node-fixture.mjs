import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { DynaStore } from "../src/store.ts";

let now = Date.parse("2026-09-27T12:00:00.000Z");
const clock = () => new Date(now);
const stamp = () => clock().toISOString();
const store = new DynaStore({ databasePath: ":memory:", clock });
const jira = {
  source: "twg",
  contextId: "jira.example.com",
  resultType: "jira",
  recordId: "LIN-3087",
};
const mr = (iid) => ({
  source: "gitlab",
  instanceId: "gitlab.example.com",
  projectPath: "team/service",
  entityType: "merge_request",
  iid,
});
const relationship = {
  kind: "references_jira_issue",
  target: jira,
  evidence: { field: "mr_reference", exactValue: "LIN-3087" },
};
const record = (externalId, sourceRef, title, relationships = []) => ({
  externalId,
  sourceRef,
  sourceScope: sourceRef.source === "twg" ? "jira" : "team/service",
  title,
  summary: title,
  priority: "high",
  priorityReason: "Decision required",
  sourceUpdatedAt: stamp(),
  labels: [],
  relationships,
});
try {
  const dashboard = store.createDashboard("Evidence", "Correlated sources");
  const { publisher, secret } = store.createPublisher(
    "collector",
    undefined,
    undefined,
    "local_preview",
  );
  store.bindSchedule(dashboard.id, publisher.id, {
    id: "source-evidence-schedule",
    title: "Sources",
    state: "active",
    staleAfterMinutes: 60,
  });
  const first = record("mr-1", mr(11), "Release change", [relationship]);
  store.publish(publisher.id, secret, [first], {
    runId: "first",
    sourceCompletedAt: stamp(),
    mode: "replace",
    status: "succeeded",
  });
  const initial = store.snapshot(dashboard.id);
  assert.equal(initial.cards.length, 1);
  const original = initial.cards[0];
  assert.equal(original.sources.length, 1);

  now += 60_000;
  const issue = record("issue", jira, "LIN-3087 release decision");
  const second = record("mr-2", mr(12), "Second release change", [relationship]);
  store.publish(publisher.id, secret, [first, issue, second], {
    runId: "second",
    sourceCompletedAt: stamp(),
    mode: "replace",
    status: "succeeded",
    workSummaries: [
      {
        workIdentity: jira,
        summary: "Two release MRs need one decision.",
        evidenceRefs: [mr(11), jira, mr(12)],
      },
    ],
  });
  const combined = store.snapshot(dashboard.id);
  assert.equal(combined.cards.length, 1);
  const card = combined.cards[0];
  assert.equal(card.id, original.id);
  assert.equal(card.itemNumber, original.itemNumber);
  assert.equal(card.sources.length, 3);
  assert.equal(card.summary, "Two release MRs need one decision.");
  assert.equal(card.citedSummaryState, "current");
  assert.equal(card.groupingEvidence.length, 2);
  assert.equal(store.snapshot(dashboard.id, "LIN-3087").cards.length, 1);

  now += 60_000;
  store.publish(publisher.id, secret, [], {
    runId: "failed",
    sourceCompletedAt: stamp(),
    mode: "upsert",
    status: "failed",
    failureMessage: "Collector unavailable",
  });
  const failed = store.snapshot(dashboard.id).cards[0];
  assert.equal(failed.id, original.id);
  assert.equal(failed.sources.length, 3);
  assert.equal(failed.sourceState, "last_known");
  assert.equal(failed.citedSummaryState, "last_known");
  assert.equal(failed.fingerprint, card.fingerprint);

  now += 60_000;
  store.publish(publisher.id, secret, [], {
    runId: "retired",
    sourceCompletedAt: stamp(),
    mode: "replace",
    status: "succeeded",
  });
  const noCurrent = store.snapshot(dashboard.id).cards[0];
  assert.equal(noCurrent.id, original.id);
  assert.equal(noCurrent.sourceState, "none");
  assert.equal(
    noCurrent.sources.every((source) => source.freshness === "retired"),
    true,
  );
  assert.equal(noCurrent.citedSummaryState, "last_known");

  now += 60_000;
  const unrelated = record("mr-3", mr(13), "Second release change");
  store.publish(publisher.id, secret, [unrelated], {
    runId: "unrelated",
    sourceCompletedAt: stamp(),
    mode: "upsert",
    status: "succeeded",
  });
  assert.equal(store.snapshot(dashboard.id).cards.length, 2);
  const other = store
    .snapshot(dashboard.id)
    .cards.find((candidate) => candidate.id !== original.id);
  assert.ok(other);
  const view = store.createView(dashboard.id);
  store.addAnnotation(view, other.id, randomUUID(), "Keep this source-specific decision.");
  now += 60_000;
  store.publish(
    publisher.id,
    secret,
    [{ ...unrelated, sourceUpdatedAt: stamp(), relationships: [relationship] }],
    {
      runId: "later-proof",
      sourceCompletedAt: stamp(),
      mode: "upsert",
      status: "succeeded",
    },
  );
  const consolidated = store.snapshot(dashboard.id);
  assert.equal(consolidated.cards.length, 1);
  assert.equal(consolidated.cards[0].id, original.id);
  assert.equal(store.showItem(dashboard.id, other.id).item.id, original.id);
  assert.equal(
    consolidated.cards[0].annotations.some(
      (note) => note.body === "Keep this source-specific decision.",
    ),
    true,
  );
  assert.equal(
    store
      .itemHistory(dashboard.id, original.id)
      .annotationEvents.some((event) => event.itemId === other.id),
    true,
  );
  const correction = store.correctSourcesForView({
    viewToken: view,
    itemId: original.id,
    action: "undo_merge",
    aliasItemId: other.id,
    expectedRevision: consolidated.revision,
    expectedFingerprint: consolidated.cards[0].fingerprint,
    clientRequestId: randomUUID(),
  });
  assert.equal(correction.separatedItemId, other.id);
  const restored = store.snapshot(dashboard.id);
  assert.equal(restored.cards.length, 2);
  assert.equal(
    restored.cards.find((candidate) => candidate.id === other.id)?.itemNumber,
    other.itemNumber,
  );
  assert.equal(
    restored.cards.find((candidate) => candidate.id === other.id)?.annotations[0]?.body,
    "Keep this source-specific decision.",
  );
  assert.equal(
    store
      .itemHistory(dashboard.id, original.id)
      .annotationEvents.some((event) => event.itemId === other.id),
    false,
  );
  now += 60_000;
  store.publish(
    publisher.id,
    secret,
    [{ ...unrelated, sourceUpdatedAt: stamp(), relationships: [relationship] }],
    {
      runId: "after-correction",
      sourceCompletedAt: stamp(),
      mode: "upsert",
      status: "succeeded",
    },
  );
  assert.equal(store.snapshot(dashboard.id).cards.length, 2);
  now += 60_000;
  const email = {
    source: "email",
    provider: "Proton",
    accountId: "inbox",
    messageId: "exact-email-1",
  };
  const emailRecord = {
    ...record("mail-1", email, "Decision mail", [
      {
        kind: "links_to_record",
        target: mr(11),
        evidence: {
          field: "message_link",
          exactValue: "https://gitlab.example.com/team/service/-/merge_requests/11",
        },
      },
    ]),
    sourceScope: "inbox",
  };
  store.publish(publisher.id, secret, [emailRecord], {
    runId: "email-proof",
    sourceCompletedAt: stamp(),
    mode: "upsert",
    status: "succeeded",
  });
  const withEmail = store.snapshot(dashboard.id);
  const anchored = withEmail.cards.find((candidate) => candidate.id === original.id);
  assert.ok(anchored);
  assert.equal(anchored.sources.length, 4);
  const sourceAction = store.prepareAction(view, "open_source", {
    itemId: original.id,
    sourceRef: email,
    expectedRevision: withEmail.revision,
    expectedFingerprint: anchored.fingerprint,
    idempotencyKey: randomUUID(),
  });
  store.markDelivered(view, sourceAction.id);
  assert.deepEqual(store.claimAction(sourceAction.id).context.item?.sourceRef, email);

  now += 60_000;
  const otherJira = { ...jira, recordId: "LIN-3099" };
  const ambiguous = record("mr-conflict", mr(14), "Ambiguous release change", [
    relationship,
    {
      ...relationship,
      target: otherJira,
      evidence: { field: "mr_reference", exactValue: "LIN-3099" },
    },
  ]);
  store.publish(publisher.id, secret, [ambiguous], {
    runId: "conflicting-keys",
    sourceCompletedAt: stamp(),
    mode: "upsert",
    status: "succeeded",
  });
  const afterConflict = store.snapshot(dashboard.id);
  assert.equal(afterConflict.cards.length, 3);
  assert.equal(
    afterConflict.cards.find((candidate) => candidate.title === "Ambiguous release change")
      ?.sources[0]?.correlationWarning,
    true,
  );
  const reverseStore = new DynaStore({ databasePath: ":memory:", clock });
  try {
    const reverseDashboard = reverseStore.createDashboard("Jira first", "Arrival order");
    const { publisher: reversePublisher, secret: reverseSecret } = reverseStore.createPublisher(
      "reverse collector",
      undefined,
      undefined,
      "local_preview",
    );
    reverseStore.bindSchedule(reverseDashboard.id, reversePublisher.id, {
      id: "reverse-schedule",
      title: "Reverse source order",
      state: "active",
      staleAfterMinutes: 60,
    });
    reverseStore.publish(reversePublisher.id, reverseSecret, [issue], {
      runId: "jira-first",
      sourceCompletedAt: stamp(),
      mode: "upsert",
      status: "succeeded",
    });
    const jiraFirst = reverseStore.snapshot(reverseDashboard.id).cards[0];
    now += 60_000;
    reverseStore.publish(reversePublisher.id, reverseSecret, [first, second], {
      runId: "mrs-later",
      sourceCompletedAt: stamp(),
      mode: "upsert",
      status: "succeeded",
    });
    const jiraThenMrs = reverseStore.snapshot(reverseDashboard.id);
    assert.equal(jiraThenMrs.cards.length, 1);
    assert.equal(jiraThenMrs.cards[0].id, jiraFirst.id);
    assert.equal(jiraThenMrs.cards[0].itemNumber, jiraFirst.itemNumber);
    assert.equal(jiraThenMrs.cards[0].sources.length, 3);
  } finally {
    reverseStore.close();
  }
  process.stdout.write(
    JSON.stringify({
      correlated: true,
      jiraFirstCorrelated: true,
      stable: true,
      staleRetained: true,
      noCurrentRetained: true,
      titleNotMerged: true,
      lateMergeAlias: true,
      correctionRestored: true,
      exactSourceAction: true,
      conflictingKeysWarned: true,
    }) + "\n",
  );
} finally {
  store.close();
}

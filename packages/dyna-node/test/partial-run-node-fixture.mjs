import assert from "node:assert/strict";

import { DynaStore } from "../src/store.ts";

let clockMs = Date.now();
const store = new DynaStore({ databasePath: ":memory:", clock: () => new Date(clockMs) });

const gitLabScope = "gitlab:corp/group/project";
const outlookScope = "outlook:executive@example.com";
const slackScope = "slack:executive-workspace/release-room";

function gitLabItem(externalId, iid, title, sourceUpdatedAt) {
  return {
    externalId,
    sourceRef: {
      source: "gitlab",
      instanceId: "corp",
      projectPath: "group/project",
      iid,
      entityType: "merge_request",
    },
    sourceScope: gitLabScope,
    title,
    summary: `${title} summary`,
    priority: "high",
    priorityReason: "Release is waiting.",
    sourceUpdatedAt,
    labels: [],
  };
}

function outlookItem(externalId, messageId, title, sourceUpdatedAt) {
  return {
    externalId,
    sourceRef: {
      source: "outlook",
      accountId: "executive@example.com",
      messageId,
    },
    sourceScope: outlookScope,
    title,
    summary: `${title} summary`,
    priority: "normal",
    priorityReason: "A direct response is requested.",
    sourceUpdatedAt,
    labels: [],
  };
}

function slackItem(externalId, messageId, title, sourceUpdatedAt) {
  return {
    externalId,
    sourceRef: {
      source: "slack",
      workspaceId: "executive-workspace",
      channelId: "release-room",
      messageId,
    },
    sourceScope: slackScope,
    title,
    summary: `${title} summary`,
    priority: "normal",
    priorityReason: "The release room needs an answer.",
    sourceUpdatedAt,
    labels: [],
  };
}

try {
  const dashboard = store.createDashboard("Partial run", "Preserve failed source slices");
  const { publisher, secret } = store.createPublisher(
    "Executive rollup",
    undefined,
    undefined,
    "local_preview",
  );
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
      gitLabItem("gitlab!1", 1, "Original review", initialAt),
      gitLabItem("gitlab!2", 2, "Retire missing GitLab review", initialAt),
      outlookItem("outlook:1", "mail-1", "Preserve Outlook decision", initialAt),
      outlookItem("outlook:2", "mail-2", "Preserve another Outlook decision", initialAt),
      slackItem("slack:1", "message-1", "Retire missing Slack request", initialAt),
    ],
    {
      runId: "complete-1",
      sourceCompletedAt: initialAt,
      mode: "replace",
      status: "succeeded",
    },
  );

  // The original global partial API remains an upsert and preserves all unseen records.
  clockMs += 1_000;
  const legacyPartialAt = new Date(clockMs).toISOString();
  const legacyPartial = store.publish(
    publisher.id,
    secret,
    [gitLabItem("gitlab!1", 1, "Legacy partial update", legacyPartialAt)],
    {
      runId: "legacy-partial",
      sourceCompletedAt: legacyPartialAt,
      mode: "upsert",
      status: "partial",
      failureMessage: "Outlook could not be read; GitLab results are current.",
    },
  );
  assert.equal(legacyPartial.accepted, 1);
  assert.equal(store.snapshot(dashboard.id).cards.length, 5);
  assert.throws(
    () =>
      store.publish(
        publisher.id,
        secret,
        [gitLabItem("gitlab!1", 1, "Unsafe legacy replace", legacyPartialAt)],
        {
          runId: "legacy-partial-replace",
          sourceCompletedAt: new Date(clockMs + 1_000).toISOString(),
          mode: "replace",
          status: "partial",
          failureMessage: "One source failed.",
        },
      ),
    /requires upsert mode/,
  );

  assert.throws(
    () =>
      store.publish(
        publisher.id,
        secret,
        [gitLabItem("slack:1", 99, "Move Slack identity into GitLab", legacyPartialAt)],
        {
          runId: "cross-successful-slice-external-id",
          sourceCompletedAt: new Date(clockMs + 1_000).toISOString(),
          mode: "replace",
          status: "succeeded",
          sourceSlices: [
            { source: "gitlab", sourceScope: gitLabScope, status: "succeeded" },
            { source: "slack", sourceScope: slackScope, status: "succeeded" },
          ],
        },
      ),
    /cannot move an external ID between source slices/,
  );
  assert.equal(store.snapshot(dashboard.id).cards.length, 5);

  clockMs += 1_000;
  const partialAt = new Date(clockMs).toISOString();
  const sourceSlices = [
    { source: "gitlab", sourceScope: gitLabScope, status: "succeeded" },
    { source: "outlook", sourceScope: outlookScope, status: "failed" },
    { source: "slack", sourceScope: slackScope, status: "succeeded" },
  ];
  const sourceAwarePartial = {
    runId: "source-aware-partial",
    sourceCompletedAt: partialAt,
    mode: "replace",
    status: "partial",
    failureMessage: "Outlook could not be read; GitLab and Slack results are current.",
    sourceSlices,
  };
  const partial = store.publish(
    publisher.id,
    secret,
    [gitLabItem("gitlab!1", 1, "Current GitLab review", partialAt)],
    sourceAwarePartial,
  );

  assert.equal(partial.status, "partial");
  assert.equal(partial.accepted, 1);
  const snapshot = store.snapshot(dashboard.id);
  assert.equal(snapshot.freshness, "stale");
  assert.deepEqual(
    snapshot.cards.map((card) => card.title).sort(),
    [
      "Current GitLab review",
      "Preserve Outlook decision",
      "Preserve another Outlook decision",
    ].sort(),
  );
  const [schedule] = snapshot.schedules;
  assert.equal(schedule?.lastRunStatus, "partial");
  assert.match(schedule?.lastRunError ?? "", /Outlook/);

  const retry = store.publish(
    publisher.id,
    secret,
    [gitLabItem("gitlab!1", 1, "Current GitLab review", partialAt)],
    sourceAwarePartial,
  );
  assert.equal(retry.deduplicated, true);
  assert.equal(retry.superseded, false);

  assert.throws(
    () =>
      store.publish(
        publisher.id,
        secret,
        [outlookItem("outlook:new", "mail-new", "Unsafe failed-slice item", partialAt)],
        {
          ...sourceAwarePartial,
          runId: "item-from-failed-slice",
          sourceCompletedAt: new Date(clockMs + 1_000).toISOString(),
        },
      ),
    /only for a declared successful slice/,
  );
  assert.throws(
    () =>
      store.publish(publisher.id, secret, [gitLabItem("gitlab!1", 1, "Wrong mode", partialAt)], {
        ...sourceAwarePartial,
        runId: "source-aware-upsert",
        sourceCompletedAt: new Date(clockMs + 1_000).toISOString(),
        mode: "upsert",
      }),
    /requires replace mode/,
  );
  assert.throws(
    () =>
      store.publish(
        publisher.id,
        secret,
        [gitLabItem("outlook:1", 99, "Attempt to overwrite a failed slice", partialAt)],
        {
          ...sourceAwarePartial,
          runId: "cross-slice-external-id",
          sourceCompletedAt: new Date(clockMs + 1_000).toISOString(),
        },
      ),
    /cannot move an external ID between source slices/,
  );
  assert.deepEqual(
    store
      .snapshot(dashboard.id)
      .cards.map((card) => card.title)
      .sort(),
    snapshot.cards.map((card) => card.title).sort(),
  );
  assert.throws(
    () =>
      store.publish(publisher.id, secret, [], {
        runId: "mismatched-status",
        sourceCompletedAt: new Date(clockMs + 1_000).toISOString(),
        mode: "replace",
        status: "succeeded",
        sourceSlices,
      }),
    /must have status partial/,
  );

  const superseded = store.publish(
    publisher.id,
    secret,
    [gitLabItem("gitlab!3", 3, "Delayed stale GitLab review", legacyPartialAt)],
    {
      runId: "delayed-source-aware-run",
      sourceCompletedAt: legacyPartialAt,
      mode: "replace",
      status: "succeeded",
      sourceSlices: [{ source: "gitlab", sourceScope: gitLabScope, status: "succeeded" }],
    },
  );
  assert.equal(superseded.superseded, true);
  assert.deepEqual(
    store
      .snapshot(dashboard.id)
      .cards.map((card) => card.title)
      .sort(),
    snapshot.cards.map((card) => card.title).sort(),
  );

  globalThis.process.stdout.write(
    JSON.stringify({
      legacyCompatible: true,
      successfulSlicesReplaced: true,
      failedSlicesPreserved: true,
      visiblyStale: true,
      idempotent: true,
      ordered: true,
      successfulCrossSliceMoveRejected: true,
    }),
  );
} finally {
  store.close();
}

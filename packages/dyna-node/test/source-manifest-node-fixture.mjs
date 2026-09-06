import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DynaStore } from "../src/store.ts";

let clockMs = Date.now() - 60_000;
const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-source-manifest-"));
const databasePath = join(directory, "dyna.sqlite3");
const store = new DynaStore({ databasePath, clock: () => new Date(clockMs) });

const gitlab = { source: "gitlab", sourceScope: "gitlab:corp/group/project" };
const outlook = { source: "outlook", sourceScope: "outlook:executive@example.com" };
const slack = { source: "slack", sourceScope: "slack:executive-workspace/release-room" };

function item(slice, externalId, sourceUpdatedAt) {
  const sourceRef =
    slice.source === "gitlab"
      ? {
          source: "gitlab",
          instanceId: "corp",
          projectPath: "group/project",
          iid: externalId === "gitlab:current" ? 1 : 2,
          entityType: "merge_request",
        }
      : slice.source === "outlook"
        ? {
            source: "outlook",
            accountId: "executive@example.com",
            messageId: externalId,
          }
        : {
            source: "slack",
            workspaceId: "executive-workspace",
            channelId: "release-room",
            messageId: externalId,
          };
  return {
    externalId,
    sourceRef,
    sourceScope: slice.sourceScope,
    title: externalId,
    summary: `${externalId} summary`,
    priority: "high",
    priorityReason: "Executive action is required.",
    sourceUpdatedAt,
    labels: [],
  };
}

try {
  const dashboard = store.createDashboard("Required source manifest", "Completeness guard");
  const created = store.createPublisher("Executive rollup", undefined, [slack, gitlab, outlook]);
  assert.deepEqual(created.publisher.requiredSourceSlices, [gitlab, outlook, slack]);

  store.bindSchedule(dashboard.id, created.publisher.id, {
    id: "executive-rollup",
    title: "Executive rollup",
    state: "active",
    staleAfterMinutes: 60,
    requiredSourceSlices: [outlook, slack, gitlab],
  });
  store.updateScheduleStatus(created.publisher.id, {
    state: "active",
    requiredSourceSlices: [slack, gitlab, outlook],
  });
  assert.throws(
    () =>
      store.updateScheduleStatus(created.publisher.id, {
        state: "active",
        requiredSourceSlices: [gitlab, outlook],
      }),
    /required source manifest is immutable once registered/,
  );
  assert.deepEqual(store.listPublishers(dashboard.id)[0]?.requiredSourceSlices, [
    gitlab,
    outlook,
    slack,
  ]);

  const registeredAtBind = store.createPublisher("Bind-time manifest");
  store.bindSchedule(dashboard.id, registeredAtBind.publisher.id, {
    id: "bind-time-manifest",
    title: "Bind-time manifest",
    state: "paused",
    staleAfterMinutes: 60,
    requiredSourceSlices: [gitlab],
  });
  assert.deepEqual(
    store.listPublishers().find(({ id }) => id === registeredAtBind.publisher.id)
      ?.requiredSourceSlices,
    [gitlab],
  );
  const registeredAtUpdate = store.createPublisher("Update-time manifest");
  store.bindSchedule(dashboard.id, registeredAtUpdate.publisher.id, {
    id: "update-time-manifest",
    title: "Update-time manifest",
    state: "paused",
    staleAfterMinutes: 60,
  });
  store.updateScheduleStatus(registeredAtUpdate.publisher.id, {
    state: "paused",
    requiredSourceSlices: [outlook],
  });
  assert.deepEqual(
    store.listPublishers().find(({ id }) => id === registeredAtUpdate.publisher.id)
      ?.requiredSourceSlices,
    [outlook],
  );

  const initialAt = new Date(clockMs).toISOString();
  store.publish(
    created.publisher.id,
    created.secret,
    [
      item(gitlab, "gitlab:old", initialAt),
      item(outlook, "outlook:preserved", initialAt),
      item(slack, "slack:retired", initialAt),
    ],
    {
      runId: "complete-manifest",
      sourceCompletedAt: initialAt,
      mode: "replace",
      status: "succeeded",
      sourceSlices: [
        { ...gitlab, status: "succeeded" },
        { ...outlook, status: "succeeded" },
        { ...slack, status: "succeeded" },
      ],
    },
  );
  const reorderedRetry = store.publish(
    created.publisher.id,
    created.secret,
    [
      item(gitlab, "gitlab:old", initialAt),
      item(outlook, "outlook:preserved", initialAt),
      item(slack, "slack:retired", initialAt),
    ],
    {
      runId: "complete-manifest",
      sourceCompletedAt: initialAt,
      mode: "replace",
      status: "succeeded",
      sourceSlices: [
        { ...slack, status: "succeeded" },
        { ...outlook, status: "succeeded" },
        { ...gitlab, status: "succeeded" },
      ],
    },
  );
  assert.equal(reorderedRetry.deduplicated, true);

  clockMs += 1_000;
  const partialAt = new Date(clockMs).toISOString();
  store.publish(created.publisher.id, created.secret, [item(gitlab, "gitlab:current", partialAt)], {
    runId: "partial-manifest",
    sourceCompletedAt: partialAt,
    mode: "replace",
    status: "partial",
    failureMessage: "Outlook was unavailable; GitLab and Slack are current.",
    sourceSlices: [
      { ...gitlab, status: "succeeded" },
      { ...outlook, status: "failed" },
      { ...slack, status: "succeeded" },
    ],
  });
  const acceptedSnapshot = store.snapshot(dashboard.id);
  assert.deepEqual(acceptedSnapshot.cards.map((card) => card.title).sort(), [
    "gitlab:current",
    "outlook:preserved",
  ]);

  const rejectedAt = new Date(clockMs + 1_000).toISOString();
  assert.throws(
    () =>
      store.publish(created.publisher.id, created.secret, [], {
        runId: "rejected-omitted",
        sourceCompletedAt: rejectedAt,
        mode: "replace",
        status: "partial",
        failureMessage: "Outlook was unavailable.",
        sourceSlices: [
          { ...gitlab, status: "succeeded" },
          { ...outlook, status: "failed" },
        ],
      }),
    /must exactly match its publisher manifest/,
  );
  assert.throws(
    () =>
      store.publish(created.publisher.id, created.secret, [], {
        runId: "rejected-extra",
        sourceCompletedAt: rejectedAt,
        mode: "replace",
        status: "succeeded",
        sourceSlices: [
          { ...gitlab, status: "succeeded" },
          { ...outlook, status: "succeeded" },
          { ...slack, status: "succeeded" },
          { source: "skill", sourceScope: "skill:unexpected", status: "succeeded" },
        ],
      }),
    /must exactly match its publisher manifest/,
  );
  assert.throws(
    () =>
      store.publish(created.publisher.id, created.secret, [], {
        runId: "rejected-duplicate",
        sourceCompletedAt: rejectedAt,
        mode: "replace",
        status: "succeeded",
        sourceSlices: [
          { ...gitlab, status: "succeeded" },
          { ...outlook, status: "succeeded" },
          { ...slack, status: "succeeded" },
          { ...gitlab, status: "succeeded" },
        ],
      }),
    /cannot declare the same source slice twice/,
  );
  assert.throws(
    () =>
      store.publish(created.publisher.id, created.secret, [], {
        runId: "rejected-no-slices",
        sourceCompletedAt: rejectedAt,
        mode: "replace",
        status: "succeeded",
      }),
    /must declare every source slice required by its publisher manifest/,
  );

  const afterRejected = store.snapshot(dashboard.id);
  assert.equal(afterRejected.revision, acceptedSnapshot.revision);
  assert.deepEqual(
    afterRejected.cards.map((card) => card.title).sort(),
    acceptedSnapshot.cards.map((card) => card.title).sort(),
  );
  assert.equal(
    store.listPublishers(dashboard.id).find(({ id }) => id === created.publisher.id)?.lastRunAt,
    partialAt,
  );

  const raw = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(
    raw.prepare("SELECT COUNT(*) AS total FROM publisher_runs WHERE run_id LIKE 'rejected-%'").get()
      .total,
    0,
  );
  raw.close();

  clockMs += 1_000;
  const allFailedAt = new Date(clockMs).toISOString();
  const beforeAllFailed = store.snapshot(dashboard.id);
  const allFailed = store.publish(created.publisher.id, created.secret, [], {
    runId: "all-failed-manifest",
    sourceCompletedAt: allFailedAt,
    mode: "replace",
    status: "failed",
    failureMessage: "Every required source was unavailable.",
    sourceSlices: [
      { ...slack, status: "failed" },
      { ...gitlab, status: "failed" },
      { ...outlook, status: "failed" },
    ],
  });
  assert.equal(allFailed.status, "failed");
  assert.deepEqual(
    store
      .snapshot(dashboard.id)
      .cards.map((card) => card.title)
      .sort(),
    beforeAllFailed.cards.map((card) => card.title).sort(),
  );

  const legacy = store.createPublisher("Legacy publisher without a manifest");
  store.bindSchedule(dashboard.id, legacy.publisher.id, {
    id: "legacy-publisher",
    title: "Legacy publisher",
    state: "active",
    staleAfterMinutes: 60,
  });
  clockMs += 2_000;
  const legacyAt = new Date(clockMs).toISOString();
  const legacyResult = store.publish(
    legacy.publisher.id,
    legacy.secret,
    [item(gitlab, "legacy:global", legacyAt)],
    {
      runId: "legacy-global",
      sourceCompletedAt: legacyAt,
      mode: "replace",
      status: "succeeded",
    },
  );
  assert.equal(legacyResult.accepted, 1);
  assert.throws(
    () =>
      store.updateScheduleStatus(legacy.publisher.id, {
        state: "active",
        requiredSourceSlices: [outlook],
      }),
    /must include every source slice with active records/,
  );
  assert.equal(
    store.listPublishers().find((publisher) => publisher.id === legacy.publisher.id)
      ?.requiredSourceSlices,
    undefined,
  );

  globalThis.process.stdout.write(
    JSON.stringify({
      manifestInventory: true,
      reorderedRetry: true,
      bindTimeRegistration: true,
      updateTimeRegistration: true,
      multiSourcePartial: true,
      omittedRejected: true,
      extraRejected: true,
      duplicateRejected: true,
      rejectedRunsRolledBack: true,
      conflictingManifestRejected: true,
      activeSliceGuard: true,
      allFailedPreserved: true,
      legacyCompatible: true,
    }),
  );
} finally {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}

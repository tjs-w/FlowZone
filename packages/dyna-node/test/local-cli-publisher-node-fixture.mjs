import assert from "node:assert/strict";

import { DynaStore } from "../src/store.ts";

const requiredSourceSlices = [{ source: "codex", sourceScope: "codex:local" }];
const store = new DynaStore({ databasePath: ":memory:" });

try {
  const dashboard = store.createDashboard("Local CLI", "Same-user scheduled publication");
  const disabled = store.createPublisher("Disabled", undefined, requiredSourceSlices);
  const sourceCompletedAt = new Date().toISOString();
  const item = {
    externalId: "codex:local-cli-1",
    sourceRef: { source: "codex", taskId: "local-cli-1" },
    sourceScope: "codex:local",
    title: "Review local CLI publication",
    summary: "Published through the same-user local CLI boundary.",
    priority: "high",
    priorityReason: "Direct request.",
    sourceUpdatedAt: sourceCompletedAt,
    labels: [],
  };
  const options = {
    runId: "local-cli-run-1",
    sourceCompletedAt,
    mode: "replace",
    status: "succeeded",
    sourceSlices: [{ ...requiredSourceSlices[0], status: "succeeded" }],
  };
  assert.throws(
    () => store.publishLocal(disabled.publisher.id, [item], options),
    /credentials are invalid/,
  );
  assert.throws(
    () => store.createPublisher("Manifestless local CLI", undefined, undefined, "local_cli"),
    /requires an immutable source manifest/,
  );
  store.enableLocalCliPublisher(disabled.publisher.id);
  store.enableLocalCliPublisher(disabled.publisher.id);
  assert.equal(
    store.listPublishers().find(({ id }) => id === disabled.publisher.id)?.credentialMode,
    "local_cli",
  );
  assert.deepEqual(store.publishLocal(disabled.publisher.id, [item], options), {
    accepted: 1,
    deduplicated: false,
    superseded: false,
    status: "succeeded",
  });

  const manifestless = store.createPublisher("Manifestless disabled");
  assert.throws(
    () => store.enableLocalCliPublisher(manifestless.publisher.id),
    /requires an immutable source manifest/,
  );
  const previewOnly = store.createPublisher(
    "Preview only",
    undefined,
    requiredSourceSlices,
    "local_preview",
  );
  assert.throws(
    () => store.enableLocalCliPublisher(previewOnly.publisher.id),
    /Only a disabled Dyna publisher/,
  );

  const local = store.createPublisher(
    "Local CLI schedule",
    {
      id: "local-cli-schedule",
      title: "Local CLI schedule",
      state: "active",
      staleAfterMinutes: 60,
    },
    requiredSourceSlices,
    "local_cli",
  );
  store.bindSchedule(dashboard.id, local.publisher.id, {
    id: "local-cli-schedule",
    title: "Local CLI schedule",
    state: "active",
    staleAfterMinutes: 60,
    requiredSourceSlices,
  });
  assert.equal(local.publisher.credentialMode, "local_cli");
  assert.throws(
    () => store.publish(local.publisher.id, local.secret ?? "", [item], options),
    /credentials are invalid/,
  );
  assert.deepEqual(store.publishLocal(local.publisher.id, [item], options), {
    accepted: 1,
    deduplicated: false,
    superseded: false,
    status: "succeeded",
  });
  assert.equal(store.snapshot(dashboard.id).cards[0]?.title, item.title);

  const preview = store.createPublisher(
    "Preview",
    undefined,
    requiredSourceSlices,
    "local_preview",
  );
  assert.throws(
    () => store.publishLocal(preview.publisher.id, [], { ...options, runId: "wrong-channel" }),
    /credentials are invalid/,
  );
  store.revokePublisher(local.publisher.id, false);
  assert.throws(
    () =>
      store.publishLocal(local.publisher.id, [], {
        ...options,
        runId: "after-revoke",
        sourceCompletedAt: new Date(Date.now() + 1_000).toISOString(),
      }),
    /credentials are invalid/,
  );
  globalThis.process.stdout.write(
    JSON.stringify({
      disabledRejected: true,
      disabledEnabled: true,
      localCliPublished: true,
      localPreviewSeparated: true,
      revokedRejected: true,
    }),
  );
} finally {
  store.close();
}

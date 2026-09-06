import assert from "node:assert/strict";

import { DynaService } from "@flowzone/dyna-node";

import { createDynaPlugin } from "../src/plugins/dyna.ts";

const context = {
  plugin: "dyna",
  action: "test",
  requestId: "test-request",
  signal: new globalThis.AbortController().signal,
  reportProgress: () => Promise.resolve(),
};

function action(actions, id) {
  const found = actions.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing Dyna action ${id}`);
  return found;
}

async function execute(target, input) {
  if (target.executor.kind !== "module") throw new Error("Expected a module action");
  return (await target.executor.execute(input, context)).result;
}

const service = new DynaService({ databasePath: ":memory:" });
const actions = createDynaPlugin({ service }).actions;
const requiredSourceSlices = [
  { source: "slack", sourceScope: "slack:executive/release" },
  { source: "gitlab", sourceScope: "gitlab:corp/group/project" },
];

try {
  const dashboard = service.store.createDashboard("Manifest", "Action schema coverage");
  const created = await execute(action(actions, "create-publisher"), {
    name: "Executive rollup",
    requiredSourceSlices,
  });
  assert.equal(created.credentialHandling, "disabled-pending-protected-auth");
  assert.equal("secret" in created, false);
  assert.equal(created.publisher.credentialMode, "disabled");
  assert.equal(
    action(actions, "create-publisher").inputSchema.safeParse({ name: "Missing manifest" }).success,
    false,
  );
  const publisher = created.publisher;
  assert.deepEqual(publisher.requiredSourceSlices, [
    { source: "gitlab", sourceScope: "gitlab:corp/group/project" },
    { source: "slack", sourceScope: "slack:executive/release" },
  ]);

  await assert.rejects(
    execute(action(actions, "bind-schedule"), {
      dashboardId: dashboard.id,
      publisherId: publisher.id,
      scheduleId: "executive-rollup",
      scheduleTitle: "Executive rollup",
      scheduleState: "active",
      requiredSourceSlices,
    }),
    /disabled Dyna publisher cannot use an active schedule/,
  );

  await execute(action(actions, "bind-schedule"), {
    dashboardId: dashboard.id,
    publisherId: publisher.id,
    scheduleId: "executive-rollup",
    scheduleTitle: "Executive rollup",
    scheduleState: "paused",
    requiredSourceSlices: [...requiredSourceSlices].reverse(),
  });
  await execute(action(actions, "update-schedule-status"), {
    publisherId: publisher.id,
    scheduleState: "paused",
    requiredSourceSlices,
  });
  await assert.rejects(
    execute(action(actions, "update-schedule-status"), {
      publisherId: publisher.id,
      scheduleState: "active",
      requiredSourceSlices,
    }),
    /disabled Dyna publisher cannot use an active schedule/,
  );
  await assert.rejects(
    execute(action(actions, "rotate-publisher-secret"), { publisherId: publisher.id }),
    /disabled Dyna publisher cannot rotate credentials/,
  );

  const localPreview = await execute(action(actions, "create-publisher"), {
    name: "Trusted local preview",
    requiredSourceSlices,
    credentialMode: "local_preview",
  });
  assert.equal(localPreview.credentialHandling, "model-visible-trusted-local-preview-only");
  assert.equal(localPreview.publisher.credentialMode, "local_preview");
  assert.equal(typeof localPreview.secret, "string");
  const sourceCompletedAt = new Date(Date.now() - 60_000).toISOString();
  await execute(action(actions, "publish-run"), {
    publisherId: localPreview.publisher.id,
    secret: localPreview.secret,
    runId: "local-preview-run",
    sourceCompletedAt,
    mode: "replace",
    status: "succeeded",
    sourceSlices: requiredSourceSlices.map((slice) => ({ ...slice, status: "succeeded" })),
    items: [],
  });

  assert.equal(
    action(actions, "publish-run").inputSchema.safeParse({
      publisherId: localPreview.publisher.id,
      secret: localPreview.secret,
      runId: "manual-forgery",
      sourceCompletedAt,
      mode: "replace",
      status: "succeeded",
      sourceSlices: requiredSourceSlices.map((slice) => ({ ...slice, status: "succeeded" })),
      items: [
        {
          externalId: "manual-forgery",
          sourceRef: {
            source: "manual",
            todoId: "bd9a11b5-fbf8-495a-a116-d3429496969f",
          },
          sourceScope: "manual:dashboard",
          title: "Forged manual record",
          summary: "Scheduled input cannot impersonate a user-created to-do.",
          priority: "critical",
          priorityReason: "Forged urgency.",
          sourceUpdatedAt: sourceCompletedAt,
          labels: [],
        },
      ],
    }).success,
    false,
  );

  const listed = await execute(action(actions, "list-publishers"), {});
  assert.deepEqual(listed.publishers[0].requiredSourceSlices, [
    { source: "gitlab", sourceScope: "gitlab:corp/group/project" },
    { source: "slack", sourceScope: "slack:executive/release" },
  ]);
  assert.deepEqual(
    listed.publishers.find(({ id }) => id === localPreview.publisher.id)?.lastSourceSlices,
    [
      {
        source: "gitlab",
        sourceScope: "gitlab:corp/group/project",
        status: "succeeded",
        freshness: "fresh",
      },
      {
        source: "slack",
        sourceScope: "slack:executive/release",
        status: "succeeded",
        freshness: "fresh",
      },
    ],
  );

  await assert.rejects(
    execute(action(actions, "update-schedule-status"), {
      publisherId: publisher.id,
      scheduleState: "paused",
      requiredSourceSlices: [requiredSourceSlices[0]],
    }),
    /required source manifest is immutable once registered/,
  );
  assert.equal(
    action(actions, "bind-schedule").inputSchema.safeParse({
      dashboardId: dashboard.id,
      publisherId: publisher.id,
      scheduleId: "executive-rollup",
      scheduleTitle: "Executive rollup",
      scheduleState: "paused",
      requiredSourceSlices: [requiredSourceSlices[0], requiredSourceSlices[0]],
    }).success,
    false,
  );

  globalThis.process.stdout.write(
    JSON.stringify({
      createSchema: true,
      disabledByDefault: true,
      disabledEnforced: true,
      localPreviewOperational: true,
      scheduledManualRejected: true,
      latestSlicesExposed: true,
      manifestRequired: true,
      bindSchema: true,
      updateSchema: true,
      inventory: true,
      immutable: true,
    }),
  );
} finally {
  service.close();
}

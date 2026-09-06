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
  assert.equal(
    action(actions, "create-publisher").inputSchema.safeParse({ name: "Missing manifest" }).success,
    false,
  );
  const publisher = created.publisher;
  assert.deepEqual(publisher.requiredSourceSlices, [
    { source: "gitlab", sourceScope: "gitlab:corp/group/project" },
    { source: "slack", sourceScope: "slack:executive/release" },
  ]);

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

  const listed = await execute(action(actions, "list-publishers"), {});
  assert.deepEqual(listed.publishers[0].requiredSourceSlices, [
    { source: "gitlab", sourceScope: "gitlab:corp/group/project" },
    { source: "slack", sourceScope: "slack:executive/release" },
  ]);

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

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { DynaService } from "@flowzone/dyna-node";

import { createDynaPlugin } from "../src/plugins/dyna.ts";

const context = {
  signal: new globalThis.AbortController().signal,
  requestId: "status-test",
};

function appTool(appTools, name) {
  const found = appTools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing Dyna app tool ${name}`);
  return found;
}

async function call(target, input) {
  return target.handler(input, context);
}

const now = "2026-09-11T18:00:00.000Z";
const service = new DynaService({ databasePath: ":memory:", clock: () => new Date(now) });
const plugin = createDynaPlugin({ service });

try {
  const dashboard = service.store.createDashboard("Workflow", "App-private status changes");
  const emptyView = service.render(dashboard.id);
  const itemId = service.store.addTodo(
    emptyView.viewToken,
    { title: "Decide release", priority: "high", labels: [] },
    randomUUID(),
  );
  const payload = service.render(dashboard.id);
  const card = payload.snapshot.cards.find((candidate) => candidate.id === itemId);
  assert.ok(card);

  const setStatus = appTool(plugin.appTools ?? [], "dyna_set_item_status");
  assert.equal(
    plugin.actions.some((candidate) => candidate.id === "dyna_set_item_status"),
    false,
  );
  assert.deepEqual(setStatus.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  });
  assert.equal(
    setStatus.inputSchema.safeParse({
      viewToken: payload.viewToken,
      itemId,
      targetStage: "done",
      expectedRevision: payload.snapshot.revision,
      expectedFingerprint: card.fingerprint,
      clientRequestId: randomUUID(),
    }).success,
    false,
  );
  assert.equal(
    setStatus.inputSchema.safeParse({
      viewToken: payload.viewToken,
      itemId,
      targetStage: "todo",
      outcome: "Not accepted for active work.",
      expectedRevision: payload.snapshot.revision,
      expectedFingerprint: card.fingerprint,
      clientRequestId: randomUUID(),
    }).success,
    false,
  );

  const clientRequestId = randomUUID();
  const input = {
    viewToken: payload.viewToken,
    itemId,
    targetStage: "needs_you",
    expectedRevision: payload.snapshot.revision,
    expectedFingerprint: card.fingerprint,
    clientRequestId,
  };
  const changed = await call(setStatus, input);
  assert.deepEqual(changed.content, []);
  assert.equal(changed.structuredContent.schema, "dyna/item-status-result-v1");
  assert.equal(changed.structuredContent.changed, true);
  assert.equal(changed.structuredContent.deduplicated, false);
  assert.equal((await call(setStatus, input)).structuredContent.deduplicated, true);
  assert.equal(service.snapshot(dashboard.id).cards[0]?.workflowState, "attention");
  await assert.rejects(call(setStatus, { ...input, targetStage: "todo" }), /different input/);

  const otherDashboard = service.store.createDashboard("Other", "Capability isolation");
  const otherView = service.render(otherDashboard.id);
  await assert.rejects(
    call(setStatus, {
      ...input,
      viewToken: otherView.viewToken,
      clientRequestId: randomUUID(),
    }),
    /outside this dashboard view/,
  );

  globalThis.process.stdout.write(
    JSON.stringify({
      appPrivate: true,
      strictCompletion: true,
      exactReplay: true,
      capabilityBound: true,
    }),
  );
} finally {
  service.close();
}

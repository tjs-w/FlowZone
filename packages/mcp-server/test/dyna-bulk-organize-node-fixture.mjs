import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { DynaService } from "@flowzone/dyna-node";

import { createDynaPlugin } from "../src/plugins/dyna.ts";

const now = "2026-09-11T22:00:00.000Z";
const service = new DynaService({ databasePath: ":memory:", clock: () => new Date(now) });
const plugin = createDynaPlugin({ service });
const organize = (plugin.appTools ?? []).find(
  (candidate) => candidate.name === "dyna_organize_item",
);
assert.ok(organize);

const call = (input) =>
  organize.handler(input, {
    signal: new globalThis.AbortController().signal,
    requestId: "bulk-organize-test",
  });
const sampleItems = (length) =>
  Array.from({ length }, () => ({
    itemId: randomUUID(),
    expectedFingerprint: "a".repeat(64),
  }));

try {
  const dashboard = service.store.createDashboard("Bulk MCP", "Bounded group changes");
  const viewToken = service.store.createView(dashboard.id);
  const highId = service.store.addTodo(
    viewToken,
    { title: "Move from high", priority: "high", labels: [] },
    randomUUID(),
  );
  const normalId = service.store.addTodo(
    viewToken,
    { title: "Already normal", priority: "normal", labels: [] },
    randomUUID(),
  );
  const snapshot = service.snapshot(dashboard.id);
  const high = snapshot.cards.find((card) => card.id === highId);
  const normal = snapshot.cards.find((card) => card.id === normalId);
  assert.ok(high);
  assert.ok(normal);
  const items = [high, normal].map((card) => ({
    itemId: card.id,
    expectedFingerprint: card.fingerprint,
  }));
  const input = {
    viewToken,
    action: "group",
    items,
    targetPriority: "normal",
    expectedRevision: snapshot.revision,
  };

  assert.equal(organize.inputSchema.safeParse(input).success, true);
  assert.equal(
    organize.inputSchema.safeParse({ ...input, items: [items[0], items[0]] }).success,
    false,
  );
  assert.equal(organize.inputSchema.safeParse({ ...input, items: sampleItems(100) }).success, true);
  assert.equal(organize.inputSchema.safeParse({ ...input, items: sampleItems(101) }).success, true);
  assert.equal(organize.inputSchema.safeParse({ ...input, items: sampleItems(200) }).success, true);
  assert.equal(
    organize.inputSchema.safeParse({
      ...input,
      items: sampleItems(201),
    }).success,
    false,
  );
  assert.equal(organize.inputSchema.safeParse({ ...input, itemId: high.id }).success, false);
  assert.equal(organize.inputSchema.safeParse({ ...input, items: undefined }).success, false);
  const result = await call(input);
  assert.deepEqual(result, {
    structuredContent: { changed: true, changedCount: 1 },
    content: [],
  });

  const moved = service.snapshot(dashboard.id);
  assert.equal(moved.revision, snapshot.revision + 1);
  assert.deepEqual(
    moved.cards.filter((card) => card.priority === "normal").map((card) => card.id),
    [normal.id, high.id],
  );
  assert.throws(() => call(input), /dashboard changed/);
  assert.equal(service.snapshot(dashboard.id).revision, moved.revision);

  const single = await call({
    viewToken,
    itemId: high.id,
    action: "lower",
    expectedRevision: moved.revision,
    expectedFingerprint: high.fingerprint,
  });
  assert.deepEqual(single.structuredContent, { changed: true, changedCount: 1 });

  globalThis.process.stdout.write(
    JSON.stringify({ boundedSchema: true, atomicHandler: true, legacyShape: true }),
  );
} finally {
  service.close();
}

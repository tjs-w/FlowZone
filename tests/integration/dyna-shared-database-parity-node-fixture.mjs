import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { buildSync } from "esbuild";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "flowzone-dyna-shared-parity-"));
const dataDirectory = join(temporaryRoot, "Shared Dyna data ü");
const workingDirectory = join(temporaryRoot, "Restricted working Δ");
const homeDirectory = join(temporaryRoot, "Home");
mkdirSync(dataDirectory);
mkdirSync(workingDirectory);
mkdirSync(homeDirectory);

const serviceBundle = join(temporaryRoot, "dyna-service.mjs");
const pluginBundle = join(temporaryRoot, "dyna-plugin.mjs");
const cliBundle = join(temporaryRoot, "dyna-cli.cjs");
const publisherBundle = join(temporaryRoot, "flowzone-publish.cjs");

for (const [entryPoint, outfile, format] of [
  [join(repositoryRoot, "packages/dyna-node/src/service.ts"), serviceBundle, "esm"],
  [join(repositoryRoot, "packages/mcp-server/src/plugins/dyna.ts"), pluginBundle, "esm"],
  [join(repositoryRoot, "server/src/dyna.ts"), cliBundle, "cjs"],
  [join(repositoryRoot, "server/src/publish.ts"), publisherBundle, "cjs"],
]) {
  buildSync({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: "node",
    format,
    target: "node22",
    logLevel: "silent",
  });
}

const { DynaApplicationService, canonicalDynaTaskTitle } = await import(
  pathToFileURL(serviceBundle).href
);
const { createDynaPlugin } = await import(pathToFileURL(pluginBundle).href);

const databasePath = join(dataDirectory, "dyna.sqlite3");
const now = new Date().toISOString();
const cliEnvironment = {
  FLOWZONE_DATA_DIR: dataDirectory,
  HOME: homeDirectory,
  NODE_NO_WARNINGS: "1",
  PATH: "/usr/bin:/bin",
};
const actionContext = {
  plugin: "dyna",
  action: "shared-database-parity",
  requestId: "shared-database-parity",
  signal: new globalThis.AbortController().signal,
  reportProgress: () => Promise.resolve(),
};

function invokeCli(arguments_, input, redactedValues = []) {
  const result = spawnSync(globalThis.process.execPath, [cliBundle, ...arguments_], {
    cwd: workingDirectory,
    env: cliEnvironment,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    ...(input === undefined ? {} : { input: `${JSON.stringify(input)}\n` }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^\{.*\}\n$/u);
  for (const value of redactedValues) {
    assert.equal(result.stdout.includes(value), false);
    assert.equal(result.stderr.includes(value), false);
  }
  return JSON.parse(result.stdout);
}

function publishThroughAdapter(publisherId, input) {
  const result = spawnSync(
    globalThis.process.execPath,
    [publisherBundle, "--publisher", publisherId],
    {
      cwd: workingDirectory,
      env: cliEnvironment,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      input: `${JSON.stringify(input)}\n`,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^\{.*\}\n$/u);
  return JSON.parse(result.stdout);
}

function findAction(plugin, id) {
  const action = plugin.actions.find((candidate) => candidate.id === id);
  assert.ok(action, `Missing Dyna action ${id}`);
  assert.equal(action.executor.kind, "module");
  return action;
}

function findAppTool(plugin, name) {
  const tool = (plugin.appTools ?? []).find((candidate) => candidate.name === name);
  assert.ok(tool, `Missing Dyna app tool ${name}`);
  return tool;
}

async function executeAction(plugin, id, input) {
  return findAction(plugin, id).executor.execute(input, actionContext);
}

let mcpService;
try {
  mcpService = new DynaApplicationService({ databasePath });
  const plugin = createDynaPlugin({ service: mcpService });
  const dashboard = (
    await executeAction(plugin, "create-dashboard", {
      name: "Shared database parity",
      description: "CLI writes must be immediately visible through the MCP adapter.",
      doneRetentionHours: 24,
    })
  ).result;
  const publisherCreation = (
    await executeAction(plugin, "create-publisher", {
      name: "Parity source",
      requiredSourceSlices: [{ source: "gitlab", sourceScope: "team/parity" }],
      credentialMode: "local_cli",
    })
  ).result;
  assert.equal(publisherCreation.credentialHandling, "local-cli-user-boundary");
  assert.equal("secret" in publisherCreation, false);
  const publisher = publisherCreation.publisher;
  await executeAction(plugin, "bind-schedule", {
    dashboardId: dashboard.id,
    publisherId: publisher.id,
    scheduleId: "shared-parity-refresh",
    scheduleTitle: "Shared parity refresh",
    scheduleState: "active",
    staleAfterMinutes: 1_440,
  });
  const publication = publishThroughAdapter(publisher.id, {
    runId: "shared-parity-seed",
    sourceCompletedAt: now,
    mode: "replace",
    status: "succeeded",
    sourceSlices: [{ source: "gitlab", sourceScope: "team/parity", status: "succeeded" }],
    items: [
      {
        externalId: "primary",
        sourceRef: {
          source: "gitlab",
          instanceId: "gitlab.example.com",
          projectPath: "team/parity",
          iid: 101,
          entityType: "merge_request",
        },
        sourceScope: "team/parity",
        title: "Primary parity item",
        summary: "Primary source summary.",
        priority: "normal",
        priorityReason: "Parity fixture",
        sourceUpdatedAt: now,
        labels: ["parity"],
      },
      {
        externalId: "peer",
        sourceRef: {
          source: "gitlab",
          instanceId: "gitlab.example.com",
          projectPath: "team/parity",
          iid: 102,
          entityType: "merge_request",
        },
        sourceScope: "team/parity",
        title: "Peer parity item",
        summary: "Peer source summary.",
        priority: "normal",
        priorityReason: "Parity fixture",
        sourceUpdatedAt: now,
        labels: ["parity"],
      },
      {
        externalId: "high-anchor",
        sourceRef: {
          source: "gitlab",
          instanceId: "gitlab.example.com",
          projectPath: "team/parity",
          iid: 103,
          entityType: "issue",
        },
        sourceScope: "team/parity",
        title: "Existing high-priority anchor",
        summary: "Keeps bulk placement order observable.",
        priority: "high",
        priorityReason: "Parity fixture",
        sourceUpdatedAt: now,
        labels: ["parity"],
      },
    ],
  });
  assert.deepEqual(publication, {
    accepted: 3,
    deduplicated: false,
    superseded: false,
    status: "succeeded",
  });
  const seeded = (await executeAction(plugin, "render-dashboard", { dashboardId: dashboard.id }))
    .uiPayload.snapshot;
  const primary = seeded.cards.find((card) => card.title === "Primary parity item");
  const peer = seeded.cards.find((card) => card.title === "Peer parity item");
  assert.ok(primary);
  assert.ok(peer);
  const parityTaskId = "shared-parity-task";
  const parityTaskHostId = "local";
  const parityTaskTitle = canonicalDynaTaskTitle(
    primary.itemNumber,
    "Execute shared database parity work",
  );
  mcpService.updateTask(dashboard.id, primary.id, {
    taskId: parityTaskId,
    hostId: parityTaskHostId,
    title: parityTaskTitle,
    state: "running",
    statusUpdatedAt: now,
    observedAt: now,
  });

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 9);
  } finally {
    database.close();
  }

  const opened = await executeAction(plugin, "render-dashboard", { dashboardId: dashboard.id });
  assert.equal(opened.uiPayload.schema, "dyna/ui-v9");
  assert.equal(opened.uiPayload.snapshot.cards.length, 3);
  const viewToken = opened.uiPayload.viewToken;
  let currentRevision = opened.uiPayload.snapshot.revision;
  const refreshTool = findAppTool(plugin, "dyna_get_snapshot");

  const refresh = async (query = "", scope = "active") => {
    const response = await refreshTool.handler(
      { viewToken, currentRevision, query, scope },
      actionContext,
    );
    const payload = response._meta?.dynaDashboard;
    assert.ok(payload);
    assert.equal(payload.schema, "dyna/ui-v9");
    assert.equal(payload.snapshot.dashboard.id, dashboard.id);
    currentRevision = payload.snapshot.revision;
    return payload.snapshot;
  };

  const show = (itemId) =>
    invokeCli(["item", "show", "--dashboard-id", dashboard.id, "--item-id", itemId]);

  const workBody = "Durable parity milestone 8842";
  const artifactUrl = "https://example.com/parity/mr/8842";
  const updateRequestId = randomUUID();
  const update = invokeCli(
    [
      "work",
      "update",
      "--dashboard-id",
      dashboard.id,
      "--item-id",
      primary.id,
      "--expected-fingerprint",
      primary.fingerprint,
    ],
    {
      requestId: updateRequestId,
      workAttemptId: randomUUID(),
      kind: "note",
      body: workBody,
      artifacts: [{ kind: "merge_request", label: "MR 8842", url: artifactUrl }],
      task: { taskId: parityTaskId, hostId: parityTaskHostId },
    },
    [workBody, artifactUrl, dataDirectory],
  );
  assert.deepEqual(Object.keys(update).sort(), [
    "deduplicated",
    "itemId",
    "requestId",
    "schema",
    "workUpdateId",
  ]);
  assert.equal(update.schema, "dyna/item-update-result-v1");
  assert.equal(update.requestId, updateRequestId);
  assert.equal(update.itemId, primary.id);
  assert.equal(update.deduplicated, false);
  let visible = await refresh();
  let visiblePrimary = visible.cards.find((card) => card.id === primary.id);
  assert.equal(visiblePrimary?.workUpdateCount, 1);
  assert.equal(visiblePrimary?.workUpdates[0]?.body, workBody);
  assert.equal(visiblePrimary?.workUpdates[0]?.artifacts[0]?.url, artifactUrl);
  assert.deepEqual(visiblePrimary?.workUpdates[0]?.task, {
    taskId: parityTaskId,
    hostId: parityTaskHostId,
    title: parityTaskTitle,
  });

  const enrichmentSummary = "Correlated parity summary from all sources.";
  const enrichmentAttention = "Confirm the release decision.";
  let shown = show(primary.id);
  const enrichRequestId = randomUUID();
  const enriched = invokeCli(
    [
      "work",
      "enrich",
      "--dashboard-id",
      dashboard.id,
      "--item-id",
      primary.id,
      "--expected-fingerprint",
      primary.fingerprint,
      "--expected-enrichment-version",
      String(shown.enrichmentVersion),
    ],
    {
      requestId: enrichRequestId,
      summary: enrichmentSummary,
      priority: "high",
      priorityReason: "Correlated parity evidence",
      labels: ["parity", "correlated"],
      attention: enrichmentAttention,
      plan: ["Review the linked merge request."],
      nextSteps: [{ label: "Confirm the release decision." }],
    },
    [enrichmentSummary, enrichmentAttention, dataDirectory],
  );
  assert.deepEqual(Object.keys(enriched).sort(), [
    "deduplicated",
    "enrichmentVersion",
    "itemId",
    "requestId",
    "schema",
  ]);
  assert.equal(enriched.schema, "dyna/item-enrich-result-v1");
  assert.equal(enriched.enrichmentVersion, 1);
  visible = await refresh();
  visiblePrimary = visible.cards.find((card) => card.id === primary.id);
  assert.equal(visiblePrimary?.summary, enrichmentSummary);
  assert.equal(visiblePrimary?.attention, enrichmentAttention);
  assert.equal(visiblePrimary?.priority, "high");
  assert.deepEqual(visiblePrimary?.labels, ["parity", "correlated"]);

  shown = show(primary.id);
  const placeRequestId = randomUUID();
  const placed = invokeCli(
    [
      "organize",
      "place",
      "--dashboard-id",
      dashboard.id,
      "--item-id",
      primary.id,
      "--expected-fingerprint",
      primary.fingerprint,
      "--expected-revision",
      String(shown.revision),
    ],
    { requestId: placeRequestId, targetPriority: "low" },
    [dataDirectory],
  );
  assert.deepEqual(placed, {
    schema: "dyna/item-place-result-v1",
    requestId: placeRequestId,
    itemId: primary.id,
    changed: true,
    deduplicated: false,
  });
  visible = await refresh();
  assert.equal(visible.cards.find((card) => card.id === primary.id)?.priority, "low");

  const beforeBulk = visible;
  const selectedOrder = beforeBulk.cards
    .filter((card) => card.id === primary.id || card.id === peer.id)
    .map((card) => card.id);
  assert.deepEqual(selectedOrder, [peer.id, primary.id]);
  const bulkRequestId = randomUUID();
  const bulk = invokeCli(
    [
      "organize",
      "place-many",
      "--dashboard-id",
      dashboard.id,
      "--expected-revision",
      String(beforeBulk.revision),
    ],
    {
      requestId: bulkRequestId,
      targetPriority: "high",
      items: [
        { itemId: primary.id, expectedFingerprint: primary.fingerprint },
        { itemId: peer.id, expectedFingerprint: peer.fingerprint },
      ],
    },
    [dataDirectory],
  );
  assert.deepEqual(bulk, {
    schema: "dyna/place-many-result-v1",
    requestId: bulkRequestId,
    dashboardId: dashboard.id,
    changed: true,
    changedCount: 2,
    deduplicated: false,
  });
  visible = await refresh();
  const highIds = visible.cards.filter((card) => card.priority === "high").map((card) => card.id);
  assert.deepEqual(highIds.slice(-2), selectedOrder);

  shown = show(primary.id);
  const archiveRequestId = randomUUID();
  const archived = invokeCli(
    [
      "lifecycle",
      "archive",
      "--dashboard-id",
      dashboard.id,
      "--item-id",
      primary.id,
      "--expected-fingerprint",
      primary.fingerprint,
      "--expected-revision",
      String(shown.revision),
    ],
    { requestId: archiveRequestId, reason: "superseded" },
    [dataDirectory],
  );
  assert.equal(archived.schema, "dyna/item-archive-result-v1");
  assert.equal(archived.itemId, primary.id);
  assert.equal(archived.reason, "superseded");
  assert.equal(archived.deduplicated, false);
  visible = await refresh();
  assert.equal(
    visible.cards.some((card) => card.id === primary.id),
    false,
  );
  const archivedSearch = await executeAction(plugin, "search-items", {
    dashboardId: dashboard.id,
    query: "Primary parity",
    scope: "archive",
  });
  assert.equal(archivedSearch.result.items.length, 1);
  assert.equal(archivedSearch.result.items[0]?.itemId, primary.id);
  assert.equal(archivedSearch.result.items[0]?.archive?.reason, "superseded");
  assert.equal(archivedSearch.result.items[0]?.workUpdateCount, 1);

  shown = show(primary.id);
  const restoreRequestId = randomUUID();
  const restored = invokeCli(
    [
      "lifecycle",
      "restore",
      "--dashboard-id",
      dashboard.id,
      "--item-id",
      primary.id,
      "--expected-fingerprint",
      primary.fingerprint,
      "--expected-revision",
      String(shown.revision),
    ],
    { requestId: restoreRequestId },
    [dataDirectory],
  );
  assert.equal(restored.schema, "dyna/item-restore-result-v1");
  assert.equal(restored.itemId, primary.id);
  assert.equal(restored.deduplicated, false);
  visible = await refresh();
  visiblePrimary = visible.cards.find((card) => card.id === primary.id);
  assert.equal(visiblePrimary?.summary, enrichmentSummary);
  assert.equal(visiblePrimary?.workUpdates[0]?.body, workBody);

  const todoTitle = "Standalone parity to-do 5511";
  const todoSummary = "Created through the canonical CLI boundary.";
  const todoRequestId = randomUUID();
  const todo = invokeCli(
    ["todo", "create", "--dashboard-id", dashboard.id],
    {
      requestId: todoRequestId,
      title: todoTitle,
      summary: todoSummary,
      priority: "normal",
      labels: ["parity", "manual"],
    },
    [todoTitle, todoSummary, dataDirectory],
  );
  assert.deepEqual(Object.keys(todo).sort(), [
    "deduplicated",
    "fingerprint",
    "itemId",
    "itemNumber",
    "requestId",
    "schema",
  ]);
  assert.equal(todo.schema, "dyna/todo-create-result-v2");
  visible = await refresh();
  const visibleTodo = visible.cards.find((card) => card.id === todo.itemId);
  assert.equal(visibleTodo?.title, todoTitle);
  assert.equal(visibleTodo?.summary, todoSummary);
  assert.equal(visibleTodo?.source, "manual");
  assert.equal(visibleTodo?.followUpOfItemId, undefined);

  shown = show(peer.id);
  invokeCli(
    [
      "lifecycle",
      "archive",
      "--dashboard-id",
      dashboard.id,
      "--item-id",
      peer.id,
      "--expected-fingerprint",
      peer.fingerprint,
      "--expected-revision",
      String(shown.revision),
    ],
    { requestId: randomUUID(), reason: "no_action_needed" },
    [dataDirectory],
  );
  shown = show(peer.id);
  const followUpTitle = "Follow-up parity to-do 6622";
  const followUpSummary = "New work linked to immutable historical evidence.";
  const followUpRequestId = randomUUID();
  const followUp = invokeCli(
    [
      "follow-up",
      "create",
      "--dashboard-id",
      dashboard.id,
      "--item-id",
      peer.id,
      "--expected-fingerprint",
      peer.fingerprint,
      "--expected-revision",
      String(shown.revision),
    ],
    {
      requestId: followUpRequestId,
      title: followUpTitle,
      summary: followUpSummary,
      priority: "normal",
      labels: ["parity", "follow-up"],
    },
    [followUpTitle, followUpSummary, dataDirectory],
  );
  assert.deepEqual(Object.keys(followUp).sort(), [
    "deduplicated",
    "fingerprint",
    "itemId",
    "itemNumber",
    "requestId",
    "schema",
    "sourceItemId",
    "sourceItemNumber",
  ]);
  assert.equal(followUp.schema, "dyna/follow-up-create-result-v2");
  assert.equal(followUp.sourceItemId, peer.id);
  visible = await refresh();
  const visibleFollowUp = visible.cards.find((card) => card.id === followUp.itemId);
  assert.equal(visibleFollowUp?.title, followUpTitle);
  assert.equal(visibleFollowUp?.followUpOfItemId, peer.id);
  const archivedPeer = await executeAction(plugin, "search-items", {
    dashboardId: dashboard.id,
    query: "Peer parity",
    scope: "archive",
  });
  assert.equal(archivedPeer.result.items.length, 1);
  assert.equal(archivedPeer.result.items[0]?.itemId, peer.id);
  assert.equal(archivedPeer.result.items[0]?.archive?.reason, "no_action_needed");
  assert.equal(archivedPeer.result.items[0]?.title, "Peer parity item");

  globalThis.process.stdout.write(
    JSON.stringify({
      schemaVersion: 8,
      workUpdate: true,
      enrichment: true,
      singlePlacement: true,
      bulkPlacement: true,
      archiveRestore: true,
      standaloneTodo: true,
      followUp: true,
      adapterSeed: true,
      mutationOutputRedacted: true,
      mcpRefreshParity: true,
    }),
  );
} finally {
  mcpService?.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
}

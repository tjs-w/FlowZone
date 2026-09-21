import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildSync } from "esbuild";

import {
  canonicalDynaTaskTitle,
  DynaApplicationService,
} from "../../packages/dyna-node/src/service.ts";

const temporaryRoot = mkdtempSync(join(tmpdir(), "flowzone-dyna-cli-"));
const directory = join(temporaryRoot, "Dyna data ü with spaces");
const workingDirectory = join(temporaryRoot, "Arbitrary working Δ directory");
mkdirSync(directory);
mkdirSync(workingDirectory);
const databasePath = join(directory, "dyna.sqlite3");
const cliSourcePath = resolve(import.meta.dirname, "../../server/src/dyna.ts");
const cliSource = readFileSync(cliSourcePath, "utf8");
const serviceConstruction =
  "const service = new DynaApplicationService({ actor: DYNA_CLI_ACTOR });";
assert.equal(
  cliSource.split(serviceConstruction).length - 1,
  1,
  "Dyna CLI test injection point changed.",
);
const testBundle = join(temporaryRoot, "dyna-test-cli.cjs");
buildSync({
  stdin: {
    contents: cliSource.replace(
      serviceConstruction,
      `const service = new DynaApplicationService({ actor: DYNA_CLI_ACTOR, databasePath: ${JSON.stringify(databasePath)} });`,
    ),
    loader: "ts",
    resolveDir: resolve(import.meta.dirname, "../../server/src"),
    sourcefile: cliSourcePath,
  },
  outfile: testBundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  logLevel: "silent",
});
const executable = globalThis.process.execPath;
const executablePrefix = ["--disable-warning=ExperimentalWarning", testBundle];
const environment = {
  ...globalThis.process.env,
  PATH: "/usr/bin:/bin",
};

function invoke(arguments_, input) {
  const result = spawnSync(executable, [...executablePrefix, ...arguments_], {
    encoding: "utf8",
    env: environment,
    cwd: workingDirectory,
    ...(input === undefined ? {} : { input: `${JSON.stringify(input)}\n` }),
  });
  return {
    ...result,
    json: result.stdout.trim() ? JSON.parse(result.stdout) : undefined,
  };
}

function assertInvalidArguments(label, arguments_, input) {
  const rejected = invoke(arguments_, input);
  assert.equal(rejected.status, 1, `${label}: ${rejected.stderr}`);
  assert.equal(rejected.stdout, "", label);
  assert.equal(JSON.parse(rejected.stderr).code, "invalid_input", label);
}

function withoutFlag(arguments_, flag) {
  const index = arguments_.indexOf(flag);
  assert.notEqual(index, -1, `Missing test flag ${flag}`);
  return [...arguments_.slice(0, index), ...arguments_.slice(index + 2)];
}

function withDuplicateFlag(arguments_, flag) {
  const index = arguments_.indexOf(flag);
  assert.notEqual(index, -1, `Missing test flag ${flag}`);
  return [...arguments_, flag, arguments_[index + 1]];
}

function withMalformedFlag(arguments_, flag) {
  const index = arguments_.indexOf(flag);
  assert.notEqual(index, -1, `Missing test flag ${flag}`);
  const malformed = flag === "--expected-fingerprint" ? "bad-fingerprint" : "bad-value";
  return [...arguments_.slice(0, index + 1), malformed, ...arguments_.slice(index + 2)];
}

try {
  let result = invoke(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.schema, "dyna/help-v1");
  assert.deepEqual(
    result.json.commands.map((entry) => entry.command.split(" ").slice(1, 3).join(" ")),
    [
      "dashboard list",
      "dashboard show",
      "item search",
      "item show",
      "item history",
      "item activity",
      "work update",
      "work enrich",
      "work complete",
      "annotation add",
      "annotation edit",
      "annotation delete",
      "organize place",
      "organize place-many",
      "lifecycle archive",
      "lifecycle restore",
      "todo create",
      "follow-up create",
      "setup",
      "--help",
      "--version",
    ],
  );
  assert.equal(
    result.json.commands.some((command) => command.readsStdin === true),
    true,
  );

  result = invoke(["--version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.schema, "dyna/version-v1");
  assert.equal(result.json.minimumNodeVersion, "22.13.0");

  result = invoke(["setup"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.json, {
    schema: "dyna/setup-v1",
    ready: true,
    store: "available",
    credentialBoundary: "local-user",
  });

  const store = new DynaApplicationService({ databasePath });
  const dashboard = store.createDashboard("CLI", "Bundled command coverage");
  store.createDashboard("CLI secondary", "Dashboard-list pagination coverage");
  const { publisher, secret } = store.createPublisher(
    "CLI source",
    undefined,
    undefined,
    "local_preview",
  );
  store.bindSchedule(dashboard.id, publisher.id, {
    id: "cli-schedule",
    title: "CLI schedule",
    state: "active",
    staleAfterMinutes: 60,
  });
  store.publish(
    publisher.id,
    secret,
    [
      {
        externalId: "cli-item",
        sourceRef: {
          source: "gitlab",
          instanceId: "gitlab.example.com",
          projectPath: "team/service",
          iid: 7,
          entityType: "merge_request",
        },
        sourceScope: "team/service",
        title: "Exercise the CLI",
        summary: "Validate the safe cross-session boundary.",
        priority: "normal",
        priorityReason: "Test",
        sourceUpdatedAt: new Date().toISOString(),
        labels: [],
      },
      ...Array.from({ length: 21 }, (_, index) => ({
        externalId: `cli-search-${index}`,
        sourceRef: {
          source: "gitlab",
          instanceId: "gitlab.example.com",
          projectPath: "team/service",
          iid: 100 + index,
          entityType: "issue",
        },
        sourceScope: "team/service",
        title: `Bounded search fixture ${index}`,
        summary: "Validate the 20-item search response cap.",
        priority: "low",
        priorityReason: "Search fixture",
        sourceUpdatedAt: new Date().toISOString(),
        labels: ["search-fixture"],
      })),
    ],
    {
      runId: "cli-run",
      sourceCompletedAt: new Date().toISOString(),
      mode: "replace",
      status: "succeeded",
    },
  );
  const item = store.snapshot(dashboard.id).cards.find((card) => card.title === "Exercise the CLI");
  assert.ok(item);
  const cliTaskId = "cli-task";
  const cliTaskHostId = "local";
  const cliTaskTitle = canonicalDynaTaskTitle(item.itemNumber, "Exercise the CLI through Codex");
  const taskObservedAt = new Date().toISOString();
  store.updateTask(dashboard.id, item.id, {
    taskId: cliTaskId,
    hostId: cliTaskHostId,
    title: cliTaskTitle,
    state: "running",
    statusUpdatedAt: taskObservedAt,
    observedAt: taskObservedAt,
  });
  store.close();

  const unknownDashboardId = randomUUID();
  const unknownItemId = randomUUID();
  const unknownFingerprint = "f".repeat(64);
  const commonArguments = ["--dashboard-id", unknownDashboardId, "--item-id", unknownItemId];
  const preconditionArguments = [
    ...commonArguments,
    "--expected-fingerprint",
    unknownFingerprint,
    "--expected-revision",
    "0",
  ];
  const taskMutationInput = {
    requestId: randomUUID(),
    workAttemptId: randomUUID(),
    task: { taskId: "parser-task", hostId: "parser-host" },
  };
  const canonicalCommandCases = [
    {
      name: "dashboard list",
      arguments: ["dashboard", "list"],
      missing: ["dashboard"],
      duplicate: ["dashboard", "list", "dashboard", "list"],
      malformed: ["dashboard", "LIST"],
    },
    {
      name: "dashboard show",
      arguments: ["dashboard", "show", "--dashboard-id", unknownDashboardId],
      requiredFlag: "--dashboard-id",
    },
    {
      name: "item search",
      arguments: ["item", "search", "--dashboard-id", unknownDashboardId],
      requiredFlag: "--dashboard-id",
    },
    {
      name: "item show",
      arguments: ["item", "show", ...commonArguments],
      requiredFlag: "--item-id",
    },
    {
      name: "item history",
      arguments: ["item", "history", ...commonArguments],
      requiredFlag: "--item-id",
    },
    {
      name: "item activity",
      arguments: ["item", "activity", ...commonArguments],
      requiredFlag: "--item-id",
    },
    {
      name: "work update",
      arguments: [
        "work",
        "update",
        ...commonArguments,
        "--expected-fingerprint",
        unknownFingerprint,
      ],
      requiredFlag: "--expected-fingerprint",
      input: {
        ...taskMutationInput,
        kind: "note",
        body: "Parser boundary fixture",
        artifacts: [],
      },
    },
    {
      name: "work enrich",
      arguments: [
        "work",
        "enrich",
        ...commonArguments,
        "--expected-fingerprint",
        unknownFingerprint,
        "--expected-enrichment-version",
        "0",
      ],
      requiredFlag: "--expected-enrichment-version",
      input: { ...taskMutationInput, set: { summary: "Parser boundary fixture" }, clear: [] },
    },
    {
      name: "work complete",
      arguments: ["work", "complete", ...preconditionArguments],
      requiredFlag: "--expected-revision",
      input: { ...taskMutationInput, outcome: "Completed parser boundary fixture." },
    },
    {
      name: "annotation add",
      arguments: [
        "annotation",
        "add",
        ...commonArguments,
        "--expected-fingerprint",
        unknownFingerprint,
      ],
      requiredFlag: "--expected-fingerprint",
      input: { ...taskMutationInput, body: "Parser boundary annotation." },
    },
    {
      name: "annotation edit",
      arguments: [
        "annotation",
        "edit",
        ...commonArguments,
        "--expected-fingerprint",
        unknownFingerprint,
        "--annotation-id",
        randomUUID(),
        "--expected-version",
        "1",
      ],
      requiredFlag: "--expected-version",
      input: { ...taskMutationInput, body: "Edited parser boundary annotation." },
    },
    {
      name: "annotation delete",
      arguments: [
        "annotation",
        "delete",
        ...commonArguments,
        "--expected-fingerprint",
        unknownFingerprint,
        "--annotation-id",
        randomUUID(),
        "--expected-version",
        "1",
      ],
      requiredFlag: "--annotation-id",
      input: taskMutationInput,
    },
    {
      name: "organize place",
      arguments: ["organize", "place", ...preconditionArguments],
      requiredFlag: "--expected-revision",
      input: { ...taskMutationInput, targetPriority: "normal" },
    },
    {
      name: "organize place-many",
      arguments: [
        "organize",
        "place-many",
        "--dashboard-id",
        unknownDashboardId,
        "--expected-revision",
        "0",
      ],
      requiredFlag: "--expected-revision",
      input: {
        requestId: randomUUID(),
        targetPriority: "normal",
        items: [{ itemId: unknownItemId, expectedFingerprint: unknownFingerprint }],
      },
    },
    {
      name: "lifecycle archive",
      arguments: ["lifecycle", "archive", ...preconditionArguments],
      requiredFlag: "--expected-revision",
      input: { ...taskMutationInput, reason: "invalid" },
    },
    {
      name: "lifecycle restore",
      arguments: ["lifecycle", "restore", ...preconditionArguments],
      requiredFlag: "--expected-revision",
      input: taskMutationInput,
    },
    {
      name: "todo create",
      arguments: ["todo", "create", "--dashboard-id", unknownDashboardId],
      requiredFlag: "--dashboard-id",
      input: { ...taskMutationInput, title: "Parser boundary fixture", priority: "normal" },
    },
    {
      name: "follow-up create",
      arguments: ["follow-up", "create", ...preconditionArguments],
      requiredFlag: "--expected-revision",
      input: { requestId: randomUUID(), title: "Parser boundary fixture", priority: "normal" },
    },
  ];
  assert.equal(canonicalCommandCases.length, 18);
  for (const command of canonicalCommandCases) {
    const missing = command.missing ?? withoutFlag(command.arguments, command.requiredFlag);
    const duplicate =
      command.duplicate ?? withDuplicateFlag(command.arguments, command.requiredFlag);
    const malformed =
      command.malformed ?? withMalformedFlag(command.arguments, command.requiredFlag);
    assertInvalidArguments(`${command.name}: missing`, missing, command.input);
    assertInvalidArguments(`${command.name}: duplicate`, duplicate, command.input);
    assertInvalidArguments(
      `${command.name}: unknown flag`,
      [...command.arguments, "--database-path", "/private/dyna.sqlite3"],
      command.input,
    );
    assertInvalidArguments(
      `${command.name}: unknown positional argument`,
      [...command.arguments, "unexpected-positional-argument"],
      command.input,
    );
    assertInvalidArguments(`${command.name}: malformed`, malformed, command.input);
  }

  result = invoke(["dashboard", "list"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.schema, "dyna/dashboard-list-result-v1");
  assert.equal(result.json.dashboards.length, 2);
  assert.equal(result.json.total, 2);

  result = invoke(["dashboard", "show", "--dashboard-id", dashboard.id]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.schema, "dyna/dashboard-show-result-v1");
  assert.equal(result.json.dashboardId, dashboard.id);
  assert.equal(result.json.name, dashboard.name);
  assert.equal(result.json.counts.active, 22);
  assert.equal(JSON.stringify(result.json).includes("credentialMode"), false);
  assert.equal(JSON.stringify(result.json).includes("lastRunError"), false);

  const showArguments = ["item", "show", "--dashboard-id", dashboard.id, "--item-id", item.id];
  result = invoke(showArguments);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.schema, "dyna/item-show-result-v4");
  assert.equal(result.json.enrichmentVersion, 0);

  result = invoke(["item", "search", "--dashboard-id", dashboard.id, "--query", "Exercise"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.schema, "dyna/item-search-result-v3");
  assert.equal(result.json.items.length, 1);
  assert.equal(result.json.items[0].itemId, item.id);

  const updateRequest = randomUUID();
  const updateInput = {
    requestId: updateRequest,
    workAttemptId: randomUUID(),
    kind: "note",
    body: "CLI note",
    artifacts: [{ kind: "issue", label: "Issue", url: "https://example.com/issue/7" }],
    task: { taskId: cliTaskId, hostId: cliTaskHostId },
  };
  const updateArguments = [
    "work",
    "update",
    "--dashboard-id",
    dashboard.id,
    "--item-id",
    item.id,
    "--expected-fingerprint",
    item.fingerprint,
  ];
  result = invoke(updateArguments, updateInput);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.schema, "dyna/item-update-result-v1");
  assert.equal(result.json.deduplicated, false);
  assert.equal(result.json.control.itemNumber, item.itemNumber);
  assert.equal(result.json.control.deduplicated, false);
  const firstUpdateId = result.json.workUpdateId;
  const retry = invoke(updateArguments, updateInput);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(retry.json.workUpdateId, result.json.workUpdateId);
  assert.equal(retry.json.deduplicated, true);

  result = invoke(updateArguments, {
    ...updateInput,
    requestId: randomUUID(),
    body: "Second CLI note",
    artifacts: [],
    supersedesWorkUpdateId: firstUpdateId,
  });
  assert.equal(result.status, 0, result.stderr);

  result = invoke([
    "item",
    "activity",
    "--dashboard-id",
    dashboard.id,
    "--item-id",
    item.id,
    "--limit",
    "1",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.schema, "dyna/item-activity-result-v2");
  assert.equal(result.json.activity.updates.length, 1);
  assert.equal(result.json.activity.total, 2);
  assert.deepEqual(result.json.activity.updates[0]?.task, {
    taskId: cliTaskId,
    hostId: cliTaskHostId,
    title: cliTaskTitle,
  });
  assert.equal(typeof result.json.activity.nextCursor, "string");
  const activityPageTwo = invoke([
    "item",
    "activity",
    "--dashboard-id",
    dashboard.id,
    "--item-id",
    item.id,
    "--limit",
    "1",
    "--cursor",
    result.json.activity.nextCursor,
  ]);
  assert.equal(activityPageTwo.status, 0, activityPageTwo.stderr);
  assert.equal(activityPageTwo.json.activity.updates.length, 1);

  result = invoke([
    "item",
    "history",
    "--dashboard-id",
    dashboard.id,
    "--item-id",
    item.id,
    "--limit",
    "1",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.schema, "dyna/item-history-result-v2");
  assert.equal(result.json.history.workUpdates.length, 1);
  assert.equal(typeof result.json.history.workUpdatesNextCursor, "string");
  const historyPageTwo = invoke([
    "item",
    "history",
    "--dashboard-id",
    dashboard.id,
    "--item-id",
    item.id,
    "--limit",
    "1",
    "--work-cursor",
    result.json.history.workUpdatesNextCursor,
  ]);
  assert.equal(historyPageTwo.status, 0, historyPageTwo.stderr);
  assert.equal(historyPageTwo.json.history.workUpdates.length, 1);

  let shown = invoke(showArguments).json;
  const enrichArguments = [
    "work",
    "enrich",
    "--dashboard-id",
    dashboard.id,
    "--item-id",
    item.id,
    "--expected-fingerprint",
    item.fingerprint,
    "--expected-enrichment-version",
    "0",
  ];
  result = invoke(enrichArguments, {
    requestId: randomUUID(),
    workAttemptId: updateInput.workAttemptId,
    task: updateInput.task,
    set: { summary: "Enriched through the CLI." },
    clear: [],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.enrichmentVersion, 1);

  const annotationCommonInput = {
    requestId: randomUUID(),
    workAttemptId: updateInput.workAttemptId,
    task: updateInput.task,
  };
  const annotationAddArguments = [
    "annotation",
    "add",
    "--dashboard-id",
    dashboard.id,
    "--item-id",
    item.id,
    "--expected-fingerprint",
    item.fingerprint,
  ];
  result = invoke(annotationAddArguments, {
    ...annotationCommonInput,
    body: "CLI editable annotation",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.schema, "dyna/cli-annotation-mutation-result-v1");
  assert.equal(result.json.version, 1);
  assert.equal(result.json.deleted, false);
  const annotationId = result.json.annotationId;
  const annotationVerifier = new DynaApplicationService({ databasePath });
  const projectedAnnotation = annotationVerifier
    .snapshot(dashboard.id)
    .cards.find((card) => card.id === item.id)
    ?.annotations.find((annotation) => annotation.id === annotationId);
  assert.deepEqual(projectedAnnotation?.task, {
    taskId: cliTaskId,
    hostId: cliTaskHostId,
    title: cliTaskTitle,
  });
  assert.equal(projectedAnnotation?.workAttemptId, updateInput.workAttemptId);
  annotationVerifier.close();
  const annotationRetry = invoke(annotationAddArguments, {
    ...annotationCommonInput,
    body: "CLI editable annotation",
  });
  assert.equal(annotationRetry.status, 0, annotationRetry.stderr);
  assert.equal(annotationRetry.json.annotationId, annotationId);
  assert.equal(annotationRetry.json.deduplicated, true);

  const annotationEditArguments = [
    "annotation",
    "edit",
    ...annotationAddArguments.slice(2),
    "--annotation-id",
    annotationId,
    "--expected-version",
    "1",
  ];
  result = invoke(annotationEditArguments, {
    ...annotationCommonInput,
    requestId: randomUUID(),
    body: "CLI edited annotation",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.version, 2);

  const annotationDeleteArguments = [
    "annotation",
    "delete",
    ...annotationAddArguments.slice(2),
    "--annotation-id",
    annotationId,
    "--expected-version",
    "2",
  ];
  result = invoke(annotationDeleteArguments, {
    ...annotationCommonInput,
    requestId: randomUUID(),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.deleted, true);
  assert.equal(result.json.version, 3);

  result = invoke([
    "item",
    "history",
    "--dashboard-id",
    dashboard.id,
    "--item-id",
    item.id,
    "--limit",
    "2",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.history.annotationEvents.length, 2);
  assert.equal(result.json.history.annotationEvents[0].operation, "delete");
  assert.equal(result.json.history.annotationEvents[0].body, undefined);
  assert.equal(typeof result.json.history.annotationEventsNextCursor, "string");

  result = invoke(["todo", "create", "--dashboard-id", dashboard.id], {
    requestId: randomUUID(),
    title: "CLI to-do",
    priority: "normal",
    labels: ["cli"],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.schema, "dyna/todo-create-result-v2");
  assert.equal(result.json.deduplicated, false);
  const todoItemId = result.json.itemId;
  const todoFingerprint = result.json.fingerprint;

  result = invoke(["item", "search", "--dashboard-id", dashboard.id]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.total, 23);
  assert.equal(result.json.items.length, 20);

  shown = invoke(showArguments).json;
  const placeArguments = [
    "organize",
    "place",
    "--dashboard-id",
    dashboard.id,
    "--item-id",
    item.id,
    "--expected-fingerprint",
    item.fingerprint,
    "--expected-revision",
    String(shown.revision),
  ];
  result = invoke(placeArguments, {
    requestId: randomUUID(),
    workAttemptId: updateInput.workAttemptId,
    task: updateInput.task,
    targetPriority: "high",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.changed, true);

  const todoShown = invoke([
    "item",
    "show",
    "--dashboard-id",
    dashboard.id,
    "--item-id",
    todoItemId,
  ]);
  assert.equal(todoShown.status, 0, todoShown.stderr);
  result = invoke(
    [
      "organize",
      "place-many",
      "--dashboard-id",
      dashboard.id,
      "--expected-revision",
      String(todoShown.json.revision),
    ],
    {
      requestId: randomUUID(),
      targetPriority: "high",
      items: [{ itemId: todoItemId, expectedFingerprint: todoFingerprint }],
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.schema, "dyna/place-many-result-v1");
  assert.equal(result.json.changed, true);
  assert.equal(result.json.changedCount, 1);

  shown = invoke(showArguments).json;
  const archiveArguments = [
    "lifecycle",
    "archive",
    "--dashboard-id",
    dashboard.id,
    "--item-id",
    item.id,
    "--expected-fingerprint",
    item.fingerprint,
    "--expected-revision",
    String(shown.revision),
  ];
  result = invoke(archiveArguments, {
    requestId: randomUUID(),
    workAttemptId: updateInput.workAttemptId,
    task: updateInput.task,
    reason: "invalid",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.reason, "invalid");

  result = invoke([
    "item",
    "search",
    "--dashboard-id",
    dashboard.id,
    "--scope",
    "archive",
    "--query",
    "Exercise",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.items.length, 1);
  assert.equal(result.json.items[0].itemId, item.id);

  shown = invoke(showArguments).json;
  const followArguments = [
    "follow-up",
    "create",
    "--dashboard-id",
    dashboard.id,
    "--item-id",
    item.id,
    "--expected-fingerprint",
    item.fingerprint,
    "--expected-revision",
    String(shown.revision),
  ];
  result = invoke(followArguments, {
    requestId: randomUUID(),
    workAttemptId: updateInput.workAttemptId,
    task: updateInput.task,
    title: "CLI follow-up",
    priority: "normal",
    labels: [],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.sourceItemId, item.id);

  shown = invoke(showArguments).json;
  const restoreArguments = [
    "lifecycle",
    "restore",
    "--dashboard-id",
    dashboard.id,
    "--item-id",
    item.id,
    "--expected-fingerprint",
    item.fingerprint,
    "--expected-revision",
    String(shown.revision),
  ];
  result = invoke(restoreArguments, {
    requestId: randomUUID(),
    workAttemptId: updateInput.workAttemptId,
    task: updateInput.task,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.itemId, item.id);

  shown = invoke(showArguments).json;
  const completeArguments = [
    "work",
    "complete",
    "--dashboard-id",
    dashboard.id,
    "--item-id",
    item.id,
    "--expected-fingerprint",
    item.fingerprint,
    "--expected-revision",
    String(shown.revision),
  ];
  const completeInput = {
    requestId: randomUUID(),
    workAttemptId: updateInput.workAttemptId,
    task: updateInput.task,
    outcome: "Completed the CLI integration workflow.",
    body: "Validated linked-item mutation coverage.",
    artifacts: [{ kind: "report", label: "CLI report", url: "https://example.com/cli-report" }],
  };
  result = invoke(completeArguments, completeInput);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.schema, "dyna/work-complete-result-v1");
  assert.equal(result.json.nativeTaskSuccessCertified, false);
  assert.equal(result.json.control.workflowState, "completed");
  const completed = invoke(showArguments);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(completed.json.item.completionAuthority, "dyna_task");
  assert.equal(completed.json.item.completionTask.taskId, cliTaskId);
  assert.equal(completed.json.item.outcome, completeInput.outcome);

  const secretMarker = "do-not-echo-this-private-value";
  const invalid = spawnSync(executable, [...executablePrefix, ...updateArguments], {
    encoding: "utf8",
    env: environment,
    cwd: workingDirectory,
    input: `${JSON.stringify({ requestId: randomUUID(), body: secretMarker })}\n`,
  });
  assert.equal(invalid.status, 1);
  const error = JSON.parse(invalid.stderr);
  assert.equal(error.schema, "dyna/error-v1");
  assert.equal(error.code, "invalid_input");
  assert.equal(invalid.stderr.includes(secretMarker), false);
  assert.equal(invalid.stdout, "");

  const unknownField = invoke(updateArguments, {
    ...updateInput,
    requestId: randomUUID(),
    unexpectedPrivateField: secretMarker,
  });
  assert.equal(unknownField.status, 1);
  assert.equal(JSON.parse(unknownField.stderr).code, "invalid_input");
  assert.equal(unknownField.stderr.includes(secretMarker), false);

  const malformed = spawnSync(executable, [...executablePrefix, ...updateArguments], {
    encoding: "utf8",
    env: environment,
    cwd: workingDirectory,
    input: `{"private":"${secretMarker}",`,
  });
  assert.equal(malformed.status, 1);
  assert.equal(JSON.parse(malformed.stderr).code, "invalid_input");
  assert.equal(malformed.stderr.includes(secretMarker), false);

  const oversized = spawnSync(executable, [...executablePrefix, ...updateArguments], {
    encoding: "utf8",
    env: environment,
    cwd: workingDirectory,
    input: JSON.stringify({ private: secretMarker, padding: "x".repeat(33 * 1024) }),
  });
  assert.equal(oversized.status, 1);
  assert.equal(JSON.parse(oversized.stderr).code, "invalid_input");
  assert.equal(oversized.stderr.includes(secretMarker), false);

  const unknownCommand = spawnSync(executable, [...executablePrefix, "item", "sql"], {
    encoding: "utf8",
    env: environment,
    cwd: workingDirectory,
  });
  assert.equal(unknownCommand.status, 1);
  assert.equal(JSON.parse(unknownCommand.stderr).code, "invalid_input");

  const current = invoke(showArguments).json;
  const legacyCases = [
    {
      arguments: ["item", "update", ...updateArguments.slice(2)],
      input: { ...updateInput, requestId: randomUUID(), workAttemptId: randomUUID() },
    },
    {
      arguments: [
        "item",
        "enrich",
        "--dashboard-id",
        dashboard.id,
        "--item-id",
        item.id,
        "--expected-fingerprint",
        item.fingerprint,
        "--expected-enrichment-version",
        "1",
      ],
      input: { requestId: randomUUID(), summary: "Legacy alias must not run." },
    },
    {
      arguments: [
        "item",
        "place",
        "--dashboard-id",
        dashboard.id,
        "--item-id",
        item.id,
        "--expected-fingerprint",
        item.fingerprint,
        "--expected-revision",
        String(current.revision),
      ],
      input: { requestId: randomUUID(), targetPriority: "low" },
    },
    {
      arguments: [
        "item",
        "place-many",
        "--dashboard-id",
        dashboard.id,
        "--expected-revision",
        String(current.revision),
      ],
      input: {
        requestId: randomUUID(),
        targetPriority: "low",
        items: [{ itemId: item.id, expectedFingerprint: item.fingerprint }],
      },
    },
    {
      arguments: [
        "item",
        "archive",
        "--dashboard-id",
        dashboard.id,
        "--item-id",
        item.id,
        "--expected-fingerprint",
        item.fingerprint,
        "--expected-revision",
        String(current.revision),
      ],
      input: { requestId: randomUUID(), reason: "invalid" },
    },
    {
      arguments: [
        "item",
        "restore",
        "--dashboard-id",
        dashboard.id,
        "--item-id",
        item.id,
        "--expected-fingerprint",
        item.fingerprint,
        "--expected-revision",
        String(current.revision),
      ],
      input: { requestId: randomUUID() },
    },
  ];
  for (const legacy of legacyCases) {
    const rejected = invoke(legacy.arguments, legacy.input);
    assert.equal(rejected.status, 1);
    assert.equal(JSON.parse(rejected.stderr).code, "invalid_input");
  }

  for (const legacyUtility of [
    ["-h"],
    ["help"],
    ["version"],
    ["--help", "extra"],
    ["--version", "extra"],
    ["setup", "extra"],
  ]) {
    const rejected = invoke(legacyUtility);
    assert.equal(rejected.status, 1);
    assert.equal(JSON.parse(rejected.stderr).code, "invalid_input");
  }

  const maximumQuery = invoke([
    "item",
    "search",
    "--dashboard-id",
    dashboard.id,
    "--query",
    "q".repeat(500),
    "--scope",
    "active",
  ]);
  assert.equal(maximumQuery.status, 0, maximumQuery.stderr);
  assert.equal(maximumQuery.json.query.length, 500);
  const maximumHistory = invoke([
    "item",
    "history",
    "--dashboard-id",
    dashboard.id,
    "--item-id",
    item.id,
    "--limit",
    "50",
  ]);
  assert.equal(maximumHistory.status, 0, maximumHistory.stderr);
  const maximumActivity = invoke([
    "item",
    "activity",
    "--dashboard-id",
    dashboard.id,
    "--item-id",
    item.id,
    "--limit",
    "25",
  ]);
  assert.equal(maximumActivity.status, 0, maximumActivity.stderr);

  const rejectedReadCommands = [
    ["dashboard", "list", "--limit", "1"],
    ["item", "search", "--dashboard-id", dashboard.id, "--limit", "1"],
    ["item", "search", "--dashboard-id", dashboard.id, "--query", "q".repeat(501)],
    ["item", "search", "--dashboard-id", dashboard.id, "--scope", "all"],
    ["item", "history", "--dashboard-id", dashboard.id, "--item-id", item.id, "--limit", "0"],
    ["item", "history", "--dashboard-id", dashboard.id, "--item-id", item.id, "--limit", "51"],
    [
      "item",
      "history",
      "--dashboard-id",
      dashboard.id,
      "--item-id",
      item.id,
      "--work-cursor",
      "c".repeat(513),
    ],
    ["item", "activity", "--dashboard-id", dashboard.id, "--item-id", item.id, "--limit", "0"],
    ["item", "activity", "--dashboard-id", dashboard.id, "--item-id", item.id, "--limit", "26"],
    [
      "item",
      "activity",
      "--dashboard-id",
      dashboard.id,
      "--item-id",
      item.id,
      "--cursor",
      "c".repeat(513),
    ],
  ];
  for (const arguments_ of rejectedReadCommands) {
    const rejected = invoke(arguments_);
    assert.equal(rejected.status, 1);
    assert.equal(JSON.parse(rejected.stderr).code, "invalid_input");
  }

  const missing = invoke(["item", "show", "--dashboard-id", randomUUID(), "--item-id", item.id]);
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stderr).code, "not_found");

  globalThis.process.stdout.write(
    JSON.stringify({
      dashboardList: true,
      dashboardShow: true,
      itemSearch: true,
      itemShow: true,
      itemHistory: true,
      itemActivity: true,
      workUpdate: true,
      retry: true,
      workEnrich: true,
      organizePlace: true,
      organizePlaceMany: true,
      lifecycleArchive: true,
      lifecycleRestore: true,
      todoCreate: true,
      followUpCreate: true,
      redactedErrors: true,
      strictInput: true,
      boundedInput: true,
      commandAllowlist: true,
      legacyAliasesRejected: true,
      strictReadSurface: true,
      canonicalArgumentMatrix: true,
      optionalBounds: true,
      portableLaunch: true,
      help: true,
      version: true,
      setup: true,
      notFound: true,
    }),
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

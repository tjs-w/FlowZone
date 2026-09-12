import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { DynaStore } from "../../packages/dyna-node/src/store.ts";

const temporaryRoot = mkdtempSync(join(tmpdir(), "flowzone-dyna-cli-"));
const directory = join(temporaryRoot, "Dyna data ü with spaces");
const workingDirectory = join(temporaryRoot, "Arbitrary working Δ directory");
mkdirSync(directory);
mkdirSync(workingDirectory);
const executable = resolve(import.meta.dirname, "../../bin/dyna");
const environment = {
  ...globalThis.process.env,
  FLOWZONE_DATA_DIR: directory,
  FLOWZONE_NODE_PATH: globalThis.process.execPath,
  PATH: "/usr/bin:/bin",
};

function invoke(arguments_, input) {
  const result = spawnSync(executable, arguments_, {
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

try {
  let result = invoke(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.schema, "dyna/help-v1");
  assert.ok(result.json.commands.length >= 8);
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

  const store = new DynaStore({ databasePath: join(directory, "dyna.sqlite3") });
  const dashboard = store.createDashboard("CLI", "Bundled command coverage");
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
    ],
    {
      runId: "cli-run",
      sourceCompletedAt: new Date().toISOString(),
      mode: "replace",
      status: "succeeded",
    },
  );
  const item = store.snapshot(dashboard.id).cards[0];
  assert.ok(item);
  store.close();

  const showArguments = ["item", "show", "--dashboard-id", dashboard.id, "--item-id", item.id];
  result = invoke(showArguments);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.schema, "dyna/item-show-result-v1");
  assert.equal(result.json.enrichmentVersion, 0);

  const updateRequest = randomUUID();
  const updateInput = {
    requestId: updateRequest,
    workAttemptId: randomUUID(),
    kind: "note",
    body: "CLI note",
    artifacts: [{ kind: "issue", label: "Issue", url: "https://example.com/issue/7" }],
  };
  const updateArguments = [
    "item",
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
  const retry = invoke(updateArguments, updateInput);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(retry.json.workUpdateId, result.json.workUpdateId);
  assert.equal(retry.json.deduplicated, true);

  let shown = invoke(showArguments).json;
  const enrichArguments = [
    "item",
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
    summary: "Enriched through the CLI.",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.enrichmentVersion, 1);

  shown = invoke(showArguments).json;
  const placeArguments = [
    "item",
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
  result = invoke(placeArguments, { requestId: randomUUID(), targetPriority: "high" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.changed, true);

  shown = invoke(showArguments).json;
  const archiveArguments = [
    "item",
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
  result = invoke(archiveArguments, { requestId: randomUUID(), reason: "invalid" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.reason, "invalid");

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
    title: "CLI follow-up",
    priority: "normal",
    labels: [],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.sourceItemId, item.id);

  shown = invoke(showArguments).json;
  const restoreArguments = [
    "item",
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
  result = invoke(restoreArguments, { requestId: randomUUID() });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.itemId, item.id);

  const secretMarker = "do-not-echo-this-private-value";
  const invalid = spawnSync(executable, updateArguments, {
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

  const malformed = spawnSync(executable, updateArguments, {
    encoding: "utf8",
    env: environment,
    cwd: workingDirectory,
    input: `{"private":"${secretMarker}",`,
  });
  assert.equal(malformed.status, 1);
  assert.equal(JSON.parse(malformed.stderr).code, "invalid_input");
  assert.equal(malformed.stderr.includes(secretMarker), false);

  const oversized = spawnSync(executable, updateArguments, {
    encoding: "utf8",
    env: environment,
    cwd: workingDirectory,
    input: JSON.stringify({ private: secretMarker, padding: "x".repeat(33 * 1024) }),
  });
  assert.equal(oversized.status, 1);
  assert.equal(JSON.parse(oversized.stderr).code, "invalid_input");
  assert.equal(oversized.stderr.includes(secretMarker), false);

  const unknownCommand = spawnSync(executable, ["item", "sql"], {
    encoding: "utf8",
    env: environment,
    cwd: workingDirectory,
  });
  assert.equal(unknownCommand.status, 1);
  assert.equal(JSON.parse(unknownCommand.stderr).code, "invalid_input");

  const missing = invoke(["item", "show", "--dashboard-id", randomUUID(), "--item-id", item.id]);
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stderr).code, "not_found");

  globalThis.process.stdout.write(
    JSON.stringify({
      show: true,
      update: true,
      retry: true,
      enrich: true,
      place: true,
      archive: true,
      followUp: true,
      restore: true,
      redactedErrors: true,
      strictInput: true,
      boundedInput: true,
      commandAllowlist: true,
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

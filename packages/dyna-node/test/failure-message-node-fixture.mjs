import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DynaStore } from "../src/store.ts";

const now = "2026-09-03T20:00:00.000Z";
let clockMs = Date.parse(now);
const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-failure-message-"));
const databasePath = join(directory, "dyna.sqlite3");
const fakePassword = "not-a-real-password";
const fakeBearer = "not.a.real.bearer.token";
const fakeGitLabToken = "glpat-notarealsecret123456";
const fakeApiKey = "not-a-real-api-key";
const fakeEnvironmentSecret = "opaque-environment-secret-value";
const fakePrivateKeyMaterial = "MIIE-not-real-private-key-material";

function assertPublicSafe(value) {
  assert.equal(typeof value, "string");
  assert.ok(value.length > 0 && value.length <= 500);
  assert.doesNotMatch(value, /[\r\n\u2028\u2029]/);
  assert.equal(value.includes(fakePassword), false);
  assert.equal(value.includes(fakeBearer), false);
  assert.equal(value.includes(fakeGitLabToken), false);
  assert.equal(value.includes(fakeApiKey), false);
  assert.equal(value.includes(fakeEnvironmentSecret), false);
  assert.equal(value.includes(fakePrivateKeyMaterial), false);
  assert.match(value, /\[REDACTED\]/);
}

try {
  const store = new DynaStore({ databasePath, clock: () => new Date(clockMs) });
  const dashboard = store.createDashboard("Safe failures", "Public failure messages");
  const { publisher, secret } = store.createPublisher("Failure source");
  store.bindSchedule(dashboard.id, publisher.id, {
    id: "failure-source",
    title: "Failure source",
    state: "active",
    staleAfterMinutes: 60,
  });

  const unsafeRunFailure =
    `Connector failed\npassword=${fakePassword}\r\nBearer ${fakeBearer}; token=${fakeGitLabToken}; {"api_key":"${fakeApiKey}"}; OPENAI_API_KEY=${fakeEnvironmentSecret}; -----BEGIN PRIVATE KEY-----\n${fakePrivateKeyMaterial}\n-----END PRIVATE KEY----- ` +
    "x".repeat(700);
  store.publish(
    publisher.id,
    secret,
    [
      {
        externalId: "failure-item",
        sourceRef: {
          source: "gitlab",
          instanceId: "corp",
          projectPath: "team/project",
          iid: 19,
          entityType: "pipeline",
        },
        sourceScope: "team/project",
        title: "Sanitize connector failure",
        summary: "Failure details are public-safe.",
        priority: "high",
        priorityReason: "Security regression.",
        sourceUpdatedAt: now,
        labels: [],
      },
    ],
    {
      runId: "partial-with-safe-error",
      sourceCompletedAt: now,
      mode: "upsert",
      status: "partial",
      failureMessage: unsafeRunFailure,
    },
  );
  assert.throws(
    () =>
      store.publish(publisher.id, secret, [], {
        runId: "blank-error",
        sourceCompletedAt: now,
        mode: "upsert",
        status: "failed",
        failureMessage: "\n\t",
      }),
    /failure message cannot be empty/,
  );

  const snapshot = store.snapshot(dashboard.id);
  const publicRunFailure = snapshot.schedules[0]?.lastRunError;
  assertPublicSafe(publicRunFailure);
  const item = snapshot.cards[0];
  assert.ok(item);
  const viewToken = store.createView(dashboard.id);
  const request = store.prepareAction(viewToken, "open_source", {
    itemId: item.id,
    expectedRevision: snapshot.revision,
    expectedFingerprint: item.fingerprint,
    idempotencyKey: "safe-action-failure",
  });
  store.markDelivered(viewToken, request.id);
  const claimed = store.claimAction(request.id);
  assert.equal(
    store.completeAction(request.id, claimed.claimToken, {
      outcome: "failed",
      failureMessage:
        `Open failed\nAuthorization: Basic ${fakeBearer} ${fakeGitLabToken} ` + "y".repeat(700),
    }).state,
    "failed",
  );
  const reconciliationRequest = store.prepareAction(viewToken, "create_codex_task", {
    itemId: item.id,
    expectedRevision: snapshot.revision,
    expectedFingerprint: item.fingerprint,
    idempotencyKey: "safe-reconciliation-explanation",
  });
  store.markDelivered(viewToken, reconciliationRequest.id);
  store.claimAction(reconciliationRequest.id);
  clockMs += 5 * 60_000 + 1;
  assert.equal(
    store.actionStatusForView(viewToken, reconciliationRequest.id).state,
    "needs_reconciliation",
  );
  assert.equal(
    store.resolveActionReconciliation(reconciliationRequest.id, {
      outcome: "no_task_created",
      explanation:
        `Inventory checked\npassword=${fakePassword}; Bearer ${fakeBearer}; token=${fakeGitLabToken} ` +
        "z".repeat(700),
    }).state,
    "failed",
  );
  store.close();

  const raw = new DatabaseSync(databasePath);
  const persistedPublisherFailure = raw
    .prepare("SELECT last_run_error FROM publishers WHERE id = ?")
    .get(publisher.id).last_run_error;
  const persistedRunFailure = raw
    .prepare("SELECT failure_message FROM publisher_runs WHERE publisher_id = ? AND run_id = ?")
    .get(publisher.id, "partial-with-safe-error").failure_message;
  const persistedActionFailure = raw
    .prepare("SELECT failure_message FROM action_requests WHERE id = ?")
    .get(request.id).failure_message;
  const persistedExplanation = raw
    .prepare("SELECT failure_message FROM action_requests WHERE id = ?")
    .get(reconciliationRequest.id).failure_message;
  assertPublicSafe(persistedPublisherFailure);
  assertPublicSafe(persistedRunFailure);
  assertPublicSafe(persistedActionFailure);
  assertPublicSafe(persistedExplanation);

  // Defense in depth: even a legacy/raw unsafe value is sanitized before a snapshot.
  raw
    .prepare("UPDATE publishers SET last_run_error = ? WHERE id = ?")
    .run(unsafeRunFailure, publisher.id);
  raw.close();
  const reopened = new DynaStore({ databasePath, clock: () => new Date(clockMs) });
  assertPublicSafe(reopened.snapshot(dashboard.id).schedules[0]?.lastRunError);
  reopened.close();

  globalThis.process.stdout.write(
    JSON.stringify({ bounded: true, singleLine: true, secretsRedacted: true }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

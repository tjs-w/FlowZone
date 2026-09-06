import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import { DynaStore } from "../../packages/dyna-node/src/store.ts";

const dataDirectory = mkdtempSync(join(tmpdir(), "flowzone-publish-"));
const databasePath = join(dataDirectory, "dyna.sqlite3");
const publisherLauncher = resolve(import.meta.dirname, "../../bin/flowzone-publish");
const sourceSlices = [{ source: "codex", sourceScope: "codex:local" }];

try {
  const store = new DynaStore({ databasePath });
  const dashboard = store.createDashboard("CLI", "Local publisher test");
  const created = store.createPublisher(
    "Scheduled CLI",
    { id: "cli-schedule", title: "CLI schedule", state: "active" },
    sourceSlices,
    "local_cli",
  );
  store.bindSchedule(dashboard.id, created.publisher.id, {
    id: "cli-schedule",
    title: "CLI schedule",
    state: "active",
    staleAfterMinutes: 60,
    requiredSourceSlices: sourceSlices,
  });
  store.close();

  const sourceCompletedAt = new Date().toISOString();
  const input = {
    runId: "cli-run-1",
    sourceCompletedAt,
    sourceSlices: [{ ...sourceSlices[0], status: "succeeded" }],
    items: [
      {
        externalId: "codex:cli-task",
        sourceRef: { source: "codex", taskId: "cli-task" },
        sourceScope: "codex:local",
        title: "Review the local publication",
        summary: "Published by the bundled CLI.",
        priority: "high",
        priorityReason: "Direct request.",
        sourceUpdatedAt: sourceCompletedAt,
      },
    ],
  };
  const published = spawnSync(publisherLauncher, ["--publisher", created.publisher.id], {
    encoding: "utf8",
    env: {
      ...process.env,
      FLOWZONE_DATA_DIR: dataDirectory,
      FLOWZONE_NODE_PATH: process.execPath,
    },
    input: JSON.stringify(input),
  });
  assert.equal(published.status, 0, published.stderr);
  assert.deepEqual(JSON.parse(published.stdout), {
    accepted: 1,
    deduplicated: false,
    superseded: false,
    status: "succeeded",
  });
  assert.equal(published.stdout.includes("secret"), false);

  const reopened = new DynaStore({ databasePath });
  assert.equal(reopened.snapshot(dashboard.id).cards[0]?.title, "Review the local publication");
  reopened.close();

  const marker = "DO_NOT_ECHO_PRIVATE_SOURCE_DATA";
  const malformed = spawnSync(publisherLauncher, ["--publisher", randomUUID()], {
    encoding: "utf8",
    env: { ...process.env, FLOWZONE_NODE_PATH: process.execPath },
    input: JSON.stringify({ marker }),
  });
  assert.notEqual(malformed.status, 0);
  assert.equal(malformed.stdout, "");
  assert.equal(malformed.stderr.includes(marker), false);
  assert.match(malformed.stderr, /schema-valid JSON run/);

  process.stdout.write(
    JSON.stringify({ malformedInputRedacted: true, published: true, secretFree: true }),
  );
} finally {
  rmSync(dataDirectory, { force: true, recursive: true });
}

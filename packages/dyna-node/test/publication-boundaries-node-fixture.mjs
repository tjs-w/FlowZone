import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DynaStore } from "../src/store.ts";

let clockMs = Date.now() - 60_000;
const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-publication-boundaries-"));
const databasePath = join(directory, "dyna.sqlite3");
const store = new DynaStore({ databasePath, clock: () => new Date(clockMs) });

function publishedItem(externalId, priority) {
  return {
    externalId,
    sourceRef: { source: "codex", taskId: externalId },
    sourceScope: "codex:local",
    title: externalId,
    summary: `${externalId} summary`,
    priority,
    priorityReason: "Source-declared urgency.",
    sourceUpdatedAt: new Date(clockMs).toISOString(),
    labels: [],
  };
}

try {
  const dashboard = store.createDashboard("Publication boundaries", "Trust boundary checks");
  const disabled = store.createPublisher("Protected production publisher");
  assert.equal(disabled.publisher.credentialMode, "disabled");
  assert.equal("secret" in disabled, false);
  assert.throws(
    () =>
      store.createPublisher(
        "Invalid active publisher",
        {
          id: "invalid-active",
          title: "Invalid active",
          state: "active",
          staleAfterMinutes: 60,
        },
        undefined,
        "disabled",
      ),
    /disabled Dyna publisher cannot use an active schedule/,
  );
  assert.throws(
    () =>
      store.bindSchedule(dashboard.id, disabled.publisher.id, {
        id: "protected-production",
        title: "Protected production",
        state: "active",
        staleAfterMinutes: 60,
      }),
    /disabled Dyna publisher cannot use an active schedule/,
  );
  store.bindSchedule(dashboard.id, disabled.publisher.id, {
    id: "protected-production",
    title: "Protected production",
    state: "paused",
    staleAfterMinutes: 60,
  });
  assert.throws(
    () => store.updateScheduleStatus(disabled.publisher.id, { state: "active" }),
    /disabled Dyna publisher cannot use an active schedule/,
  );
  assert.throws(
    () => store.rotatePublisherSecret(disabled.publisher.id),
    /disabled Dyna publisher cannot rotate credentials/,
  );
  assert.throws(
    () =>
      store.publish(disabled.publisher.id, "unavailable", [], {
        runId: "disabled-run",
        sourceCompletedAt: new Date(clockMs).toISOString(),
        mode: "replace",
        status: "succeeded",
      }),
    /credentials are invalid/,
  );

  const local = store.createPublisher(
    "Trusted local preview",
    undefined,
    undefined,
    "local_preview",
  );
  assert.equal(local.publisher.credentialMode, "local_preview");
  assert.ok(local.secret);
  store.bindSchedule(dashboard.id, local.publisher.id, {
    id: "trusted-local-preview",
    title: "Trusted local preview",
    state: "active",
    staleAfterMinutes: 60,
  });

  assert.throws(
    () =>
      store.publish(
        local.publisher.id,
        local.secret,
        [
          {
            externalId: "manual-forgery",
            sourceRef: {
              source: "manual",
              todoId: "bd9a11b5-fbf8-495a-a116-d3429496969f",
            },
            sourceScope: "manual:dashboard",
            title: "Forged manual record",
            summary: "A scheduled publisher must not impersonate a user-created to-do.",
            priority: "critical",
            priorityReason: "Forged urgency.",
            sourceUpdatedAt: new Date(clockMs).toISOString(),
            labels: [],
          },
        ],
        {
          runId: "manual-forgery",
          sourceCompletedAt: new Date(clockMs).toISOString(),
          mode: "replace",
          status: "succeeded",
        },
      ),
    /Scheduled Dyna publishers cannot publish manual records/,
  );

  const sourceAt = new Date(clockMs).toISOString();
  store.publish(local.publisher.id, local.secret, [publishedItem("source-high", "high")], {
    runId: "source-high",
    sourceCompletedAt: sourceAt,
    mode: "replace",
    status: "succeeded",
  });
  const highCard = store.snapshot(dashboard.id).cards.find((card) => card.title === "source-high");
  assert.ok(highCard);
  const highContext = store.itemContext(highCard.id);
  assert.throws(
    () =>
      store.applyEnrichment(highCard.id, {
        priority: "critical",
        priorityReason: "Enrichment must not manufacture critical urgency.",
        expectedFingerprint: highContext.fingerprint,
        expectedEnrichmentVersion: highContext.enrichment?.version ?? 0,
        provenance: "test-enrichment",
      }),
    /unless the source priority is already critical/,
  );

  const viewToken = store.createView(dashboard.id);
  const beforeOverride = store.snapshot(dashboard.id);
  assert.equal(
    store.organizeItem(
      viewToken,
      highCard.id,
      "bump",
      beforeOverride.revision,
      highCard.fingerprint,
    ).changed,
    true,
  );
  assert.equal(
    store.snapshot(dashboard.id).cards.find((card) => card.id === highCard.id)?.priority,
    "critical",
  );

  const raw = new DatabaseSync(databasePath, { readOnly: true });
  const priorityState = raw
    .prepare(
      `SELECT e.priority AS enrichment_priority, p.priority_override
       FROM items i
       LEFT JOIN item_enrichments e ON e.item_id = i.id
       LEFT JOIN item_preferences p ON p.item_id = i.id AND p.dashboard_id = ?
       WHERE i.id = ?`,
    )
    .get(dashboard.id, highCard.id);
  assert.equal(priorityState.enrichment_priority, null);
  assert.equal(priorityState.priority_override, "critical");
  raw.close();

  clockMs += 1_000;
  const criticalAt = new Date(clockMs).toISOString();
  store.publish(local.publisher.id, local.secret, [publishedItem("source-critical", "critical")], {
    runId: "source-critical",
    sourceCompletedAt: criticalAt,
    mode: "upsert",
    status: "succeeded",
  });
  const criticalCard = store
    .snapshot(dashboard.id)
    .cards.find((card) => card.title === "source-critical");
  assert.ok(criticalCard);
  const criticalContext = store.itemContext(criticalCard.id);
  store.applyEnrichment(criticalCard.id, {
    priority: "critical",
    priorityReason: "The source already declared critical urgency.",
    expectedFingerprint: criticalContext.fingerprint,
    expectedEnrichmentVersion: criticalContext.enrichment?.version ?? 0,
    provenance: "test-enrichment",
  });

  globalThis.process.stdout.write(
    JSON.stringify({
      scheduledManualRejected: true,
      criticalEnrichmentBounded: true,
      manualOverridePreserved: true,
      disabledModeEnforced: true,
      localPreviewOperational: true,
    }),
  );
} finally {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}

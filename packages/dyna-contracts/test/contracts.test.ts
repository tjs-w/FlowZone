import { describe, expect, test } from "bun:test";

import {
  DynaArtifactRefSchema,
  DynaActionKindSchema,
  DynaCodexSessionCandidatesSchema,
  DynaPublishSourceSlicesSchema,
  DynaPublisherSchema,
  DynaRequiredSourceSlicesSchema,
  DynaScheduledPublishedItemSchema,
  DynaUiPayloadSchema,
  DynaPublishedItemSchema,
  DynaTaskStatusSchema,
  DynaCardSchema,
  DynaItemContextSchema,
  DynaItemHistorySchema,
  DynaItemStatusResultSchema,
  DynaSetItemStatusInputSchema,
  DynaUserWorkflowEventSchema,
  DynaWorkActivityPageSchema,
  DynaWorkReferenceSchema,
  DynaWorkUpdateSchema,
  DynaWorkUpdateInputSchema,
  dynaLeadershipScore,
  dynaSourceLabel,
  dynaSourceUrl,
  effectiveDynaPriority,
  type DynaPersonSignal,
} from "../src/index.js";

const executive: DynaPersonSignal = {
  displayName: "Executive sponsor",
  title: "Vice President",
  leadershipLevel: "vp",
  relationship: "neighboring_org",
  involvement: "sender",
  provenance: "twg_org_tree",
  confidence: "high",
};

describe("Dyna executive signal contracts", () => {
  test("accepts only the versioned snapshot-only UI payload", () => {
    const timestamp = "2026-09-04T12:00:00.000Z";
    const payload = {
      schema: "dyna/ui-v7",
      viewToken: "v".repeat(32),
      snapshot: {
        schema: "dyna/snapshot-v5",
        dashboard: {
          id: "bd9a11b5-fbf8-495a-a116-d3429496969f",
          name: "Morning brief",
          description: "Signals that need a decision.",
          archived: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        generatedAt: timestamp,
        query: "",
        revision: 0,
        freshness: "fresh",
        counts: { critical: 0, high: 0, leadership: 0, total: 0 },
        schedules: [],
        cards: [],
      },
    } as const;

    expect(DynaUiPayloadSchema.safeParse(payload).success).toBe(true);
    expect(DynaUiPayloadSchema.safeParse({ ...payload, schema: "dyna/ui-v4" }).success).toBe(false);
    expect(DynaUiPayloadSchema.safeParse({ ...payload, spec: {} }).success).toBe(false);
  });

  test("validates bounded cross-session work references and updates", () => {
    const timestamp = "2026-09-10T12:00:00.000Z";
    expect(
      DynaWorkReferenceSchema.safeParse({
        schema: "dyna/work-item-v1",
        dashboardId: "bd9a11b5-fbf8-495a-a116-d3429496969f",
        dashboardName: "Morning brief",
        itemId: "4ab587d0-a34a-43ea-95ce-75be06d4c244",
        expectedFingerprint: "a".repeat(64),
        sourceUpdatedAt: timestamp,
        copiedAt: timestamp,
        workAttemptId: "eb4909a3-14da-433a-908d-8771636be350",
        linkedTasks: [],
      }).success,
    ).toBe(true);
    expect(
      DynaWorkUpdateInputSchema.safeParse({
        requestId: "7bfd389a-0374-4658-92cc-a2ba97407fcc",
        workAttemptId: "eb4909a3-14da-433a-908d-8771636be350",
        kind: "completion_reported",
        body: "Implementation and focused validation are complete.",
        outcome: "Added retry-safe Dyna work synchronization.",
        task: { taskId: "task-42", hostId: "host-local" },
        artifacts: [{ kind: "merge_request", label: "MR 42", url: "https://example.com/mr/42" }],
      }).success,
    ).toBe(true);
    expect(
      DynaArtifactRefSchema.safeParse({
        kind: "report",
        label: "Credential-bearing report URL",
        url: "https://user:secret@example.com/report",
      }).success,
    ).toBe(false);
    expect(
      DynaArtifactRefSchema.safeParse({
        kind: "report",
        label: "Public report URL",
        url: "https://example.com/report",
      }).success,
    ).toBe(true);
    expect(
      DynaWorkUpdateInputSchema.safeParse({
        requestId: "7bfd389a-0374-4658-92cc-a2ba97407fcc",
        workAttemptId: "eb4909a3-14da-433a-908d-8771636be350",
        kind: "completion_reported",
        body: "Done",
        task: { taskId: "task-42", hostId: "host-local" },
      }).success,
    ).toBe(false);
    for (const kind of [
      "progress",
      "needs_input",
      "blocked",
      "completion_reported",
      "handoff",
    ] as const) {
      const input = {
        requestId: "7bfd389a-0374-4658-92cc-a2ba97407fcc",
        workAttemptId: "eb4909a3-14da-433a-908d-8771636be350",
        kind,
        body: "Durable lifecycle update.",
        ...(kind === "completion_reported" ? { outcome: "Completed the bounded work." } : {}),
      };
      expect(DynaWorkUpdateInputSchema.safeParse(input).success).toBe(false);
      expect(
        DynaWorkUpdateInputSchema.safeParse({
          ...input,
          task: { taskId: "task-42", hostId: "host-local" },
        }).success,
      ).toBe(true);
    }
    for (const kind of ["note", "decision"] as const) {
      expect(
        DynaWorkUpdateInputSchema.safeParse({
          requestId: "7bfd389a-0374-4658-92cc-a2ba97407fcc",
          workAttemptId: "eb4909a3-14da-433a-908d-8771636be350",
          kind,
          body: "Durable non-lifecycle context.",
        }).success,
      ).toBe(true);
    }
    const storedUpdate = {
      schema: "dyna/work-update-v1",
      id: "c849421a-c365-4d4a-9c19-6f0987f23f36",
      itemId: "4ab587d0-a34a-43ea-95ce-75be06d4c244",
      originDashboardId: "bd9a11b5-fbf8-495a-a116-d3429496969f",
      workAttemptId: "eb4909a3-14da-433a-908d-8771636be350",
      kind: "progress",
      body: "Implementation is in progress.",
      artifacts: [],
      createdAt: timestamp,
    } as const;
    expect(DynaWorkUpdateSchema.safeParse(storedUpdate).success).toBe(true);
    expect(
      DynaWorkUpdateSchema.safeParse({ ...storedUpdate, outcome: "Not allowed here." }).success,
    ).toBe(false);
    expect(
      DynaWorkUpdateSchema.safeParse({ ...storedUpdate, kind: "completion_reported" }).success,
    ).toBe(false);

    const copyReference = DynaWorkReferenceSchema.parse({
      schema: "dyna/work-item-v1",
      dashboardId: "bd9a11b5-fbf8-495a-a116-d3429496969f",
      dashboardName: "Morning brief",
      itemId: "4ab587d0-a34a-43ea-95ce-75be06d4c244",
      expectedFingerprint: "a".repeat(64),
      sourceUpdatedAt: timestamp,
      copiedAt: timestamp,
      workAttemptId: "eb4909a3-14da-433a-908d-8771636be350",
      linkedTasks: [],
    });
    const startReference = DynaWorkReferenceSchema.parse({
      ...copyReference,
      copiedAt: "2026-09-10T12:01:00.000Z",
      workAttemptId: "04a06f75-2550-4cb2-b5a6-d47a1030327e",
    });
    expect(Object.keys(startReference)).toEqual(Object.keys(copyReference));
    for (const forbidden of [
      "viewToken",
      "claimToken",
      "publisherSecret",
      "databasePath",
      "requestId",
    ]) {
      expect(
        DynaWorkReferenceSchema.safeParse({ ...startReference, [forbidden]: "not-allowed" })
          .success,
      ).toBe(false);
    }
  });

  test("validates user-directed taskless workflow changes and completion outcomes", () => {
    const base = {
      viewToken: "v".repeat(32),
      itemId: "4ab587d0-a34a-43ea-95ce-75be06d4c244",
      expectedRevision: 3,
      expectedFingerprint: "a".repeat(64),
      clientRequestId: "7bfd389a-0374-4658-92cc-a2ba97407fcc",
    } as const;

    for (const targetStage of ["todo", "needs_you"] as const) {
      expect(DynaSetItemStatusInputSchema.safeParse({ ...base, targetStage }).success).toBe(true);
      expect(
        DynaSetItemStatusInputSchema.safeParse({
          ...base,
          targetStage,
          outcome: "An outcome does not belong on active work.",
        }).success,
      ).toBe(false);
    }
    expect(
      DynaSetItemStatusInputSchema.safeParse({
        ...base,
        targetStage: "done",
        outcome: "Completed the requested review.",
      }).success,
    ).toBe(true);
    expect(DynaSetItemStatusInputSchema.safeParse({ ...base, targetStage: "done" }).success).toBe(
      false,
    );
    expect(
      DynaSetItemStatusInputSchema.safeParse({
        ...base,
        targetStage: "done",
        outcome: "First line\nSecond line",
      }).success,
    ).toBe(false);
    expect(
      DynaSetItemStatusInputSchema.safeParse({ ...base, targetStage: "executing" }).success,
    ).toBe(false);

    const event = {
      id: "c849421a-c365-4d4a-9c19-6f0987f23f36",
      itemId: base.itemId,
      originDashboardId: "bd9a11b5-fbf8-495a-a116-d3429496969f",
      targetStage: "done",
      outcome: "Completed the requested review.",
      createdAt: "2026-09-11T12:00:00.000Z",
    } as const;
    expect(DynaUserWorkflowEventSchema.safeParse(event).success).toBe(true);
    expect(DynaUserWorkflowEventSchema.safeParse({ ...event, targetStage: "todo" }).success).toBe(
      false,
    );
    expect(
      DynaItemStatusResultSchema.safeParse({
        schema: "dyna/item-status-result-v1",
        requestId: base.clientRequestId,
        itemId: base.itemId,
        deduplicated: false,
        targetStage: "done",
        changed: true,
        changedAt: event.createdAt,
      }).success,
    ).toBe(true);
  });

  test("bounds snapshot, context, history, and paged activity work updates", () => {
    const timestamp = "2026-09-10T12:00:00.000Z";
    const update = {
      schema: "dyna/work-update-v1",
      id: "c849421a-c365-4d4a-9c19-6f0987f23f36",
      itemId: "4ab587d0-a34a-43ea-95ce-75be06d4c244",
      originDashboardId: "bd9a11b5-fbf8-495a-a116-d3429496969f",
      workAttemptId: "eb4909a3-14da-433a-908d-8771636be350",
      kind: "progress",
      body: "Implementation is in progress.",
      artifacts: [],
      createdAt: timestamp,
    } as const;
    const card = {
      id: update.itemId,
      fingerprint: "a".repeat(64),
      source: "gitlab",
      sourceRef: {
        source: "gitlab",
        instanceId: "gitlab.example.test",
        projectPath: "team/project",
        iid: 42,
        entityType: "merge_request",
      },
      sourceLabel: "GitLab",
      title: "Review MR 42",
      summary: "Review is required.",
      sourcePriority: "high",
      priority: "high",
      priorityReason: "Release is waiting.",
      sourceUpdatedAt: timestamp,
      labels: [],
      people: [],
      leadershipScore: 0,
      priorityMode: "source",
      canMoveEarlier: false,
      canMoveLater: false,
      workflowState: "executing",
      plan: [],
      nextSteps: [],
      annotations: [],
      workUpdates: [update],
      workUpdateCount: 26,
      workState: "progress",
      workConditionSummary: "Implementation is in progress.",
      workConditionTask: { taskId: "task-42", hostId: "local" },
      matchedActivity: "Matched a previous durable progress update.",
      blocked: false,
      linkedTasks: [],
    } as const;
    expect(DynaCardSchema.safeParse(card).success).toBe(true);
    expect(DynaCardSchema.safeParse({ ...card, workUpdates: [update, update] }).success).toBe(
      false,
    );

    const context = {
      externalId: "team/project!42",
      sourceRef: card.sourceRef,
      sourceScope: "team/project",
      title: card.title,
      summary: card.summary,
      priority: card.priority,
      priorityReason: card.priorityReason,
      sourceUpdatedAt: timestamp,
      labels: [],
      people: [],
      plan: [],
      nextSteps: [],
      id: card.id,
      fingerprint: card.fingerprint,
      annotations: [],
      workUpdates: Array.from({ length: 20 }, () => update),
      workUpdateCount: 26,
      linkedTasks: [],
    } as const;
    expect(DynaItemContextSchema.safeParse(context).success).toBe(true);
    expect(
      DynaItemContextSchema.safeParse({
        ...context,
        workUpdates: Array.from({ length: 21 }, () => update),
      }).success,
    ).toBe(false);

    const history = {
      itemId: card.id,
      archives: [],
      organization: [],
      statusChanges: [],
      workUpdates: Array.from({ length: 50 }, () => update),
      workUpdatesNextCursor: "opaque-next-page",
    } as const;
    expect(DynaItemHistorySchema.safeParse(history).success).toBe(true);
    expect(
      DynaItemHistorySchema.safeParse({
        ...history,
        workUpdates: Array.from({ length: 51 }, () => update),
      }).success,
    ).toBe(false);

    expect(
      DynaWorkActivityPageSchema.safeParse({
        itemId: card.id,
        updates: Array.from({ length: 25 }, () => update),
        nextCursor: "opaque-next-page",
        total: 26,
      }).success,
    ).toBe(true);
    expect(
      DynaWorkActivityPageSchema.safeParse({
        itemId: card.id,
        updates: Array.from({ length: 26 }, () => update),
        total: 26,
      }).success,
    ).toBe(false);
  });

  test("accepts bounded cross-tool references and guidance", () => {
    const item = DynaPublishedItemSchema.parse({
      externalId: "github:team/project:123",
      sourceRef: {
        source: "scm",
        provider: "GitHub",
        instanceId: "github.com",
        repository: "team/project",
        entityType: "pull_request",
        entityId: "123",
      },
      sourceScope: "team/project",
      title: "Review the release pull request",
      summary: "The release is waiting for an accountable reviewer.",
      priority: "normal",
      priorityReason: "The release train closes today.",
      sourceUpdatedAt: "2026-09-04T12:00:00.000Z",
      people: [{ ...executive, provenance: "declared_source" }],
      attention: "Make the release decision.",
      plan: ["Review the current diff"],
      nextSteps: [{ label: "Approve or name the blocker", owner: "You" }],
    });

    expect(dynaSourceLabel(item.sourceRef)).toBe("GitHub");
    expect(dynaSourceUrl(item.sourceRef)).toBe("https://github.com/team/project/pull/123");
    expect(item.plan).toEqual(["Review the current diff"]);
    expect(item.nextSteps).toHaveLength(1);
    expect(
      DynaPublishedItemSchema.safeParse({
        ...item,
        people: [executive],
      }).success,
    ).toBe(false);
  });

  test("derives safe browser links from typed source identities", () => {
    expect(
      dynaSourceUrl({
        source: "gitlab",
        instanceId: "cd.splunkdev.com",
        projectPath: "linus/linus-findings-service",
        iid: 295,
        entityType: "merge_request",
      }),
    ).toBe("https://cd.splunkdev.com/linus/linus-findings-service/-/merge_requests/295");
    expect(
      dynaSourceUrl({
        source: "twg",
        contextId: "splunk.atlassian.net",
        resultType: "jira",
        recordId: "LIN-2570",
      }),
    ).toBe("https://splunk.atlassian.net/browse/LIN-2570");
    expect(
      dynaSourceUrl({
        source: "messaging",
        provider: "Discord",
        workspaceId: "team",
        channelId: "release",
        messageId: "42",
      }),
    ).toBe("https://discord.com/channels/team/release/42");
    expect(
      dynaSourceUrl({
        source: "gitlab",
        instanceId: "javascript:alert(1)",
        projectPath: "team/project",
        iid: 1,
        entityType: "issue",
      }),
    ).toBeUndefined();
  });

  test("accepts unique scheduled source slices and rejects manual or duplicate slices", () => {
    const slices = [
      { source: "gitlab", sourceScope: "gitlab:corp/team/project", status: "succeeded" },
      { source: "outlook", sourceScope: "outlook:executive@example.com", status: "failed" },
    ] as const;
    expect(DynaPublishSourceSlicesSchema.safeParse(slices).success).toBe(true);
    expect(DynaPublishSourceSlicesSchema.safeParse([...slices, slices[0]]).success).toBe(false);
    expect(
      DynaPublishSourceSlicesSchema.safeParse([
        { source: "manual", sourceScope: "manual:dashboard", status: "succeeded" },
      ]).success,
    ).toBe(false);
  });

  test("keeps manual items internal to user-created to-dos", () => {
    const manualItem = {
      externalId: "manual:todo",
      sourceRef: {
        source: "manual",
        todoId: "bd9a11b5-fbf8-495a-a116-d3429496969f",
      },
      sourceScope: "manual:dashboard",
      title: "User-created to-do",
      summary: "Manual items remain valid materialized records.",
      priority: "normal",
      priorityReason: "Created by the user.",
      sourceUpdatedAt: "2026-09-04T12:00:00.000Z",
      labels: [],
    } as const;

    expect(DynaPublishedItemSchema.safeParse(manualItem).success).toBe(true);
    expect(DynaScheduledPublishedItemSchema.safeParse(manualItem).success).toBe(false);
  });

  test("exposes bounded publisher credential and latest-slice state", () => {
    const timestamp = "2026-09-04T12:00:00.000Z";
    const publisher = {
      id: "bd9a11b5-fbf8-495a-a116-d3429496969f",
      name: "Protected publisher",
      scheduleState: "paused",
      staleAfterMinutes: 60,
      lastRunStatus: "never",
      createdAt: timestamp,
    } as const;
    expect(DynaPublisherSchema.safeParse(publisher).success).toBe(false);

    expect(
      DynaPublisherSchema.safeParse({
        ...publisher,
        credentialMode: "disabled",
        lastRunStatus: "partial",
        lastRunAt: timestamp,
        lastSourceSlices: [
          {
            source: "gitlab",
            sourceScope: "gitlab:corp/team/project",
            status: "succeeded",
            freshness: "fresh",
          },
          {
            source: "outlook",
            sourceScope: "outlook:executive@example.com",
            status: "failed",
            freshness: "stale",
          },
        ],
      }).success,
    ).toBe(true);
  });

  test("accepts bounded publisher source manifests and rejects invalid slices", () => {
    const required = [
      { source: "gitlab", sourceScope: "gitlab:corp/team/project" },
      { source: "outlook", sourceScope: "outlook:executive@example.com" },
    ] as const;
    expect(DynaRequiredSourceSlicesSchema.safeParse(required).success).toBe(true);
    expect(DynaRequiredSourceSlicesSchema.safeParse([...required, required[0]]).success).toBe(
      false,
    );
    expect(
      DynaRequiredSourceSlicesSchema.safeParse([
        { source: "manual", sourceScope: "manual:dashboard" },
      ]).success,
    ).toBe(false);
    expect(
      DynaRequiredSourceSlicesSchema.safeParse(
        Array.from({ length: 51 }, (_, index) => ({
          source: "skill",
          sourceScope: `skill:${String(index)}`,
        })),
      ).success,
    ).toBe(false);
  });

  test("promotes only direct, credible involvement and reserves critical for source urgency", () => {
    expect(dynaLeadershipScore([executive])).toBe(85);
    expect(effectiveDynaPriority("normal", [executive])).toBe("high");
    expect(effectiveDynaPriority("high", [executive])).toBe("high");

    expect(
      effectiveDynaPriority("normal", [
        { ...executive, involvement: "mentioned" },
        { ...executive, involvement: "informed", confidence: "low" },
      ]),
    ).toBe("normal");
  });

  test("requires a precise one-line outcome for succeeded Codex tasks", () => {
    const task = {
      taskId: "task-1",
      hostId: "local",
      title: "Review release",
      state: "succeeded",
      statusUpdatedAt: "2026-09-04T12:00:00.000Z",
      observedAt: "2026-09-04T12:00:01.000Z",
    } as const;
    expect(DynaTaskStatusSchema.safeParse(task).success).toBe(false);
    expect(
      DynaTaskStatusSchema.safeParse({ ...task, outcome: "Approved.\nExtra detail" }).success,
    ).toBe(false);
    expect(
      DynaTaskStatusSchema.safeParse({ ...task, outcome: "Approved the release." }).success,
    ).toBe(true);
  });

  test("bounds session-picker candidates to metadata-only unique task identities", () => {
    const candidate = {
      taskId: "task-1",
      hostId: "local",
      projectId: "project-1",
      title: "Review release",
      updatedAt: "2026-09-10T12:00:00.000Z",
    } as const;
    expect(DynaCodexSessionCandidatesSchema.safeParse([candidate]).success).toBe(true);
    expect(
      DynaCodexSessionCandidatesSchema.safeParse([{ ...candidate, transcript: "private" }]).success,
    ).toBe(false);
    expect(DynaCodexSessionCandidatesSchema.safeParse([candidate, candidate]).success).toBe(false);
    expect(
      DynaCodexSessionCandidatesSchema.safeParse(
        Array.from({ length: 51 }, (_, index) => ({
          ...candidate,
          taskId: `task-${String(index)}`,
        })),
      ).success,
    ).toBe(false);
    expect(DynaActionKindSchema.safeParse("list_codex_sessions").success).toBe(true);
    expect(DynaActionKindSchema.safeParse("attach_codex_task").success).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";

import {
  DynaTaskSyncBeginResultSchema as BrowserTaskSyncBeginResultSchema,
  DynaTaskSyncStatusResultSchema as BrowserTaskSyncStatusResultSchema,
  DynaUiPayloadSchema as BrowserUiPayloadSchema,
  DynaWorkActivityPageSchema as BrowserWorkActivityPageSchema,
  dynaSourceUrl as browserSourceUrl,
  formatDynaItemNumber as formatBrowserItemNumber,
} from "../src/browser.js";
import {
  DynaTaskSyncBeginResultSchema,
  DynaTaskSyncStatusResultSchema,
  DynaUiPayloadSchema,
  DynaWorkActivityPageSchema,
  dynaSourceUrl,
  formatDynaItemNumber,
  type DynaSourceRef,
} from "../src/index.js";

interface SafeParser {
  safeParse(
    value: unknown,
  ): { readonly success: true; readonly data: unknown } | { readonly success: false };
}

function expectParserParity(
  canonical: SafeParser,
  browser: SafeParser,
  values: readonly unknown[],
): void {
  for (const value of values) {
    const canonicalResult = canonical.safeParse(value);
    const browserResult = browser.safeParse(value);
    expect(browserResult.success).toBe(canonicalResult.success);
    if (canonicalResult.success && browserResult.success) {
      expect(browserResult.data).toEqual(canonicalResult.data);
    }
  }
}

const timestamp = "2026-09-21T12:00:00.000Z";
const dashboardId = "bd9a11b5-fbf8-495a-a116-d3429496969f";
const itemId = "4ab587d0-a34a-43ea-95ce-75be06d4c244";
const workAttemptId = "eb4909a3-14da-433a-908d-8771636be350";

const taskSyncSummary = {
  runId: "7bfd389a-0374-4658-92cc-a2ba97407fcc",
  dashboardId,
  state: "updated",
  processedTasks: 1,
  totalTasks: 1,
  updatedItems: 1,
  unavailableTasks: 0,
  incompleteMetadataTasks: 0,
  remainingTasks: 0,
  startedAt: timestamp,
  completedAt: timestamp,
  updatedAt: timestamp,
} as const;

const workUpdate = {
  schema: "dyna/work-update-v1",
  id: "c849421a-c365-4d4a-9c19-6f0987f23f36",
  itemId,
  originDashboardId: dashboardId,
  workAttemptId,
  kind: "completion_reported",
  body: "Completed the bounded implementation and validation.",
  outcome: "Browser validation was separated successfully.",
  artifacts: [
    {
      kind: "report",
      label: "Build report",
      url: "https://example.test/reports/dyna-browser-contracts",
    },
  ],
  task: { taskId: "task-184", hostId: "host-local", title: ":184: Improve Dyna prompt" },
  createdAt: timestamp,
} as const;

const card = {
  id: itemId,
  itemNumber: 184,
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
  title: "Improve the Dyna copy prompt",
  summary: "Make the prompt action-first and bounded to goal-relevant context.",
  sourcePriority: "high",
  priority: "high",
  priorityReason: "Codex needs concise execution context.",
  sourceUpdatedAt: timestamp,
  labels: ["dyna", "prompt"],
  people: [],
  leadershipScore: 0,
  priorityMode: "source",
  canMoveEarlier: false,
  canMoveLater: false,
  workflowState: "completed",
  completedAt: timestamp,
  outcome: "Browser validation was separated successfully.",
  completionAuthority: "dyna_task",
  completionTask: { taskId: "task-184", hostId: "host-local", title: ":184: Improve Dyna prompt" },
  completionWorkAttemptId: workAttemptId,
  plan: ["Separate browser runtime contracts."],
  nextSteps: [{ label: "Verify the browser bundle", owner: "Codex", dueAt: timestamp }],
  annotations: [
    {
      id: "f4892611-9936-4b02-b5e7-26ad609b2cf8",
      itemId,
      body: "Keep strict validation at the host boundary.",
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
      task: { taskId: "task-184", hostId: "host-local" },
      workAttemptId,
    },
  ],
  workUpdates: [workUpdate],
  workUpdateCount: 1,
  linkedTasks: [
    {
      taskId: "task-184",
      hostId: "host-local",
      title: ":184: Improve Dyna prompt",
      state: "succeeded",
      outcome: "Browser validation was separated successfully.",
      statusUpdatedAt: timestamp,
      observedAt: timestamp,
    },
  ],
} as const;

const uiPayload = {
  schema: "dyna/ui-v11",
  viewToken: "v".repeat(32),
  snapshot: {
    schema: "dyna/snapshot-v9",
    dashboard: {
      id: dashboardId,
      name: "Engineering action queue",
      description: "Bounded work that needs execution.",
      archived: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    generatedAt: timestamp,
    query: "",
    revision: 12,
    freshness: "fresh",
    counts: { critical: 0, high: 1, leadership: 0, total: 1 },
    schedules: [
      {
        id: "60a13e0c-27eb-4287-86aa-55aa5172f610",
        name: "Dyna refresh",
        scheduleState: "active",
        staleAfterMinutes: 60,
        credentialMode: "disabled",
        requiredSourceSlices: [{ source: "gitlab", sourceScope: "team/project" }],
        lastRunStatus: "succeeded",
        lastRunAt: timestamp,
        lastSourceSlices: [
          {
            source: "gitlab",
            sourceScope: "team/project",
            status: "succeeded",
            freshness: "fresh",
          },
        ],
        createdAt: timestamp,
      },
    ],
    cards: [card],
    taskSync: taskSyncSummary,
  },
} as const;

describe("Dyna browser contract parity", () => {
  test("matches canonical UI payload acceptance, defaults, and strict rejection", () => {
    const invalidCompletion = {
      ...uiPayload,
      snapshot: {
        ...uiPayload.snapshot,
        cards: [{ ...card, completionWorkAttemptId: undefined }],
      },
    };
    const duplicateSlice = {
      ...uiPayload,
      snapshot: {
        ...uiPayload.snapshot,
        schedules: [
          {
            ...uiPayload.snapshot.schedules[0],
            requiredSourceSlices: [
              { source: "gitlab", sourceScope: "team/project" },
              { source: "gitlab", sourceScope: "team/project" },
            ],
          },
        ],
      },
    };
    expectParserParity(DynaUiPayloadSchema, BrowserUiPayloadSchema, [
      uiPayload,
      { ...uiPayload, extra: true },
      { ...uiPayload, schema: "dyna/ui-v10" },
      invalidCompletion,
      duplicateSlice,
    ]);
  });

  test("matches canonical task-sync and paged-work validation", () => {
    const begin = {
      schema: "dyna/task-sync-begin-result-v1",
      joined: false,
      deliveryRequired: true,
      summary: taskSyncSummary,
    } as const;
    const status = {
      schema: "dyna/task-sync-status-result-v1",
      summary: taskSyncSummary,
    } as const;
    const activity = {
      itemId,
      itemNumber: 184,
      updates: [workUpdate],
      nextCursor: "next-page",
      total: 1,
    } as const;

    expectParserParity(DynaTaskSyncBeginResultSchema, BrowserTaskSyncBeginResultSchema, [
      begin,
      { ...begin, joined: "no" },
      { ...begin, summary: { ...taskSyncSummary, processedTasks: 201 } },
    ]);
    expectParserParity(DynaTaskSyncStatusResultSchema, BrowserTaskSyncStatusResultSchema, [
      status,
      { ...status, unexpected: true },
    ]);
    expectParserParity(DynaWorkActivityPageSchema, BrowserWorkActivityPageSchema, [
      activity,
      { ...activity, updates: Array.from({ length: 26 }, () => workUpdate) },
      {
        ...activity,
        updates: [
          {
            ...workUpdate,
            artifacts: [
              {
                kind: "report",
                label: "Unsafe",
                url: "https://untrusted-user@example.test/report",
              },
            ],
          },
        ],
      },
    ]);
  });

  test("keeps browser source links and item formatting aligned with canonical helpers", () => {
    const sourceRefs: readonly DynaSourceRef[] = [
      card.sourceRef,
      {
        source: "slack",
        workspaceId: "T12345678",
        channelId: "C12345678",
        messageId: "1725556200.123456",
      },
      {
        source: "scm",
        provider: "GitHub",
        instanceId: "https://github.com",
        repository: "team/project",
        entityType: "pull_request",
        entityId: "42",
      },
      { source: "manual", todoId: "08f8f4d4-ec74-4c7f-94ff-0e559d69b06f" },
    ];

    for (const sourceRef of sourceRefs) {
      expect(browserSourceUrl(sourceRef)).toBe(dynaSourceUrl(sourceRef));
    }
    expect(formatBrowserItemNumber(184)).toBe(formatDynaItemNumber(184));
  });
});

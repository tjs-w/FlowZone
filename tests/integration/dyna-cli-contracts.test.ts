import { describe, expect, test } from "bun:test";
import {
  DynaCliAnnotationAddInputSchema,
  DynaDashboardListResultSchema,
  DynaDashboardShowResultSchema,
  DynaItemSearchResultSchema,
  DynaLifecycleArchiveInputSchema,
  DynaOrganizePlaceManyInputSchema,
  DynaTodoCreateInputSchema,
  DynaTaskWorkEnrichInputSchema,
  DynaWorkCompleteInputSchema,
  DynaWorkEnrichInputSchema,
  DynaWorkUpdateInputSchema,
} from "@flowzone/dyna-contracts";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const SECOND_UUID = "223e4567-e89b-42d3-a456-426614174000";
const FINGERPRINT = "a".repeat(64);
const NOW = "2026-09-13T12:00:00.000Z";
const TASK_MUTATION = {
  requestId: UUID,
  workAttemptId: SECOND_UUID,
  task: { taskId: "task-42", hostId: "host-local" },
} as const;

const dashboard = {
  id: UUID,
  name: "Executive queue",
  description: "Bounded contract fixture",
  archived: false,
  doneRetentionHours: 24,
  createdAt: NOW,
  updatedAt: NOW,
};

const searchBrief = {
  itemId: UUID,
  itemNumber: 184,
  fingerprint: FINGERPRINT,
  title: "Review the release",
  summary: "One bounded operational brief.",
  sourceRef: { source: "manual" as const, todoId: UUID },
  priority: "high" as const,
  priorityReason: "Direct request",
  sourceUpdatedAt: NOW,
  workflowState: "todo" as const,
  plan: [],
  nextSteps: [],
  workUpdates: [],
  workUpdateCount: 0,
  linkedTasks: [],
};

describe("Dyna canonical CLI contracts", () => {
  test("bounds dashboard and search read results", () => {
    expect(
      DynaDashboardListResultSchema.safeParse({
        schema: "dyna/dashboard-list-result-v1",
        dashboards: Array.from({ length: 100 }, () => dashboard),
        total: 100,
      }).success,
    ).toBe(true);
    expect(
      DynaDashboardListResultSchema.safeParse({
        schema: "dyna/dashboard-list-result-v1",
        dashboards: Array.from({ length: 101 }, () => dashboard),
        total: 101,
      }).success,
    ).toBe(false);

    const search = {
      schema: "dyna/item-search-result-v3" as const,
      dashboardId: UUID,
      dashboardName: dashboard.name,
      query: "release",
      scope: "active" as const,
      revision: 1,
      freshness: "fresh" as const,
      total: 21,
    };
    expect(
      DynaItemSearchResultSchema.safeParse({
        ...search,
        items: Array.from({ length: 20 }, () => searchBrief),
      }).success,
    ).toBe(true);
    expect(
      DynaItemSearchResultSchema.safeParse({
        ...search,
        items: Array.from({ length: 21 }, () => searchBrief),
      }).success,
    ).toBe(false);
    expect(
      DynaItemSearchResultSchema.safeParse({
        ...search,
        items: [{ ...searchBrief, annotations: [] }],
      }).success,
    ).toBe(false);
  });

  test("keeps dashboard health output redacted and strict", () => {
    const result = {
      schema: "dyna/dashboard-show-result-v1" as const,
      dashboardId: UUID,
      name: dashboard.name,
      revision: 1,
      freshness: "fresh" as const,
      counts: { active: 2, archived: 1 },
      scheduledSources: [
        {
          name: "Daily refresh",
          scheduleTitle: "Executive refresh",
          scheduleState: "active" as const,
          lastRunStatus: "succeeded" as const,
          lastRunAt: NOW,
          sourceSlices: [
            {
              source: "gitlab" as const,
              status: "succeeded" as const,
              freshness: "fresh" as const,
            },
          ],
        },
      ],
    };
    expect(DynaDashboardShowResultSchema.safeParse(result).success).toBe(true);
    expect(
      DynaDashboardShowResultSchema.safeParse({
        ...result,
        scheduledSources: [{ ...result.scheduledSources[0], credentialMode: "local_cli" }],
      }).success,
    ).toBe(false);
    expect(
      DynaDashboardShowResultSchema.safeParse({
        ...result,
        scheduledSources: [{ ...result.scheduledSources[0], lastRunError: "private detail" }],
      }).success,
    ).toBe(false);
  });

  test("rejects unknown mutation fields and duplicate bulk members", () => {
    const strictCases = [
      {
        schema: DynaWorkUpdateInputSchema,
        value: {
          ...TASK_MUTATION,
          kind: "note",
          body: "Durable note",
          artifacts: [],
        },
      },
      {
        schema: DynaWorkEnrichInputSchema,
        value: { requestId: UUID, summary: "Evidence-based summary" },
      },
      {
        schema: DynaLifecycleArchiveInputSchema,
        value: { ...TASK_MUTATION, reason: "invalid" },
      },
      {
        schema: DynaTaskWorkEnrichInputSchema,
        value: { ...TASK_MUTATION, set: { summary: "Evidence-based summary" }, clear: [] },
      },
      {
        schema: DynaWorkCompleteInputSchema,
        value: { ...TASK_MUTATION, outcome: "Completed the bounded work.", artifacts: [] },
      },
      {
        schema: DynaCliAnnotationAddInputSchema,
        value: { ...TASK_MUTATION, body: "Editable task annotation." },
      },
      {
        schema: DynaTodoCreateInputSchema,
        value: { requestId: UUID, title: "Follow up", priority: "normal", labels: [] },
      },
    ] as const;
    for (const { schema, value } of strictCases) {
      expect(schema.safeParse(value).success).toBe(true);
      expect(schema.safeParse({ ...value, databasePath: "/private/data" }).success).toBe(false);
    }

    expect(
      DynaOrganizePlaceManyInputSchema.safeParse({
        requestId: UUID,
        targetPriority: "high",
        items: [
          { itemId: SECOND_UUID, expectedFingerprint: FINGERPRINT },
          { itemId: SECOND_UUID, expectedFingerprint: FINGERPRINT },
        ],
      }).success,
    ).toBe(false);

    const boundedBulkItems = Array.from({ length: 200 }, (_, index) => ({
      itemId: `123e4567-e89b-42d3-a456-${index.toString(16).padStart(12, "0")}`,
      expectedFingerprint: index.toString(16).padStart(64, "0"),
    }));
    expect(
      DynaOrganizePlaceManyInputSchema.safeParse({
        requestId: UUID,
        targetPriority: "high",
        items: boundedBulkItems,
      }).success,
    ).toBe(true);
    expect(
      DynaOrganizePlaceManyInputSchema.safeParse({
        requestId: UUID,
        targetPriority: "high",
        items: [...boundedBulkItems, { itemId: SECOND_UUID, expectedFingerprint: FINGERPRINT }],
      }).success,
    ).toBe(false);

    expect(
      DynaTodoCreateInputSchema.safeParse({
        requestId: UUID,
        title: "Standalone work only",
        priority: "normal",
        followUpOfItemId: SECOND_UUID,
      }).success,
    ).toBe(false);
  });
});

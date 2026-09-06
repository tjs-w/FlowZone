import { describe, expect, test } from "bun:test";

import {
  DynaPublishSourceSlicesSchema,
  DynaPublisherSchema,
  DynaRequiredSourceSlicesSchema,
  DynaScheduledPublishedItemSchema,
  DynaUiPayloadSchema,
  DynaPublishedItemSchema,
  DynaTaskStatusSchema,
  dynaLeadershipScore,
  dynaSourceLabel,
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
      schema: "dyna/ui-v6",
      viewToken: "v".repeat(32),
      snapshot: {
        schema: "dyna/snapshot-v4",
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
    expect(item.plan).toEqual(["Review the current diff"]);
    expect(item.nextSteps).toHaveLength(1);
    expect(
      DynaPublishedItemSchema.safeParse({
        ...item,
        people: [executive],
      }).success,
    ).toBe(false);
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
});

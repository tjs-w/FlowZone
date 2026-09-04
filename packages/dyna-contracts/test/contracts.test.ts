import { describe, expect, test } from "bun:test";

import {
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

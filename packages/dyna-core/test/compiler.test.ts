import { describe, expect, test } from "bun:test";

import type { DynaDashboardSnapshot } from "@flowzone/dyna-contracts";
import { dynaCatalog } from "@flowzone/dyna-contracts/catalog";

import { compileDashboard } from "../src/index.js";

function snapshot(): DynaDashboardSnapshot {
  const timestamp = "2026-09-03T01:00:00.000Z";
  return {
    schema: "dyna/snapshot-v3",
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
    revision: 4,
    freshness: "fresh",
    counts: { critical: 0, high: 1, leadership: 1, total: 2 },
    schedules: [],
    cards: [
      {
        id: "d4c4cf38-1ce0-40d8-9593-f40075a53862",
        fingerprint: "a".repeat(64),
        source: "slack",
        sourceRef: {
          source: "slack",
          workspaceId: "splunk",
          channelId: "leadership",
          messageId: "normal-newer",
        },
        sourceLabel: "Slack",
        title: "Normal but newer",
        summary: "Informational update.",
        sourcePriority: "normal",
        priority: "normal",
        priorityReason: "No immediate action required.",
        sourceUpdatedAt: "2026-09-03T00:59:00.000Z",
        labels: [],
        people: [],
        leadershipScore: 0,
        priorityMode: "source",
        canMoveEarlier: false,
        canMoveLater: true,
        workflowState: "todo",
        plan: [],
        nextSteps: [],
        annotations: [],
        linkedTasks: [],
      },
      {
        id: "6d48a2b2-9e1c-41d4-9db1-a7bc34ff39d4",
        fingerprint: "b".repeat(64),
        source: "gitlab",
        sourceRef: {
          source: "gitlab",
          instanceId: "corp",
          projectPath: "team/project",
          entityType: "merge_request",
          iid: 42,
        },
        sourceLabel: "GitLab",
        title: "MR is blocked",
        summary: "A required review is missing.",
        sourcePriority: "high",
        priority: "high",
        priorityReason: "Release train closes today.",
        sourceUpdatedAt: "2026-09-03T00:30:00.000Z",
        labels: ["release"],
        people: [
          {
            displayName: "Release VP",
            leadershipLevel: "vp",
            relationship: "neighboring_org",
            involvement: "approver",
            provenance: "twg_org_tree",
            confidence: "high",
          },
        ],
        leadershipScore: 85,
        priorityMode: "source",
        canMoveEarlier: true,
        canMoveLater: false,
        workflowState: "todo",
        attention: "Approve or name a blocker.",
        plan: ["Review the current diff"],
        nextSteps: [{ label: "Open the MR", owner: "You" }],
        annotations: [],
        linkedTasks: [],
      },
    ],
  };
}

describe("compileDashboard", () => {
  test("produces only catalog-approved components in priority order", () => {
    const spec = compileDashboard(snapshot());
    expect(dynaCatalog.validate(spec).success).toBe(true);
    expect(spec.elements["root"]?.children).toEqual(["summary", "queue", "pipeline"]);
    expect(spec.elements["queue"]?.children).toEqual([
      "queue-section-high",
      "queue-section-normal",
    ]);
    expect(
      Object.values(spec.elements).filter((element) => element.type === "PriorityCard"),
    ).toHaveLength(2);
    expect(JSON.stringify(spec)).not.toContain("<script");
    expect(JSON.stringify(spec)).not.toContain("toolName");
  });

  test("keeps completed work in the pipeline and out of the active priority queue", () => {
    const current = snapshot();
    const completed = {
      ...current,
      counts: { ...current.counts, high: 0 },
      cards: current.cards.map((card) =>
        card.priority === "high"
          ? { ...card, workflowState: "completed" as const, outcome: "Release decision recorded." }
          : card,
      ),
    };
    const spec = compileDashboard(completed);
    expect(spec.elements["queue"]?.children).toEqual(["queue-section-normal"]);
    expect(spec.elements["pipeline-completed"]?.children).toEqual([
      "card-6d48a2b2-9e1c-41d4-9db1-a7bc34ff39d4",
    ]);
  });

  test("offers only actions that can succeed for a Dyna-created to-do", () => {
    const current = snapshot();
    const base = current.cards[0];
    if (!base) throw new Error("Expected the dashboard fixture to contain a card.");
    const manualId = "91c6e620-0128-4f45-aad1-2b77d59535da";
    const manual = {
      ...base,
      id: manualId,
      fingerprint: "c".repeat(64),
      source: "manual" as const,
      sourceRef: { source: "manual" as const, todoId: "a88e554f-1f6c-4cf1-826d-f37e37c0bc9a" },
      sourceLabel: "Todo",
      title: "Prepare staff meeting decisions",
    };
    const spec = compileDashboard({ ...current, cards: [manual] });
    const card = spec.elements[`card-${manualId}`];

    expect(card).toMatchObject({
      type: "PriorityCard",
      props: {
        actions: [
          { name: "annotate", label: "Add note" },
          { name: "create_codex_task", label: "Create Codex task" },
        ],
      },
    });
    expect(JSON.stringify(card)).not.toContain('"open_source"');
  });
});

import { describe, expect, test } from "bun:test";

import {
  projectDynaItemState,
  type DynaItemProjectionInput,
  type DynaProjectionTask,
  type DynaProjectionWorkUpdate,
} from "../src/projector.js";

const FINGERPRINT = "a".repeat(64);

function input(overrides: Partial<DynaItemProjectionInput> = {}): DynaItemProjectionInput {
  return {
    fingerprint: FINGERPRINT,
    sourcePriority: "normal",
    sourceLeadershipScore: 0,
    tasks: [],
    workUpdates: [],
    ...overrides,
  };
}

function task(
  state: DynaProjectionTask["state"],
  overrides: Partial<DynaProjectionTask> = {},
): DynaProjectionTask {
  return {
    taskId: "task-1",
    hostId: "host-1",
    state,
    observedAtMs: 10,
    ...overrides,
  };
}

function update(
  kind: DynaProjectionWorkUpdate["kind"],
  overrides: Partial<DynaProjectionWorkUpdate> = {},
): DynaProjectionWorkUpdate {
  return {
    taskId: "task-1",
    hostId: "host-1",
    kind,
    body: `${kind} update`,
    createdAtMs: 20,
    insertionSequence: 1,
    ...overrides,
  };
}

describe("Dyna lifecycle projection", () => {
  test("maps manual lifecycle when no Codex task is linked", () => {
    expect(projectDynaItemState(input()).workflowState).toBe("todo");
    expect(projectDynaItemState(input({ userWorkflowStage: "needs_you" })).workflowState).toBe(
      "attention",
    );
    expect(projectDynaItemState(input({ userWorkflowStage: "done" })).workflowState).toBe(
      "completed",
    );
  });

  test("lets an explicit manual Done close the item without certifying linked tasks", () => {
    const projected = projectDynaItemState(
      input({
        userWorkflow: {
          stage: "done",
          outcome: "The release decision was recorded manually.",
          createdAt: "2026-09-16T18:30:00.000Z",
          createdAtMs: Date.parse("2026-09-16T18:30:00.000Z"),
        },
        tasks: [
          task("succeeded", {
            taskId: "task-old",
            outcome: "An older task completed.",
            statusUpdatedAt: "2026-09-01T12:00:00.000Z",
            statusUpdatedAtMs: Date.parse("2026-09-01T12:00:00.000Z"),
          }),
          task("failed", { taskId: "task-current" }),
        ],
        workUpdates: [
          update("blocked", {
            taskId: "task-current",
            body: "The linked task is still blocked.",
          }),
        ],
      }),
    );

    expect(projected).toEqual({
      effectivePriority: "normal",
      effectiveLeadershipScore: 0,
      workflowState: "completed",
      blocked: false,
      completedAt: "2026-09-16T18:30:00.000Z",
      completedAtMs: Date.parse("2026-09-16T18:30:00.000Z"),
      outcome: "The release decision was recorded manually.",
    });
  });

  test.each([
    ["queued", "executing", false],
    ["running", "executing", false],
    ["waiting", "paused", false],
    ["failed", "attention", true],
    ["unknown", "attention", true],
    ["succeeded", "completed", false],
  ] as const)("maps controller state %s to %s", (state, workflowState, blocked) => {
    expect(projectDynaItemState(input({ tasks: [task(state)] }))).toEqual({
      effectivePriority: "normal",
      effectiveLeadershipScore: 0,
      workflowState,
      blocked,
    });
  });

  test("uses the highest-attention native state across linked tasks", () => {
    expect(
      projectDynaItemState(
        input({
          tasks: [
            task("succeeded"),
            task("running", { taskId: "task-2" }),
            task("failed", { taskId: "task-3" }),
          ],
        }),
      ),
    ).toMatchObject({ workflowState: "attention", blocked: true });
  });

  test("never treats a task completion report as verified Done", () => {
    expect(
      projectDynaItemState(
        input({ tasks: [task("running")], workUpdates: [update("completion_reported")] }),
      ),
    ).toEqual({
      effectivePriority: "normal",
      effectiveLeadershipScore: 0,
      workflowState: "executing",
      blocked: false,
      workState: "completion_reported",
    });
  });

  test("projects task input requests immediately without marking them blocked", () => {
    expect(
      projectDynaItemState(
        input({
          tasks: [task("queued")],
          workUpdates: [update("needs_input", { body: "Choose the rollout path" })],
        }),
      ),
    ).toMatchObject({
      workflowState: "paused",
      blocked: false,
      workState: "needs_input",
      workConditionSummary: "Choose the rollout path",
      workConditionTask: { taskId: "task-1", hostId: "host-1" },
    });
  });

  test("keeps a task-reported blocker a condition rather than a progress lane", () => {
    expect(
      projectDynaItemState(input({ tasks: [task("running")], workUpdates: [update("blocked")] })),
    ).toMatchObject({
      workflowState: "executing",
      blocked: true,
      workState: "blocked",
    });
  });

  test("lets a later progress milestone clear an earlier task-reported condition", () => {
    const projected = projectDynaItemState(
      input({
        tasks: [task("running")],
        workUpdates: [
          update("needs_input"),
          update("progress", { createdAtMs: 30, insertionSequence: 2 }),
        ],
      }),
    );
    expect(projected).toEqual({
      effectivePriority: "normal",
      effectiveLeadershipScore: 0,
      workflowState: "executing",
      blocked: false,
      workState: "progress",
    });
  });

  test.each([
    ["waiting", "paused", false],
    ["failed", "attention", true],
    ["unknown", "attention", true],
  ] as const)(
    "keeps native %s authoritative over a task-reported progress delta",
    (state, workflowState, blocked) => {
      expect(
        projectDynaItemState(
          input({
            tasks: [task(state, { observedAtMs: 10 })],
            workUpdates: [update("progress", { createdAtMs: 20 })],
          }),
        ),
      ).toEqual({
        effectivePriority: "normal",
        effectiveLeadershipScore: 0,
        workflowState,
        blocked,
        workState: "progress",
      });
    },
  );

  test("keeps a pulled blocker visible without clearing native failure", () => {
    expect(
      projectDynaItemState(
        input({
          tasks: [task("failed", { observedAtMs: 10 })],
          workUpdates: [update("blocked", { createdAtMs: 20 })],
        }),
      ),
    ).toMatchObject({ workflowState: "attention", blocked: true, workState: "blocked" });
  });

  test.each([
    ["waiting", "paused", false],
    ["failed", "attention", true],
    ["unknown", "attention", true],
  ] as const)(
    "does not let a completion report clear controller-observed %s",
    (state, workflowState, blocked) => {
      expect(
        projectDynaItemState(
          input({
            tasks: [task(state, { observedAtMs: 10 })],
            workUpdates: [update("completion_reported", { createdAtMs: 20 })],
          }),
        ),
      ).toMatchObject({ workflowState, blocked, workState: "completion_reported" });
    },
  );

  test("lets a newer native observation supersede stale task reports", () => {
    expect(
      projectDynaItemState(
        input({
          tasks: [task("running", { observedAtMs: 30 })],
          workUpdates: [update("needs_input", { createdAtMs: 20 })],
        }),
      ),
    ).toEqual({
      effectivePriority: "normal",
      effectiveLeadershipScore: 0,
      workflowState: "executing",
      blocked: false,
    });

    expect(
      projectDynaItemState(
        input({
          tasks: [task("succeeded", { observedAtMs: 30 })],
          workUpdates: [update("completion_reported", { createdAtMs: 20 })],
        }),
      ),
    ).toEqual({
      effectivePriority: "normal",
      effectiveLeadershipScore: 0,
      workflowState: "completed",
      blocked: false,
    });
  });

  test("ranks input requests ahead of blockers across tasks", () => {
    const projected = projectDynaItemState(
      input({
        tasks: [task("running"), task("running", { taskId: "task-2" })],
        workUpdates: [
          update("blocked", { body: "Newer blocker", createdAtMs: 40 }),
          update("needs_input", {
            taskId: "task-2",
            body: "Older decision",
            createdAtMs: 20,
          }),
        ],
      }),
    );
    expect(projected).toMatchObject({
      workflowState: "paused",
      blocked: true,
      workState: "needs_input",
      workConditionSummary: "Older decision",
      workConditionTask: { taskId: "task-2", hostId: "host-1" },
    });
  });

  test("uses insertion order to resolve same-instant task updates", () => {
    expect(
      projectDynaItemState(
        input({
          tasks: [task("running")],
          workUpdates: [
            update("blocked", { insertionSequence: 1 }),
            update("handoff", { insertionSequence: 2 }),
          ],
        }),
      ),
    ).toMatchObject({ workflowState: "executing", blocked: false, workState: "handoff" });
  });

  test("bounds condition summaries without exposing the full durable update", () => {
    const projected = projectDynaItemState(
      input({
        tasks: [task("running")],
        workUpdates: [update("blocked", { body: "x".repeat(250) })],
      }),
    );
    expect(projected.workConditionSummary).toBe("x".repeat(200));
  });
});

describe("Dyna priority projection", () => {
  test.each([
    ["normal", 74, "normal"],
    ["normal", 75, "high"],
    ["normal", 120, "high"],
    ["low", 54, "low"],
    ["low", 55, "normal"],
    ["high", 120, "high"],
    ["critical", 120, "critical"],
  ] as const)(
    "maps %s with leadership %i to %s",
    (sourcePriority, sourceLeadershipScore, effectivePriority) => {
      expect(
        projectDynaItemState(input({ sourcePriority, sourceLeadershipScore })).effectivePriority,
      ).toBe(effectivePriority);
    },
  );

  test("uses enrichment only when it matches the current source fingerprint", () => {
    expect(
      projectDynaItemState(
        input({
          enrichment: {
            baseFingerprint: FINGERPRINT,
            priority: "critical",
            leadershipScore: 90,
          },
        }),
      ),
    ).toMatchObject({ effectivePriority: "critical", effectiveLeadershipScore: 90 });

    expect(
      projectDynaItemState(
        input({
          enrichment: {
            baseFingerprint: "b".repeat(64),
            priority: "critical",
            leadershipScore: 90,
          },
        }),
      ),
    ).toMatchObject({ effectivePriority: "normal", effectiveLeadershipScore: 0 });
  });

  test("keeps manual priority authoritative over enrichment and leadership", () => {
    expect(
      projectDynaItemState(
        input({
          preferencePriority: "low",
          enrichment: {
            baseFingerprint: FINGERPRINT,
            priority: "critical",
            leadershipScore: 100,
          },
        }),
      ),
    ).toMatchObject({ effectivePriority: "low", effectiveLeadershipScore: 100 });
  });
});

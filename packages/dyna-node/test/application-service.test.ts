import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { projectDynaItemState } from "../src/projector.js";

describe("DynaApplicationService boundary", () => {
  test("keeps the repository private and canonical operations retry-safe", () => {
    const serviceSource = readFileSync(resolve(import.meta.dir, "../src/service.ts"), "utf8");
    expect(serviceSource).toContain("readonly #repository: DynaRepository");
    expect(serviceSource).not.toMatch(/readonly\s+store\b|\.store\b/u);
    expect(serviceSource).toContain("scheduledSources: snapshot.schedules.map");
    expect(serviceSource).not.toContain("credentialMode: schedule.credentialMode");
    const fixture = resolve(import.meta.dir, "application-service-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      todoReplay: true,
      archivedReplay: true,
      bulkBlock: true,
      normalizedReplay: true,
      atomicRollback: true,
      queueOrderPreserved: true,
      liveProjection: true,
      serviceRetention: true,
      canonicalTaskTitles: true,
      spoofSafeTaskTitles: true,
      exclusiveTaskOwnership: true,
      hostRouting: true,
      titleSyncProjection: true,
      numericSearchRanking: true,
      associationReservation: true,
      expiredReservationCapacity: true,
      legacyReceiptReplay: true,
    });
  });
});

describe("Dyna application projection", () => {
  const base = {
    fingerprint: "a".repeat(64),
    sourcePriority: "normal" as const,
    sourceLeadershipScore: 0,
    tasks: [],
    workUpdates: [],
  };

  test("preserves override, leadership, and stale-enrichment precedence", () => {
    expect(
      projectDynaItemState({
        ...base,
        enrichment: {
          baseFingerprint: base.fingerprint,
          priority: "normal",
          leadershipScore: 75,
        },
      }).effectivePriority,
    ).toBe("high");
    expect(
      projectDynaItemState({
        ...base,
        preferencePriority: "low",
        enrichment: {
          baseFingerprint: base.fingerprint,
          priority: "critical",
          leadershipScore: 100,
        },
      }).effectivePriority,
    ).toBe("low");
    expect(
      projectDynaItemState({
        ...base,
        enrichment: {
          baseFingerprint: "b".repeat(64),
          priority: "critical",
          leadershipScore: 100,
        },
      }).effectivePriority,
    ).toBe("normal");
  });

  test("keeps controller success authoritative and task reports non-terminal", () => {
    const task = {
      taskId: "task",
      hostId: "host",
      state: "running" as const,
      observedAtMs: 10,
    };
    const needsInput = {
      taskId: "task",
      hostId: "host",
      kind: "needs_input" as const,
      body: "Choose the rollout path",
      createdAtMs: 20,
      insertionSequence: 1,
    };
    expect(
      projectDynaItemState({ ...base, tasks: [task], workUpdates: [needsInput] }),
    ).toMatchObject({
      workflowState: "paused",
      blocked: false,
      workState: "needs_input",
      workConditionSummary: "Choose the rollout path",
    });
    expect(
      projectDynaItemState({
        ...base,
        tasks: [{ ...task, state: "succeeded", observedAtMs: 30 }],
        workUpdates: [
          needsInput,
          {
            ...needsInput,
            kind: "completion_reported",
            body: "Reported complete",
            createdAtMs: 25,
            insertionSequence: 2,
          },
        ],
      }),
    ).toMatchObject({ workflowState: "completed", blocked: false });
  });

  test("projects blockers as conditions rather than progress stages", () => {
    expect(
      projectDynaItemState({
        ...base,
        tasks: [{ taskId: "task", hostId: "host", state: "running", observedAtMs: 10 }],
        workUpdates: [
          {
            taskId: "task",
            hostId: "host",
            kind: "blocked",
            body: "Pipeline is unavailable",
            createdAtMs: 20,
            insertionSequence: 1,
          },
        ],
      }),
    ).toMatchObject({
      workflowState: "executing",
      blocked: true,
      workState: "blocked",
      workConditionSummary: "Pipeline is unavailable",
    });
  });
});

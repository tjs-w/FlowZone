import type {
  DynaPriority,
  DynaUserWorkflowStage,
  DynaWorkState,
  DynaWorkUpdateKind,
} from "@flowzone/dyna-contracts";

type DynaTaskState = "queued" | "running" | "waiting" | "succeeded" | "failed" | "unknown";

const EXECUTION_KINDS = new Set<DynaWorkUpdateKind>([
  "progress",
  "needs_input",
  "blocked",
  "completion_reported",
  "handoff",
]);

export interface DynaProjectionTask {
  readonly taskId: string;
  readonly hostId: string;
  readonly state: DynaTaskState;
  readonly observedAtMs: number;
  readonly statusUpdatedAtMs?: number | undefined;
  readonly statusUpdatedAt?: string | undefined;
  readonly outcome?: string | undefined;
}

export interface DynaProjectionWorkUpdate {
  readonly taskId: string;
  readonly hostId: string;
  readonly kind: DynaWorkUpdateKind;
  readonly body: string;
  readonly createdAtMs: number;
  readonly insertionSequence: number;
}

export interface DynaProjectionEnrichment {
  readonly baseFingerprint: string;
  readonly priority?: DynaPriority | undefined;
  readonly leadershipScore: number;
}

export interface DynaItemProjectionInput {
  readonly fingerprint: string;
  readonly sourcePriority: DynaPriority;
  readonly sourceLeadershipScore: number;
  readonly enrichment?: DynaProjectionEnrichment | undefined;
  readonly preferencePriority?: DynaPriority | undefined;
  readonly userWorkflowStage?: DynaUserWorkflowStage | undefined;
  readonly userWorkflow?:
    | {
        readonly stage: DynaUserWorkflowStage;
        readonly outcome?: string | undefined;
        readonly createdAt: string;
        readonly createdAtMs: number;
      }
    | undefined;
  readonly tasks: readonly DynaProjectionTask[];
  readonly workUpdates: readonly DynaProjectionWorkUpdate[];
}

export interface DynaItemProjection {
  readonly effectivePriority: DynaPriority;
  readonly effectiveLeadershipScore: number;
  readonly workflowState: "todo" | "executing" | "paused" | "attention" | "completed";
  readonly blocked: boolean;
  readonly workState?: DynaWorkState | undefined;
  readonly workConditionSummary?: string | undefined;
  readonly workConditionTask?: { readonly taskId: string; readonly hostId: string } | undefined;
  readonly completedAt?: string | undefined;
  readonly completedAtMs?: number | undefined;
  readonly outcome?: string | undefined;
}

interface EffectiveTask extends DynaProjectionTask {
  readonly effectiveState: DynaTaskState;
  readonly blocked: boolean;
  readonly update?: DynaProjectionWorkUpdate | undefined;
}

function latestEligibleUpdate(
  task: DynaProjectionTask,
  updates: readonly DynaProjectionWorkUpdate[],
): DynaProjectionWorkUpdate | undefined {
  if (task.state === "succeeded") return undefined;
  return updates
    .filter(
      (update) =>
        update.taskId === task.taskId &&
        update.hostId === task.hostId &&
        EXECUTION_KINDS.has(update.kind) &&
        task.observedAtMs <= update.createdAtMs,
    )
    .sort(
      (left, right) =>
        right.createdAtMs - left.createdAtMs || right.insertionSequence - left.insertionSequence,
    )[0];
}

function effectiveTask(
  task: DynaProjectionTask,
  updates: readonly DynaProjectionWorkUpdate[],
): EffectiveTask {
  const update = latestEligibleUpdate(task, updates);
  const nativeAttentionState =
    task.state === "waiting" || task.state === "failed" || task.state === "unknown";
  const effectiveState =
    task.state === "succeeded"
      ? "succeeded"
      : nativeAttentionState
        ? task.state
        : update?.kind === "needs_input"
          ? "waiting"
          : update
            ? "running"
            : task.state;
  return {
    ...task,
    effectiveState,
    blocked: update?.kind === "blocked" || task.state === "failed" || task.state === "unknown",
    ...(update ? { update } : {}),
  };
}

function projectedPriority(input: DynaItemProjectionInput): {
  readonly priority: DynaPriority;
  readonly leadershipScore: number;
} {
  const enrichment = input.enrichment;
  let basePriority = input.sourcePriority;
  let leadershipScore = input.sourceLeadershipScore;
  if (enrichment?.baseFingerprint === input.fingerprint) {
    basePriority = enrichment.priority ?? input.sourcePriority;
    leadershipScore = enrichment.leadershipScore;
  }
  if (input.preferencePriority) {
    return { priority: input.preferencePriority, leadershipScore };
  }
  if (leadershipScore >= 75 && basePriority === "normal") {
    return { priority: "high", leadershipScore };
  }
  if (leadershipScore >= 55 && basePriority === "low") {
    return { priority: "normal", leadershipScore };
  }
  return { priority: basePriority, leadershipScore };
}

function projectedWorkflow(
  tasks: readonly EffectiveTask[],
  userWorkflowStage: DynaUserWorkflowStage | undefined,
): DynaItemProjection["workflowState"] {
  if (tasks.some((task) => task.effectiveState === "failed" || task.effectiveState === "unknown")) {
    return "attention";
  }
  if (tasks.some((task) => task.effectiveState === "waiting")) return "paused";
  if (tasks.some((task) => task.effectiveState === "queued" || task.effectiveState === "running")) {
    return "executing";
  }
  if (tasks.length > 0 && tasks.every((task) => task.effectiveState === "succeeded")) {
    return "completed";
  }
  if (tasks.length > 0) return "attention";
  if (userWorkflowStage === "needs_you") return "attention";
  if (userWorkflowStage === "done") return "completed";
  return "todo";
}

function conditionRank(kind: DynaWorkUpdateKind): number {
  if (kind === "needs_input") return 0;
  if (kind === "blocked") return 1;
  return 2;
}

/** Pure characterization of the lifecycle/work/priority precedence used by Dyna. */
export function projectDynaItemState(input: DynaItemProjectionInput): DynaItemProjection {
  const tasks = input.tasks.map((task) => effectiveTask(task, input.workUpdates));
  const condition = tasks
    .flatMap((task) => (task.update ? [task.update] : []))
    .sort(
      (left, right) =>
        conditionRank(left.kind) - conditionRank(right.kind) ||
        right.createdAtMs - left.createdAtMs ||
        right.insertionSequence - left.insertionSequence,
    )[0];
  const priority = projectedPriority(input);
  const hasCondition = condition?.kind === "needs_input" || condition?.kind === "blocked";
  const workflowState = projectedWorkflow(
    tasks,
    input.userWorkflow?.stage ?? input.userWorkflowStage,
  );
  const latestSucceeded = [...input.tasks]
    .filter((task) => task.state === "succeeded")
    .sort(
      (left, right) =>
        (right.statusUpdatedAtMs ?? Number.NEGATIVE_INFINITY) -
          (left.statusUpdatedAtMs ?? Number.NEGATIVE_INFINITY) ||
        left.taskId.localeCompare(right.taskId) ||
        left.hostId.localeCompare(right.hostId),
    )[0];
  const completedAtMs =
    workflowState === "completed"
      ? (latestSucceeded?.statusUpdatedAtMs ?? input.userWorkflow?.createdAtMs)
      : undefined;
  const completedAt =
    workflowState === "completed"
      ? (latestSucceeded?.statusUpdatedAt ?? input.userWorkflow?.createdAt)
      : undefined;
  const outcome =
    workflowState === "completed"
      ? (latestSucceeded?.outcome ?? input.userWorkflow?.outcome)
      : undefined;
  return {
    effectivePriority: priority.priority,
    effectiveLeadershipScore: priority.leadershipScore,
    workflowState,
    blocked: tasks.some((task) => task.blocked),
    ...(condition ? { workState: condition.kind as DynaWorkState } : {}),
    ...(hasCondition
      ? {
          workConditionSummary: condition.body.slice(0, 200),
          workConditionTask: { taskId: condition.taskId, hostId: condition.hostId },
        }
      : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(completedAtMs !== undefined ? { completedAtMs } : {}),
    ...(outcome ? { outcome } : {}),
  };
}

import * as z from "zod/mini";

import { dynaSourceUrl, sourceOrigin } from "./source-url.js";
import type {
  DynaItemNumber,
  DynaSourceRef,
  DynaTaskSyncBeginResult,
  DynaTaskSyncStatusResult,
  DynaUiPayload,
  DynaWorkActivityPage,
} from "./index.js";

export { dynaSourceUrl };

function trimmedString(minimum: number, maximum: number) {
  return z.string().check(z.trim(), z.minLength(minimum), z.maxLength(maximum));
}

function boundedString(maximum: number) {
  return z.string().check(z.maxLength(maximum));
}

const IdentifierSchema = trimmedString(1, 256);
const TimestampSchema = z.iso.datetime({ offset: true });
const DynaItemNumberSchema = z.int().check(z.positive(), z.maximum(Number.MAX_SAFE_INTEGER));
const DynaPrioritySchema = z.enum(["critical", "high", "normal", "low"]);
const DynaSourceSchema = z.enum([
  "slack",
  "outlook",
  "gitlab",
  "codex",
  "email",
  "messaging",
  "scm",
  "twg",
  "skill",
  "manual",
]);

export function formatDynaItemNumber(itemNumber: DynaItemNumber): string {
  return `:${String(DynaItemNumberSchema.parse(itemNumber))}:`;
}

const DynaSourceRefSchema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("slack"),
    workspaceId: IdentifierSchema,
    channelId: IdentifierSchema,
    messageId: IdentifierSchema,
  }),
  z.strictObject({
    source: z.literal("outlook"),
    accountId: IdentifierSchema,
    messageId: IdentifierSchema,
    conversationId: z.optional(IdentifierSchema),
  }),
  z.strictObject({
    source: z.literal("gitlab"),
    instanceId: IdentifierSchema,
    projectPath: trimmedString(1, 512),
    iid: z.int().check(z.positive()),
    entityType: z.enum(["merge_request", "issue", "pipeline"]),
  }),
  z.strictObject({ source: z.literal("codex"), taskId: IdentifierSchema }),
  z.strictObject({
    source: z.literal("email"),
    provider: trimmedString(1, 64),
    accountId: IdentifierSchema,
    messageId: IdentifierSchema,
    conversationId: z.optional(IdentifierSchema),
  }),
  z.strictObject({
    source: z.literal("messaging"),
    provider: trimmedString(1, 64),
    workspaceId: IdentifierSchema,
    channelId: IdentifierSchema,
    messageId: IdentifierSchema,
  }),
  z.strictObject({
    source: z.literal("scm"),
    provider: trimmedString(1, 64),
    instanceId: IdentifierSchema,
    repository: trimmedString(1, 512),
    entityType: z.enum(["pull_request", "merge_request", "issue", "pipeline", "commit"]),
    entityId: IdentifierSchema,
  }),
  z.strictObject({
    source: z.literal("twg"),
    contextId: IdentifierSchema,
    resultType: z.enum(["jira", "confluence", "bitbucket", "org", "work", "other"]),
    recordId: IdentifierSchema,
  }),
  z.strictObject({
    source: z.literal("skill"),
    contextId: IdentifierSchema,
    skillName: trimmedString(1, 128),
    recordType: trimmedString(1, 64),
    recordId: IdentifierSchema,
  }),
  z.strictObject({ source: z.literal("manual"), todoId: z.uuid() }),
]);

const DynaPersonSignalSchema = z.strictObject({
  displayName: trimmedString(1, 120),
  title: z.optional(trimmedString(1, 160)),
  leadershipLevel: z.enum([
    "ceo",
    "cto",
    "gm",
    "vp",
    "senior_director",
    "director",
    "architect",
    "vip",
    "other",
  ]),
  relationship: z.enum(["management_chain", "my_org", "neighboring_org", "external", "unknown"]),
  involvement: z.enum([
    "sender",
    "author",
    "declared_owner",
    "operational_owner",
    "approver",
    "reviewer",
    "expert",
    "informed",
    "mentioned",
  ]),
  provenance: z.enum(["user_configured", "twg_org_tree", "declared_source", "source_metadata"]),
  confidence: z.enum(["high", "medium", "low"]),
});

const DynaNextStepSchema = z.strictObject({
  label: trimmedString(1, 200),
  owner: z.optional(trimmedString(1, 120)),
  dueAt: z.optional(TimestampSchema),
});

const DynaTaskTitleSchema = z.string().check(
  z.minLength(1),
  z.refine((value: string) => value.trim().length > 0, {
    message: "A Codex task title cannot contain only whitespace.",
  }),
  z.refine((value: string) => Array.from(value).length <= 200, {
    message: "A Codex task title cannot exceed 200 Unicode characters.",
  }),
);

const DynaOneLineOutcomeSchema = trimmedString(1, 200).check(
  z.regex(/^[^\r\n]+$/, "A Codex task outcome must be exactly one line."),
);

const DynaWorkTaskAttributionSchema = z.strictObject({
  taskId: IdentifierSchema,
  hostId: IdentifierSchema,
});

const DynaAttributedTaskSchema = z.extend(DynaWorkTaskAttributionSchema, {
  title: z.optional(DynaTaskTitleSchema),
});

const DynaTaskStatusBaseSchema = z.strictObject({
  taskId: IdentifierSchema,
  hostId: IdentifierSchema,
  projectId: z.optional(IdentifierSchema),
  title: DynaTaskTitleSchema,
  statusUpdatedAt: TimestampSchema,
  observedAt: TimestampSchema,
});

const DynaTaskStatusSchema = z.discriminatedUnion("state", [
  z.extend(DynaTaskStatusBaseSchema, {
    state: z.literal("succeeded"),
    outcome: z.optional(DynaOneLineOutcomeSchema),
  }),
  z.extend(DynaTaskStatusBaseSchema, {
    state: z.enum(["queued", "running", "waiting", "failed", "unknown"]),
    outcome: z.optional(DynaOneLineOutcomeSchema),
  }),
]);

const DynaArtifactRefSchema = z.strictObject({
  kind: z.enum([
    "merge_request",
    "pull_request",
    "issue",
    "pipeline",
    "commit",
    "document",
    "report",
    "other",
  ]),
  label: trimmedString(1, 160),
  url: z.url().check(
    z.maxLength(2_048),
    z.refine(
      (value: string) =>
        (value.startsWith("https://") || value.startsWith("http://")) &&
        sourceOrigin(value) !== undefined,
      { message: "A Dyna artifact must use an HTTP or HTTPS URL without embedded credentials." },
    ),
  ),
});

const DynaTaskSyncSummarySchema = z.strictObject({
  runId: z.uuid(),
  dashboardId: z.uuid(),
  state: z.enum(["syncing", "updated", "current", "partial", "expired", "unavailable"]),
  processedTasks: z.int().check(z.minimum(0), z.maximum(200)),
  totalTasks: z.int().check(z.minimum(0), z.maximum(200)),
  updatedItems: z.int().check(z.minimum(0), z.maximum(200)),
  unavailableTasks: z.int().check(z.minimum(0), z.maximum(200)),
  incompleteMetadataTasks: z.int().check(z.minimum(0), z.maximum(200)),
  remainingTasks: z.int().check(z.nonnegative()),
  startedAt: TimestampSchema,
  completedAt: z.optional(TimestampSchema),
  updatedAt: TimestampSchema,
});

export const DynaTaskSyncBeginResultSchema = z.strictObject({
  schema: z.literal("dyna/task-sync-begin-result-v1"),
  joined: z.boolean(),
  deliveryRequired: z.boolean(),
  summary: DynaTaskSyncSummarySchema,
}) satisfies z.ZodMiniType<DynaTaskSyncBeginResult>;

export const DynaTaskSyncStatusResultSchema = z.strictObject({
  schema: z.literal("dyna/task-sync-status-result-v1"),
  summary: DynaTaskSyncSummarySchema,
}) satisfies z.ZodMiniType<DynaTaskSyncStatusResult>;

const DynaWorkUpdateKindSchema = z.enum([
  "note",
  "progress",
  "decision",
  "needs_input",
  "blocked",
  "completion_reported",
  "handoff",
]);

const DynaWorkStateSchema = z.enum([
  "progress",
  "needs_input",
  "blocked",
  "completion_reported",
  "handoff",
]);

const DynaWorkUpdateSchema = z
  .strictObject({
    schema: z.literal("dyna/work-update-v1"),
    id: z.uuid(),
    itemId: z.uuid(),
    originDashboardId: z.uuid(),
    workAttemptId: z.uuid(),
    kind: DynaWorkUpdateKindSchema,
    body: trimmedString(1, 1_000),
    outcome: z.optional(DynaOneLineOutcomeSchema),
    artifacts: z.array(DynaArtifactRefSchema).check(z.maxLength(4)),
    task: z.optional(DynaAttributedTaskSchema),
    supersedesWorkUpdateId: z.optional(z.uuid()),
    createdAt: TimestampSchema,
  })
  .check(
    z.superRefine((update, context) => {
      if (update.kind === "completion_reported" && !update.outcome) {
        context.addIssue({
          code: "custom",
          message: "A completion report requires a precise one-line outcome.",
          path: ["outcome"],
          input: update,
        });
      }
      if (update.kind !== "completion_reported" && update.outcome) {
        context.addIssue({
          code: "custom",
          message: "Only a completion report can carry an outcome.",
          path: ["outcome"],
          input: update,
        });
      }
    }),
  );

const DynaAnnotationSchema = z
  .strictObject({
    id: z.uuid(),
    itemId: z.uuid(),
    body: trimmedString(1, 1_000),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    version: z.int().check(z.positive()),
    task: z.optional(DynaAttributedTaskSchema),
    workAttemptId: z.optional(z.uuid()),
  })
  .check(
    z.superRefine((annotation, context) => {
      if ((annotation.task === undefined) !== (annotation.workAttemptId === undefined)) {
        context.addIssue({
          code: "custom",
          message: "Task-attributed annotations require both task and work-attempt identity.",
          path: annotation.task ? ["workAttemptId"] : ["task"],
          input: annotation,
        });
      }
    }),
  );

const DynaArchiveStateSchema = z.strictObject({
  id: z.uuid(),
  reason: z.enum(["completed", "invalid", "duplicate", "no_action_needed", "superseded", "other"]),
  reasonDetail: z.optional(trimmedString(1, 500)),
  mode: z.enum(["manual", "automatic"]),
  archivedAt: TimestampSchema,
  completedAt: z.optional(TimestampSchema),
  workflowStateAtArchive: z.enum(["todo", "executing", "paused", "attention", "completed"]),
  wasCompleted: z.boolean(),
  changedSinceArchive: z.boolean(),
});

function validateFollowUpReference(
  value: {
    readonly followUpOfItemId?: string | undefined;
    readonly followUpOfItemNumber?: number | undefined;
  },
  context: z.core.$RefinementCtx,
): void {
  if ((value.followUpOfItemId === undefined) === (value.followUpOfItemNumber === undefined)) return;
  context.addIssue({
    code: "custom",
    message: "A Dyna follow-up must include both the item UUID and human-readable number.",
    path: [value.followUpOfItemId === undefined ? "followUpOfItemId" : "followUpOfItemNumber"],
    input: value,
  });
}

function validateCompletionAttribution(
  value: {
    readonly completionAuthority?: "dyna_user" | "dyna_task" | "native_controller" | undefined;
    readonly completionTask?: z.output<typeof DynaAttributedTaskSchema> | undefined;
    readonly completionWorkAttemptId?: string | undefined;
  },
  context: z.core.$RefinementCtx,
): void {
  const hasTask = value.completionTask !== undefined;
  const hasAttempt = value.completionWorkAttemptId !== undefined;
  if (value.completionAuthority === "dyna_task") {
    if (!hasTask || !hasAttempt) {
      context.addIssue({
        code: "custom",
        message: "Task-authored Dyna completion requires task and work-attempt attribution.",
        path: !hasTask ? ["completionTask"] : ["completionWorkAttemptId"],
        input: value,
      });
    }
    return;
  }
  if (hasTask || hasAttempt) {
    context.addIssue({
      code: "custom",
      message: "Only task-authored Dyna completion can carry task attribution.",
      path: hasTask ? ["completionTask"] : ["completionWorkAttemptId"],
      input: value,
    });
  }
}

const DynaCardSchema = z
  .strictObject({
    id: z.uuid(),
    itemNumber: DynaItemNumberSchema,
    fingerprint: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
    source: DynaSourceSchema,
    sourceRef: DynaSourceRefSchema,
    sourceLabel: trimmedString(1, 128),
    title: boundedString(200),
    summary: boundedString(1_000),
    sourcePriority: DynaPrioritySchema,
    priority: DynaPrioritySchema,
    priorityReason: boundedString(500),
    sourceUpdatedAt: TimestampSchema,
    dueAt: z.optional(TimestampSchema),
    labels: z.array(boundedString(64)).check(z.maxLength(20)),
    people: z.array(DynaPersonSignalSchema).check(z.maxLength(8)),
    leadershipScore: z.int().check(z.minimum(0), z.maximum(120)),
    priorityMode: z.enum(["source", "enrichment", "leadership", "manual"]),
    sequence: z.optional(z.int().check(z.nonnegative())),
    canMoveEarlier: z.boolean(),
    canMoveLater: z.boolean(),
    workflowState: z.enum(["todo", "executing", "paused", "attention", "completed"]),
    completedAt: z.optional(TimestampSchema),
    outcome: z.optional(trimmedString(1, 200)),
    completionAuthority: z.optional(z.enum(["dyna_user", "dyna_task", "native_controller"])),
    completionTask: z.optional(DynaAttributedTaskSchema),
    completionWorkAttemptId: z.optional(z.uuid()),
    followUpOfItemId: z.optional(z.uuid()),
    followUpOfItemNumber: z.optional(DynaItemNumberSchema),
    attention: z.optional(trimmedString(1, 500)),
    plan: z.array(trimmedString(1, 200)).check(z.maxLength(4)),
    nextSteps: z.array(DynaNextStepSchema).check(z.maxLength(4)),
    enrichmentState: z.optional(z.enum(["active", "stale"])),
    annotations: z.array(DynaAnnotationSchema).check(z.maxLength(20)),
    workUpdates: z._default(z.array(DynaWorkUpdateSchema).check(z.maxLength(1)), []),
    workUpdateCount: z._default(z.int().check(z.nonnegative()), 0),
    workState: z.optional(DynaWorkStateSchema),
    workConditionSummary: z.optional(trimmedString(1, 200)),
    workConditionTask: z.optional(DynaWorkTaskAttributionSchema),
    matchedActivity: z.optional(trimmedString(1, 500)),
    blocked: z._default(z.boolean(), false),
    titleSyncNeeded: z._default(z.boolean(), false),
    linkedTasks: z.array(DynaTaskStatusSchema).check(z.maxLength(8)),
    archive: z.optional(DynaArchiveStateSchema),
  })
  .check(z.superRefine(validateFollowUpReference), z.superRefine(validateCompletionAttribution));

const DynaRequiredSourceSliceSchema = z.strictObject({
  source: z.enum([
    "slack",
    "outlook",
    "gitlab",
    "codex",
    "email",
    "messaging",
    "scm",
    "twg",
    "skill",
  ]),
  sourceScope: trimmedString(1, 128),
});

const DynaRequiredSourceSlicesSchema = z.array(DynaRequiredSourceSliceSchema).check(
  z.minLength(1),
  z.maxLength(50),
  z.superRefine((slices, context) => {
    const seen = new Set<string>();
    for (const [index, slice] of slices.entries()) {
      const key = JSON.stringify([slice.source, slice.sourceScope]);
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          message: "A Dyna publisher manifest cannot require the same source slice twice.",
          path: [index],
          input: slices,
        });
      }
      seen.add(key);
    }
  }),
);

const DynaPublisherSourceSliceSchema = z.strictObject({
  source: DynaRequiredSourceSliceSchema.shape.source,
  sourceScope: trimmedString(1, 128),
  status: z.enum(["succeeded", "failed"]),
  freshness: z.enum(["fresh", "aging", "stale"]),
});

const DynaPublisherSchema = z.strictObject({
  id: z.uuid(),
  name: trimmedString(1, 96),
  scheduleId: z.optional(IdentifierSchema),
  scheduleTitle: z.optional(trimmedString(1, 200)),
  scheduleState: z.enum(["active", "paused", "unknown"]),
  staleAfterMinutes: z.int().check(z.minimum(5), z.maximum(43_200)),
  credentialMode: z.enum(["disabled", "local_preview", "local_cli"]),
  requiredSourceSlices: z.optional(DynaRequiredSourceSlicesSchema),
  lastRunStatus: z.enum(["never", "succeeded", "partial", "failed"]),
  lastRunAt: z.optional(TimestampSchema),
  lastRunError: z.optional(trimmedString(1, 500)),
  lastSourceSlices: z.optional(z.array(DynaPublisherSourceSliceSchema).check(z.maxLength(50))),
  revokedAt: z.optional(TimestampSchema),
  createdAt: TimestampSchema,
});

const DynaDashboardSchema = z.strictObject({
  id: z.uuid(),
  name: trimmedString(1, 96),
  description: trimmedString(0, 500),
  archived: z.boolean(),
  doneRetentionHours: z._default(z.int().check(z.minimum(1), z.maximum(8_760)), 24),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

const DynaDashboardSnapshotSchema = z.strictObject({
  schema: z.literal("dyna/snapshot-v9"),
  dashboard: DynaDashboardSchema,
  generatedAt: TimestampSchema,
  query: boundedString(500),
  scope: z._default(z.enum(["active", "archive"]), "active"),
  revision: z.int().check(z.nonnegative()),
  freshness: z.enum(["fresh", "aging", "stale"]),
  counts: z.strictObject({
    critical: z.int().check(z.nonnegative()),
    high: z.int().check(z.nonnegative()),
    leadership: z.int().check(z.nonnegative()),
    total: z.int().check(z.nonnegative()),
    archived: z._default(z.int().check(z.nonnegative()), 0),
    blocked: z._default(z.int().check(z.nonnegative()), 0),
  }),
  schedules: z.array(DynaPublisherSchema).check(z.maxLength(50)),
  cards: z.array(DynaCardSchema).check(z.maxLength(200)),
  taskSync: z.optional(DynaTaskSyncSummarySchema),
});

export const DynaUiPayloadSchema = z.strictObject({
  schema: z.literal("dyna/ui-v11"),
  viewToken: z.string().check(z.minLength(32), z.maxLength(128)),
  snapshot: DynaDashboardSnapshotSchema,
}) satisfies z.ZodMiniType<DynaUiPayload>;

const DynaPageCursorSchema = trimmedString(1, 512);

export const DynaWorkActivityPageSchema = z.strictObject({
  itemId: z.uuid(),
  itemNumber: DynaItemNumberSchema,
  updates: z.array(DynaWorkUpdateSchema).check(z.maxLength(25)),
  nextCursor: z.optional(DynaPageCursorSchema),
  total: z.int().check(z.nonnegative()),
}) satisfies z.ZodMiniType<DynaWorkActivityPage>;

export type { DynaSourceRef };

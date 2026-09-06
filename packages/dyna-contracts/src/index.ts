import { z } from "zod";

const IdentifierSchema = z.string().trim().min(1).max(256);
const TimestampSchema = z.iso.datetime({ offset: true });

export const DynaSourceSchema = z.enum([
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
export type DynaSource = z.infer<typeof DynaSourceSchema>;

export const DynaScheduledSourceSchema = z.enum([
  "slack",
  "outlook",
  "gitlab",
  "codex",
  "email",
  "messaging",
  "scm",
  "twg",
  "skill",
]);
export type DynaScheduledSource = z.infer<typeof DynaScheduledSourceSchema>;

export const DynaPrioritySchema = z.enum(["critical", "high", "normal", "low"]);
export type DynaPriority = z.infer<typeof DynaPrioritySchema>;

export const DynaSourceRefSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("slack"),
      workspaceId: IdentifierSchema,
      channelId: IdentifierSchema,
      messageId: IdentifierSchema,
    })
    .strict(),
  z
    .object({
      source: z.literal("outlook"),
      accountId: IdentifierSchema,
      messageId: IdentifierSchema,
      conversationId: IdentifierSchema.optional(),
    })
    .strict(),
  z
    .object({
      source: z.literal("gitlab"),
      instanceId: IdentifierSchema,
      projectPath: z.string().trim().min(1).max(512),
      iid: z.number().int().positive(),
      entityType: z.enum(["merge_request", "issue", "pipeline"]),
    })
    .strict(),
  z
    .object({
      source: z.literal("codex"),
      taskId: IdentifierSchema,
    })
    .strict(),
  z
    .object({
      source: z.literal("email"),
      provider: z.string().trim().min(1).max(64),
      accountId: IdentifierSchema,
      messageId: IdentifierSchema,
      conversationId: IdentifierSchema.optional(),
    })
    .strict(),
  z
    .object({
      source: z.literal("messaging"),
      provider: z.string().trim().min(1).max(64),
      workspaceId: IdentifierSchema,
      channelId: IdentifierSchema,
      messageId: IdentifierSchema,
    })
    .strict(),
  z
    .object({
      source: z.literal("scm"),
      provider: z.string().trim().min(1).max(64),
      instanceId: IdentifierSchema,
      repository: z.string().trim().min(1).max(512),
      entityType: z.enum(["pull_request", "merge_request", "issue", "pipeline", "commit"]),
      entityId: IdentifierSchema,
    })
    .strict(),
  z
    .object({
      source: z.literal("twg"),
      contextId: IdentifierSchema,
      resultType: z.enum(["jira", "confluence", "bitbucket", "org", "work", "other"]),
      recordId: IdentifierSchema,
    })
    .strict(),
  z
    .object({
      source: z.literal("skill"),
      contextId: IdentifierSchema,
      skillName: z.string().trim().min(1).max(128),
      recordType: z.string().trim().min(1).max(64),
      recordId: IdentifierSchema,
    })
    .strict(),
  z
    .object({
      source: z.literal("manual"),
      todoId: z.uuid(),
    })
    .strict(),
]);
export type DynaSourceRef = z.infer<typeof DynaSourceRefSchema>;

export const DynaLeadershipLevelSchema = z.enum([
  "ceo",
  "cto",
  "gm",
  "vp",
  "senior_director",
  "director",
  "architect",
  "vip",
  "other",
]);

export const DynaPersonSignalSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(160).optional(),
    leadershipLevel: DynaLeadershipLevelSchema,
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
  })
  .strict();
export type DynaPersonSignal = z.infer<typeof DynaPersonSignalSchema>;

export const DynaPublishedPersonSignalSchema = DynaPersonSignalSchema.refine(
  (person) => person.provenance === "declared_source" || person.provenance === "source_metadata",
  "Scheduled publishers cannot assert trusted leadership provenance.",
);

export const DynaNextStepSchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    owner: z.string().trim().min(1).max(120).optional(),
    dueAt: TimestampSchema.optional(),
  })
  .strict();
export type DynaNextStep = z.infer<typeof DynaNextStepSchema>;

const LEADERSHIP_WEIGHTS: Readonly<Record<DynaPersonSignal["leadershipLevel"], number>> = {
  ceo: 100,
  cto: 95,
  gm: 85,
  vp: 80,
  senior_director: 70,
  director: 60,
  vip: 65,
  architect: 55,
  other: 0,
};

const PRIORITY_BEARING_INVOLVEMENT = new Set<DynaPersonSignal["involvement"]>([
  "sender",
  "author",
  "declared_owner",
  "operational_owner",
  "approver",
]);

export function dynaLeadershipScore(people: readonly DynaPersonSignal[]): number {
  return people.reduce((highest, person) => {
    if (
      !PRIORITY_BEARING_INVOLVEMENT.has(person.involvement) ||
      person.confidence === "low" ||
      (person.provenance !== "user_configured" && person.provenance !== "twg_org_tree")
    ) {
      return highest;
    }
    const relationshipWeight =
      person.relationship === "management_chain"
        ? 10
        : person.relationship === "my_org" || person.relationship === "neighboring_org"
          ? 5
          : 0;
    return Math.max(highest, LEADERSHIP_WEIGHTS[person.leadershipLevel] + relationshipWeight);
  }, 0);
}

export function effectiveDynaPriority(
  priority: DynaPriority,
  people: readonly DynaPersonSignal[],
): DynaPriority {
  const score = dynaLeadershipScore(people);
  if (priority === "critical" || priority === "high") return priority;
  if (priority === "normal" && score >= 75) return "high";
  if (priority === "low" && score >= 55) return "normal";
  return priority;
}

export function dynaSourceLabel(sourceRef: DynaSourceRef): string {
  switch (sourceRef.source) {
    case "slack":
      return "Slack";
    case "outlook":
      return "Outlook";
    case "gitlab":
      return "GitLab";
    case "codex":
      return "Codex";
    case "email":
    case "messaging":
    case "scm":
      return sourceRef.provider;
    case "twg":
      return "TWG";
    case "skill":
      return sourceRef.skillName;
    case "manual":
      return "To-do";
  }
}

export const DynaTodoInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(1_000).optional(),
    priority: DynaPrioritySchema.default("normal"),
    attention: z.string().trim().min(1).max(500).optional(),
    labels: z.array(z.string().trim().min(1).max(64)).max(8).default([]),
    followUpOfItemId: z.uuid().optional(),
  })
  .strict();
export type DynaTodoInput = z.infer<typeof DynaTodoInputSchema>;

export const DynaPublishedItemSchema = z
  .object({
    externalId: IdentifierSchema,
    sourceRef: DynaSourceRefSchema,
    sourceScope: z.string().trim().min(1).max(128),
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(1_000),
    priority: DynaPrioritySchema,
    priorityReason: z.string().trim().min(1).max(500),
    sourceUpdatedAt: TimestampSchema,
    dueAt: TimestampSchema.optional(),
    labels: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
    people: z.array(DynaPublishedPersonSignalSchema).max(8).default([]),
    attention: z.string().trim().min(1).max(500).optional(),
    plan: z.array(z.string().trim().min(1).max(200)).max(4).default([]),
    nextSteps: z.array(DynaNextStepSchema).max(4).default([]),
  })
  .strict();
export type DynaPublishedItem = z.infer<typeof DynaPublishedItemSchema>;

export const DynaScheduledPublishedItemSchema = DynaPublishedItemSchema.refine(
  (item) => item.sourceRef.source !== "manual",
  {
    message: "Scheduled Dyna publishers cannot publish manual records.",
    path: ["sourceRef", "source"],
  },
);

export const DynaRequiredSourceSliceSchema = z
  .object({
    source: DynaScheduledSourceSchema,
    sourceScope: z.string().trim().min(1).max(128),
  })
  .strict();
export type DynaRequiredSourceSlice = z.infer<typeof DynaRequiredSourceSliceSchema>;

export const DynaRequiredSourceSlicesSchema = z
  .array(DynaRequiredSourceSliceSchema)
  .min(1)
  .max(50)
  .superRefine((slices, context) => {
    const seen = new Set<string>();
    for (const [index, slice] of slices.entries()) {
      const key = JSON.stringify([slice.source, slice.sourceScope]);
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          message: "A Dyna publisher manifest cannot require the same source slice twice.",
          path: [index],
        });
      }
      seen.add(key);
    }
  });

export const DynaPublishSourceSliceSchema = z
  .object({
    source: DynaScheduledSourceSchema,
    sourceScope: z.string().trim().min(1).max(128),
    status: z.enum(["succeeded", "failed"]),
  })
  .strict();
export type DynaPublishSourceSlice = z.infer<typeof DynaPublishSourceSliceSchema>;

export const DynaPublishSourceSlicesSchema = z
  .array(DynaPublishSourceSliceSchema)
  .min(1)
  .max(50)
  .superRefine((slices, context) => {
    const seen = new Set<string>();
    for (const [index, slice] of slices.entries()) {
      const key = JSON.stringify([slice.source, slice.sourceScope]);
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          message: "A Dyna publish run cannot declare the same source slice twice.",
          path: [index],
        });
      }
      seen.add(key);
    }
  });

export const DynaMaterializedItemSchema = DynaPublishedItemSchema.extend({
  people: z.array(DynaPersonSignalSchema).max(8).default([]),
});

export const DynaCredentialModeSchema = z.enum(["disabled", "local_preview", "local_cli"]);
export type DynaCredentialMode = z.infer<typeof DynaCredentialModeSchema>;

export const DynaPublisherSourceSliceSchema = DynaPublishSourceSliceSchema.extend({
  freshness: z.enum(["fresh", "aging", "stale"]),
});
export type DynaPublisherSourceSlice = z.infer<typeof DynaPublisherSourceSliceSchema>;

export const DynaDashboardSchema = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(96),
    description: z.string().trim().max(500),
    archived: z.boolean(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type DynaDashboard = z.infer<typeof DynaDashboardSchema>;

export const DynaPublisherSchema = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(96),
    scheduleId: IdentifierSchema.optional(),
    scheduleTitle: z.string().trim().min(1).max(200).optional(),
    scheduleState: z.enum(["active", "paused", "unknown"]),
    staleAfterMinutes: z.number().int().min(5).max(43_200),
    credentialMode: DynaCredentialModeSchema,
    requiredSourceSlices: DynaRequiredSourceSlicesSchema.optional(),
    lastRunStatus: z.enum(["never", "succeeded", "partial", "failed"]),
    lastRunAt: TimestampSchema.optional(),
    lastRunError: z.string().trim().min(1).max(500).optional(),
    lastSourceSlices: z.array(DynaPublisherSourceSliceSchema).max(50).optional(),
    revokedAt: TimestampSchema.optional(),
    createdAt: TimestampSchema,
  })
  .strict();
export type DynaPublisher = z.infer<typeof DynaPublisherSchema>;

export const DynaTaskStateSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "unknown",
]);

const DynaTaskStatusBaseSchema = z
  .object({
    taskId: IdentifierSchema,
    hostId: IdentifierSchema,
    projectId: IdentifierSchema.optional(),
    title: z.string().trim().min(1).max(200),
    statusUpdatedAt: TimestampSchema,
    observedAt: TimestampSchema,
  })
  .strict();

const DynaOneLineOutcomeSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\r\n]+$/, "A Codex task outcome must be exactly one line.");

export const DynaTaskStatusSchema = z.discriminatedUnion("state", [
  DynaTaskStatusBaseSchema.extend({
    state: z.literal("succeeded"),
    outcome: DynaOneLineOutcomeSchema,
  }).strict(),
  DynaTaskStatusBaseSchema.extend({
    state: z.enum(["queued", "running", "waiting", "failed", "unknown"]),
    outcome: DynaOneLineOutcomeSchema.optional(),
  }).strict(),
]);
export type DynaTaskStatus = z.infer<typeof DynaTaskStatusSchema>;

export const DynaAnnotationSchema = z
  .object({
    id: z.uuid(),
    itemId: z.uuid(),
    body: z.string().trim().min(1).max(1_000),
    createdAt: TimestampSchema,
  })
  .strict();

export const DynaItemContextSchema = DynaMaterializedItemSchema.extend({
  id: z.uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  enrichment: z
    .object({
      state: z.enum(["active", "stale"]),
      appliedAt: TimestampSchema,
      baseSourceUpdatedAt: TimestampSchema,
      provenance: z.string().trim().min(1).max(128),
      version: z.number().int().positive(),
    })
    .strict()
    .optional(),
  annotations: z.array(DynaAnnotationSchema).max(20),
}).strict();
export type DynaItemContext = z.infer<typeof DynaItemContextSchema>;

export const DynaActionItemContextSchema = z
  .object({
    id: z.uuid(),
    title: z.string().trim().min(1).max(200),
    sourceRef: DynaSourceRefSchema,
    sourceUpdatedAt: TimestampSchema,
    annotations: z.array(DynaAnnotationSchema).max(20),
    trustBoundary: z.literal("untrusted_reference_data"),
  })
  .strict();

export const DynaActionKindSchema = z.enum([
  "open_source",
  "create_codex_task",
  "open_codex_task",
  "refresh_codex_status",
]);

export const DynaActionStateSchema = z.enum([
  "prepared",
  "delivered",
  "claimed",
  "succeeded",
  "failed",
  "needs_reconciliation",
]);

export const DynaActionRequestSchema = z
  .object({
    id: z.uuid(),
    kind: DynaActionKindSchema,
    itemId: z.uuid().optional(),
    taskId: IdentifierSchema.optional(),
    taskHostId: IdentifierSchema.optional(),
    dashboardRevision: z.number().int().nonnegative(),
    itemFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    state: DynaActionStateSchema,
    expiresAt: TimestampSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const DynaCardSchema = z
  .object({
    id: z.uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    source: DynaSourceSchema,
    sourceRef: DynaSourceRefSchema,
    sourceLabel: z.string().trim().min(1).max(128),
    title: z.string().max(200),
    summary: z.string().max(1_000),
    sourcePriority: DynaPrioritySchema,
    priority: DynaPrioritySchema,
    priorityReason: z.string().max(500),
    sourceUpdatedAt: TimestampSchema,
    dueAt: TimestampSchema.optional(),
    labels: z.array(z.string().max(64)).max(20),
    people: z.array(DynaPersonSignalSchema).max(8),
    leadershipScore: z.number().int().min(0).max(120),
    priorityMode: z.enum(["source", "enrichment", "leadership", "manual"]),
    sequence: z.number().int().nonnegative().optional(),
    canMoveEarlier: z.boolean(),
    canMoveLater: z.boolean(),
    workflowState: z.enum(["todo", "executing", "paused", "attention", "completed"]),
    outcome: z.string().trim().min(1).max(200).optional(),
    followUpOfItemId: z.uuid().optional(),
    attention: z.string().trim().min(1).max(500).optional(),
    plan: z.array(z.string().trim().min(1).max(200)).max(4),
    nextSteps: z.array(DynaNextStepSchema).max(4),
    enrichmentState: z.enum(["active", "stale"]).optional(),
    annotations: z.array(DynaAnnotationSchema).max(20),
    linkedTasks: z.array(DynaTaskStatusSchema).max(8),
  })
  .strict();
export type DynaCard = z.infer<typeof DynaCardSchema>;

export const DynaDashboardSnapshotSchema = z
  .object({
    schema: z.literal("dyna/snapshot-v4"),
    dashboard: DynaDashboardSchema,
    generatedAt: TimestampSchema,
    query: z.string().max(500),
    revision: z.number().int().nonnegative(),
    freshness: z.enum(["fresh", "aging", "stale"]),
    counts: z
      .object({
        critical: z.number().int().nonnegative(),
        high: z.number().int().nonnegative(),
        leadership: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      })
      .strict(),
    schedules: z.array(DynaPublisherSchema).max(50),
    cards: z.array(DynaCardSchema).max(200),
  })
  .strict();
export type DynaDashboardSnapshot = z.infer<typeof DynaDashboardSnapshotSchema>;

export const DynaUiPayloadSchema = z
  .object({
    schema: z.literal("dyna/ui-v6"),
    viewToken: z.string().min(32).max(128),
    snapshot: DynaDashboardSnapshotSchema,
  })
  .strict();
export type DynaUiPayload = z.infer<typeof DynaUiPayloadSchema>;

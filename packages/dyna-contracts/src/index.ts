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

function sourceOrigin(value: string): string | undefined {
  try {
    const Url = (
      globalThis as unknown as {
        readonly URL: new (input: string) => {
          readonly protocol: string;
          readonly username: string;
          readonly password: string;
          readonly origin: string;
        };
      }
    ).URL;
    const url = new Url(value.includes("://") ? value : `https://${value}`);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function encodedPath(value: string): string {
  return value
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function gitLabEntityPath(entityType: "merge_request" | "issue" | "pipeline"): string {
  return {
    merge_request: "merge_requests",
    issue: "issues",
    pipeline: "pipelines",
  }[entityType];
}

/**
 * Builds a browser destination from the validated typed source identity. It never
 * accepts a publisher-supplied arbitrary URL.
 */
export function dynaSourceUrl(sourceRef: DynaSourceRef): string | undefined {
  switch (sourceRef.source) {
    case "slack":
      return `https://app.slack.com/client/${encodeURIComponent(sourceRef.workspaceId)}/${encodeURIComponent(sourceRef.channelId)}/thread/${encodeURIComponent(sourceRef.channelId)}-${encodeURIComponent(sourceRef.messageId)}`;
    case "outlook":
      return `https://outlook.office.com/mail/deeplink/read/${encodeURIComponent(sourceRef.messageId)}`;
    case "gitlab": {
      const origin = sourceOrigin(sourceRef.instanceId);
      if (!origin) return undefined;
      return `${origin}/${encodedPath(sourceRef.projectPath)}/-/${gitLabEntityPath(sourceRef.entityType)}/${String(sourceRef.iid)}`;
    }
    case "email": {
      const provider = sourceRef.provider.toLocaleLowerCase();
      if (provider.includes("outlook") || provider.includes("microsoft")) {
        return `https://outlook.office.com/mail/deeplink/read/${encodeURIComponent(sourceRef.messageId)}`;
      }
      if (provider.includes("gmail") || provider.includes("google")) {
        return `https://mail.google.com/mail/u/${encodeURIComponent(sourceRef.accountId)}/#all/${encodeURIComponent(sourceRef.messageId)}`;
      }
      return undefined;
    }
    case "messaging": {
      const provider = sourceRef.provider.toLocaleLowerCase();
      if (provider.includes("slack")) {
        return `https://app.slack.com/client/${encodeURIComponent(sourceRef.workspaceId)}/${encodeURIComponent(sourceRef.channelId)}/thread/${encodeURIComponent(sourceRef.channelId)}-${encodeURIComponent(sourceRef.messageId)}`;
      }
      if (provider.includes("discord")) {
        return `https://discord.com/channels/${encodeURIComponent(sourceRef.workspaceId)}/${encodeURIComponent(sourceRef.channelId)}/${encodeURIComponent(sourceRef.messageId)}`;
      }
      return undefined;
    }
    case "scm": {
      const origin = sourceOrigin(sourceRef.instanceId);
      if (!origin) return undefined;
      const repository = encodedPath(sourceRef.repository);
      const entityId = encodeURIComponent(sourceRef.entityId);
      const provider = sourceRef.provider.toLocaleLowerCase();
      if (provider.includes("gitlab")) {
        const entityType =
          sourceRef.entityType === "pull_request" ? "merge_request" : sourceRef.entityType;
        if (entityType === "commit") return `${origin}/${repository}/-/commit/${entityId}`;
        return `${origin}/${repository}/-/${gitLabEntityPath(entityType)}/${entityId}`;
      }
      if (provider.includes("github")) {
        const path = {
          pull_request: "pull",
          merge_request: "pull",
          issue: "issues",
          pipeline: "actions/runs",
          commit: "commit",
        }[sourceRef.entityType];
        return `${origin}/${repository}/${path}/${entityId}`;
      }
      if (provider.includes("bitbucket")) {
        const path = {
          pull_request: "pull-requests",
          merge_request: "pull-requests",
          issue: "issues",
          pipeline: "pipelines/results",
          commit: "commits",
        }[sourceRef.entityType];
        return `${origin}/${repository}/${path}/${entityId}`;
      }
      return undefined;
    }
    case "twg": {
      const origin = sourceOrigin(sourceRef.contextId);
      if (!origin) return undefined;
      if (sourceRef.resultType === "jira") {
        return `${origin}/browse/${encodeURIComponent(sourceRef.recordId)}`;
      }
      if (sourceRef.resultType === "confluence") {
        return `${origin}/wiki/pages/viewpage.action?pageId=${encodeURIComponent(sourceRef.recordId)}`;
      }
      return undefined;
    }
    case "codex":
    case "skill":
    case "manual":
      return undefined;
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
    doneRetentionHours: z.number().int().min(1).max(8_760).default(24),
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

export const DynaUserWorkflowStageSchema = z.enum(["todo", "needs_you", "done"]);
export type DynaUserWorkflowStage = z.infer<typeof DynaUserWorkflowStageSchema>;

export const DynaSetItemStatusInputSchema = z
  .object({
    viewToken: z.string().min(32).max(128),
    itemId: z.uuid(),
    targetStage: DynaUserWorkflowStageSchema,
    outcome: DynaOneLineOutcomeSchema.optional(),
    expectedRevision: z.number().int().nonnegative(),
    expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    clientRequestId: z.uuid(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.targetStage === "done" && !input.outcome) {
      context.addIssue({
        code: "custom",
        message: "Completing a Dyna item requires a precise one-line outcome.",
        path: ["outcome"],
      });
    }
    if (input.targetStage !== "done" && input.outcome) {
      context.addIssue({
        code: "custom",
        message: "Only a completed Dyna item can carry a completion outcome.",
        path: ["outcome"],
      });
    }
  });
export type DynaSetItemStatusInput = z.infer<typeof DynaSetItemStatusInputSchema>;

export const DynaUserWorkflowEventSchema = z
  .object({
    id: z.uuid(),
    itemId: z.uuid(),
    originDashboardId: z.uuid(),
    targetStage: DynaUserWorkflowStageSchema,
    outcome: DynaOneLineOutcomeSchema.optional(),
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (event.targetStage === "done" && !event.outcome) {
      context.addIssue({
        code: "custom",
        message: "A completed Dyna workflow event requires a precise one-line outcome.",
        path: ["outcome"],
      });
    }
    if (event.targetStage !== "done" && event.outcome) {
      context.addIssue({
        code: "custom",
        message: "Only a completed Dyna workflow event can carry an outcome.",
        path: ["outcome"],
      });
    }
  });
export type DynaUserWorkflowEvent = z.infer<typeof DynaUserWorkflowEventSchema>;

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

export const DynaCodexSessionCandidateSchema = z
  .object({
    taskId: IdentifierSchema,
    hostId: IdentifierSchema,
    projectId: IdentifierSchema.optional(),
    title: z.string().trim().min(1).max(200),
    updatedAt: TimestampSchema,
  })
  .strict();
export type DynaCodexSessionCandidate = z.infer<typeof DynaCodexSessionCandidateSchema>;

export const DynaCodexSessionCandidatesSchema = z
  .array(DynaCodexSessionCandidateSchema)
  .max(50)
  .superRefine((candidates, context) => {
    const identities = new Set<string>();
    for (const [index, candidate] of candidates.entries()) {
      const identity = `${candidate.hostId}\u0000${candidate.taskId}`;
      if (identities.has(identity)) {
        context.addIssue({
          code: "custom",
          message: "A Codex session candidate list cannot contain duplicate task identities.",
          path: [index],
        });
      }
      identities.add(identity);
    }
  });

export const DynaArtifactKindSchema = z.enum([
  "merge_request",
  "pull_request",
  "issue",
  "pipeline",
  "commit",
  "document",
  "report",
  "other",
]);
export type DynaArtifactKind = z.infer<typeof DynaArtifactKindSchema>;

export const DynaArtifactRefSchema = z
  .object({
    kind: DynaArtifactKindSchema,
    label: z.string().trim().min(1).max(160),
    url: z
      .url()
      .max(2_048)
      .refine(
        (value) =>
          (value.startsWith("https://") || value.startsWith("http://")) &&
          sourceOrigin(value) !== undefined,
        {
          message: "A Dyna artifact must use an HTTP or HTTPS URL without embedded credentials.",
        },
      ),
  })
  .strict();
export type DynaArtifactRef = z.infer<typeof DynaArtifactRefSchema>;

export const DynaWorkUpdateKindSchema = z.enum([
  "note",
  "progress",
  "decision",
  "needs_input",
  "blocked",
  "completion_reported",
  "handoff",
]);
export type DynaWorkUpdateKind = z.infer<typeof DynaWorkUpdateKindSchema>;

export const DynaWorkStateSchema = z.enum([
  "progress",
  "needs_input",
  "blocked",
  "completion_reported",
  "handoff",
]);
export type DynaWorkState = z.infer<typeof DynaWorkStateSchema>;

export const DynaWorkTaskAttributionSchema = z
  .object({
    taskId: IdentifierSchema,
    hostId: IdentifierSchema,
  })
  .strict();
export type DynaWorkTaskAttribution = z.infer<typeof DynaWorkTaskAttributionSchema>;

export const DynaWorkUpdateInputSchema = z
  .object({
    requestId: z.uuid(),
    workAttemptId: z.uuid(),
    kind: DynaWorkUpdateKindSchema,
    body: z.string().trim().min(1).max(1_000),
    outcome: DynaOneLineOutcomeSchema.optional(),
    artifacts: z.array(DynaArtifactRefSchema).max(4).default([]),
    task: DynaWorkTaskAttributionSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      ["progress", "needs_input", "blocked", "completion_reported", "handoff"].includes(
        input.kind,
      ) &&
      !input.task
    ) {
      context.addIssue({
        code: "custom",
        message: "A lifecycle work update requires a controller-verified linked task.",
        path: ["task"],
      });
    }
    if (input.kind === "completion_reported" && !input.outcome) {
      context.addIssue({
        code: "custom",
        message: "A completion report requires a precise one-line outcome.",
        path: ["outcome"],
      });
    }
    if (input.kind !== "completion_reported" && input.outcome) {
      context.addIssue({
        code: "custom",
        message: "Only a completion report can carry an outcome.",
        path: ["outcome"],
      });
    }
  });
export type DynaWorkUpdateInput = z.infer<typeof DynaWorkUpdateInputSchema>;

export const DynaWorkUpdateSchema = z
  .object({
    schema: z.literal("dyna/work-update-v1"),
    id: z.uuid(),
    itemId: z.uuid(),
    originDashboardId: z.uuid(),
    workAttemptId: z.uuid(),
    kind: DynaWorkUpdateKindSchema,
    body: z.string().trim().min(1).max(1_000),
    outcome: DynaOneLineOutcomeSchema.optional(),
    artifacts: z.array(DynaArtifactRefSchema).max(4),
    task: DynaWorkTaskAttributionSchema.extend({
      title: z.string().trim().min(1).max(200).optional(),
    })
      .strict()
      .optional(),
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((update, context) => {
    if (update.kind === "completion_reported" && !update.outcome) {
      context.addIssue({
        code: "custom",
        message: "A completion report requires a precise one-line outcome.",
        path: ["outcome"],
      });
    }
    if (update.kind !== "completion_reported" && update.outcome) {
      context.addIssue({
        code: "custom",
        message: "Only a completion report can carry an outcome.",
        path: ["outcome"],
      });
    }
  });
export type DynaWorkUpdate = z.infer<typeof DynaWorkUpdateSchema>;

export const DynaWorkReferenceSchema = z
  .object({
    schema: z.literal("dyna/work-item-v1"),
    dashboardId: z.uuid(),
    dashboardName: z.string().trim().min(1).max(96),
    itemId: z.uuid(),
    expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    sourceUpdatedAt: TimestampSchema,
    copiedAt: TimestampSchema,
    workAttemptId: z.uuid(),
    linkedTasks: z.array(DynaTaskStatusSchema).max(8),
  })
  .strict();
export type DynaWorkReference = z.infer<typeof DynaWorkReferenceSchema>;

const DynaHistoryCursorSchema = z.string().trim().min(1).max(512);

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
  workUpdates: z.array(DynaWorkUpdateSchema).max(20),
  workUpdateCount: z.number().int().nonnegative(),
  linkedTasks: z.array(DynaTaskStatusSchema).max(8),
}).strict();
export type DynaItemContext = z.infer<typeof DynaItemContextSchema>;

export const DynaArchiveReasonSchema = z.enum([
  "completed",
  "invalid",
  "duplicate",
  "no_action_needed",
  "superseded",
  "other",
]);
export type DynaArchiveReason = z.infer<typeof DynaArchiveReasonSchema>;

export const DynaArchiveStateSchema = z
  .object({
    id: z.uuid(),
    reason: DynaArchiveReasonSchema,
    reasonDetail: z.string().trim().min(1).max(500).optional(),
    mode: z.enum(["manual", "automatic"]),
    archivedAt: TimestampSchema,
    completedAt: TimestampSchema.optional(),
    workflowStateAtArchive: z.enum(["todo", "executing", "paused", "attention", "completed"]),
    wasCompleted: z.boolean(),
    changedSinceArchive: z.boolean(),
  })
  .strict();
export type DynaArchiveState = z.infer<typeof DynaArchiveStateSchema>;

export const DynaItemHistorySchema = z
  .object({
    itemId: z.uuid(),
    archives: z
      .array(
        DynaArchiveStateSchema.extend({
          restoredAt: TimestampSchema.optional(),
          priorityAtArchive: DynaPrioritySchema,
          sequenceAtArchive: z.number().int().nonnegative().optional(),
          outcomeAtArchive: z.string().trim().min(1).max(200).optional(),
        }).strict(),
      )
      .max(50),
    organization: z
      .array(
        z
          .object({
            action: z.enum(["bump", "lower", "earlier", "later", "resequence"]),
            priority: DynaPrioritySchema,
            sequence: z.number().int().nonnegative().optional(),
            createdAt: TimestampSchema,
          })
          .strict(),
      )
      .max(50),
    statusChanges: z.array(DynaUserWorkflowEventSchema).max(50),
    workUpdates: z.array(DynaWorkUpdateSchema).max(50),
    archiveEventsNextCursor: DynaHistoryCursorSchema.optional(),
    orderHistoryNextCursor: DynaHistoryCursorSchema.optional(),
    statusHistoryNextCursor: DynaHistoryCursorSchema.optional(),
    workUpdatesNextCursor: DynaHistoryCursorSchema.optional(),
  })
  .strict();
export type DynaItemHistory = z.infer<typeof DynaItemHistorySchema>;

export const DynaWorkActivityPageSchema = z
  .object({
    itemId: z.uuid(),
    updates: z.array(DynaWorkUpdateSchema).max(25),
    nextCursor: DynaHistoryCursorSchema.optional(),
    total: z.number().int().nonnegative(),
  })
  .strict();
export type DynaWorkActivityPage = z.infer<typeof DynaWorkActivityPageSchema>;

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
  "list_codex_sessions",
  "attach_codex_task",
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
    dashboardId: z.uuid(),
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
    completedAt: TimestampSchema.optional(),
    outcome: z.string().trim().min(1).max(200).optional(),
    followUpOfItemId: z.uuid().optional(),
    attention: z.string().trim().min(1).max(500).optional(),
    plan: z.array(z.string().trim().min(1).max(200)).max(4),
    nextSteps: z.array(DynaNextStepSchema).max(4),
    enrichmentState: z.enum(["active", "stale"]).optional(),
    annotations: z.array(DynaAnnotationSchema).max(20),
    workUpdates: z.array(DynaWorkUpdateSchema).max(1).default([]),
    workUpdateCount: z.number().int().nonnegative().default(0),
    workState: DynaWorkStateSchema.optional(),
    workConditionSummary: z.string().trim().min(1).max(200).optional(),
    workConditionTask: DynaWorkTaskAttributionSchema.optional(),
    matchedActivity: z.string().trim().min(1).max(500).optional(),
    blocked: z.boolean().default(false),
    linkedTasks: z.array(DynaTaskStatusSchema).max(8),
    archive: DynaArchiveStateSchema.optional(),
  })
  .strict();
export type DynaCard = z.infer<typeof DynaCardSchema>;

export const DynaDashboardSnapshotSchema = z
  .object({
    schema: z.literal("dyna/snapshot-v5"),
    dashboard: DynaDashboardSchema,
    generatedAt: TimestampSchema,
    query: z.string().max(500),
    scope: z.enum(["active", "archive"]).default("active"),
    revision: z.number().int().nonnegative(),
    freshness: z.enum(["fresh", "aging", "stale"]),
    counts: z
      .object({
        critical: z.number().int().nonnegative(),
        high: z.number().int().nonnegative(),
        leadership: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        archived: z.number().int().nonnegative().default(0),
        blocked: z.number().int().nonnegative().default(0),
      })
      .strict(),
    schedules: z.array(DynaPublisherSchema).max(50),
    cards: z.array(DynaCardSchema).max(200),
  })
  .strict();
export type DynaDashboardSnapshot = z.infer<typeof DynaDashboardSnapshotSchema>;

export const DynaUiPayloadSchema = z
  .object({
    schema: z.literal("dyna/ui-v7"),
    viewToken: z.string().min(32).max(128),
    snapshot: DynaDashboardSnapshotSchema,
  })
  .strict();
export type DynaUiPayload = z.infer<typeof DynaUiPayloadSchema>;

export const DynaItemShowResultSchema = z
  .object({
    schema: z.literal("dyna/item-show-result-v1"),
    dashboard: DynaDashboardSchema,
    revision: z.number().int().nonnegative(),
    enrichmentVersion: z.number().int().nonnegative(),
    item: DynaCardSchema,
  })
  .strict();
export type DynaItemShowResult = z.infer<typeof DynaItemShowResultSchema>;

const DynaMutationResultBaseSchema = z.object({
  requestId: z.uuid(),
  itemId: z.uuid(),
  deduplicated: z.boolean(),
});

export const DynaItemUpdateResultSchema = DynaMutationResultBaseSchema.extend({
  schema: z.literal("dyna/item-update-result-v1"),
  workUpdateId: z.uuid(),
}).strict();
export type DynaItemUpdateResult = z.infer<typeof DynaItemUpdateResultSchema>;

export const DynaItemEnrichResultSchema = DynaMutationResultBaseSchema.extend({
  schema: z.literal("dyna/item-enrich-result-v1"),
  enrichmentVersion: z.number().int().positive(),
}).strict();
export type DynaItemEnrichResult = z.infer<typeof DynaItemEnrichResultSchema>;

export const DynaItemPlaceResultSchema = DynaMutationResultBaseSchema.extend({
  schema: z.literal("dyna/item-place-result-v1"),
  changed: z.boolean(),
}).strict();
export type DynaItemPlaceResult = z.infer<typeof DynaItemPlaceResultSchema>;

export const DynaItemStatusResultSchema = DynaMutationResultBaseSchema.extend({
  schema: z.literal("dyna/item-status-result-v1"),
  targetStage: DynaUserWorkflowStageSchema,
  changed: z.boolean(),
  changedAt: TimestampSchema.optional(),
}).strict();
export type DynaItemStatusResult = z.infer<typeof DynaItemStatusResultSchema>;

export const DynaItemArchiveResultSchema = DynaMutationResultBaseSchema.extend({
  schema: z.literal("dyna/item-archive-result-v1"),
  archiveId: z.uuid(),
  archivedAt: TimestampSchema,
  reason: DynaArchiveReasonSchema,
}).strict();
export type DynaItemArchiveResult = z.infer<typeof DynaItemArchiveResultSchema>;

export const DynaItemRestoreResultSchema = DynaMutationResultBaseSchema.extend({
  schema: z.literal("dyna/item-restore-result-v1"),
  restoredAt: TimestampSchema,
}).strict();
export type DynaItemRestoreResult = z.infer<typeof DynaItemRestoreResultSchema>;

export const DynaFollowUpCreateResultSchema = DynaMutationResultBaseSchema.extend({
  schema: z.literal("dyna/follow-up-create-result-v1"),
  sourceItemId: z.uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type DynaFollowUpCreateResult = z.infer<typeof DynaFollowUpCreateResultSchema>;

export const DynaCliHelpResultSchema = z
  .object({
    schema: z.literal("dyna/help-v1"),
    commands: z
      .array(
        z
          .object({
            command: z.string().trim().min(1).max(160),
            readsStdin: z.boolean(),
            description: z.string().trim().min(1).max(200),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict();
export type DynaCliHelpResult = z.infer<typeof DynaCliHelpResultSchema>;

export const DynaCliVersionResultSchema = z
  .object({
    schema: z.literal("dyna/version-v1"),
    version: z.string().trim().min(1).max(32),
    nodeVersion: z.string().trim().min(1).max(32),
    minimumNodeVersion: z.string().trim().min(1).max(32),
  })
  .strict();
export type DynaCliVersionResult = z.infer<typeof DynaCliVersionResultSchema>;

export const DynaCliSetupResultSchema = z
  .object({
    schema: z.literal("dyna/setup-v1"),
    ready: z.literal(true),
    store: z.literal("available"),
    credentialBoundary: z.literal("local-user"),
  })
  .strict();
export type DynaCliSetupResult = z.infer<typeof DynaCliSetupResultSchema>;

export const DynaCliErrorCodeSchema = z.enum([
  "invalid_input",
  "not_found",
  "outside_dashboard",
  "stale_item",
  "stale_dashboard",
  "stale_enrichment",
  "archived_item",
  "completed_item",
  "request_conflict",
  "task_not_linked",
  "busy",
  "unavailable",
  "unsupported_runtime",
  "internal",
]);
export type DynaCliErrorCode = z.infer<typeof DynaCliErrorCodeSchema>;

export const DynaCliErrorSchema = z
  .object({
    schema: z.literal("dyna/error-v1"),
    code: DynaCliErrorCodeSchema,
    message: z.string().trim().min(1).max(300),
  })
  .strict();

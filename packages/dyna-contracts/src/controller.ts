import { z } from "zod";

import {
  DynaArtifactRefSchema,
  DynaItemNumberSchema,
  DynaTaskStatusSchema,
  DynaTaskSyncSummarySchema,
  DynaTaskTitleSchema,
} from "@flowzone/dyna-contracts";

const IdentifierSchema = z.string().trim().min(1).max(512);
const TimestampSchema = z.iso.datetime({ offset: true });
const DynaOneLineOutcomeSchema = z.string().trim().min(1).max(240);

export const DynaTaskSyncTargetSchema = z
  .object({
    itemId: z.uuid(),
    itemNumber: DynaItemNumberSchema,
    taskId: IdentifierSchema,
    hostId: IdentifierSchema,
    checkpointVersion: z.number().int().nonnegative(),
    afterCursor: z.string().trim().min(1).max(2_048).optional(),
    lastTurnId: IdentifierSchema.optional(),
    expectedTitle: DynaTaskTitleSchema,
  })
  .strict();
export type DynaTaskSyncTarget = z.infer<typeof DynaTaskSyncTargetSchema>;

export const DynaTaskSyncClaimSchema = z
  .object({
    schema: z.literal("dyna/task-sync-claim-v1"),
    runId: z.uuid(),
    dashboardId: z.uuid(),
    claimToken: z.string().min(32).max(128),
    leaseExpiresAt: TimestampSchema,
    totalTasks: z.number().int().min(0).max(200),
    remainingTasks: z.number().int().nonnegative(),
    targets: z.array(DynaTaskSyncTargetSchema).max(200),
  })
  .strict();
export type DynaTaskSyncClaim = z.infer<typeof DynaTaskSyncClaimSchema>;

export const DynaTaskSyncDeltaSchema = z
  .object({
    kind: z.enum(["progress", "needs_input", "blocked", "completion_reported"]),
    body: z.string().trim().min(1).max(1_000),
    outcome: DynaOneLineOutcomeSchema.optional(),
    artifacts: z.array(DynaArtifactRefSchema).max(4).default([]),
  })
  .strict()
  .superRefine((delta, context) => {
    if (delta.kind === "completion_reported" && !delta.outcome) {
      context.addIssue({
        code: "custom",
        message: "A synchronized completion report requires a one-line outcome.",
        path: ["outcome"],
      });
    }
    if (delta.kind !== "completion_reported" && delta.outcome) {
      context.addIssue({
        code: "custom",
        message: "Only a synchronized completion report can include an outcome.",
        path: ["outcome"],
      });
    }
  });
export type DynaTaskSyncDelta = z.infer<typeof DynaTaskSyncDeltaSchema>;

export const DynaTaskSyncObservationSchema = z
  .object({
    taskId: IdentifierSchema,
    checkpointVersion: z.number().int().nonnegative(),
    task: DynaTaskStatusSchema,
    summaryCoverage: z.enum(["available", "unavailable"]),
    nextCursor: z.string().trim().min(1).max(2_048).optional(),
    lastTurnId: IdentifierSchema.optional(),
    delta: DynaTaskSyncDeltaSchema.optional(),
  })
  .strict()
  .superRefine((observation, context) => {
    if (observation.task.taskId !== observation.taskId) {
      context.addIssue({
        code: "custom",
        message: "A synchronized task identity must match its native observation.",
        path: ["task", "taskId"],
      });
    }
    if (observation.summaryCoverage === "unavailable" && observation.delta) {
      context.addIssue({
        code: "custom",
        message: "A status-only task observation cannot include a compact work delta.",
        path: ["delta"],
      });
    }
  });
export type DynaTaskSyncObservation = z.infer<typeof DynaTaskSyncObservationSchema>;

export const DynaTaskSyncUnavailableSchema = z
  .object({
    taskId: IdentifierSchema,
    hostId: IdentifierSchema,
    checkpointVersion: z.number().int().nonnegative(),
    reason: z.enum([
      "not_found",
      "host_unavailable",
      "status_unavailable",
      "cursor_invalid",
      "read_failed",
    ]),
  })
  .strict();
export type DynaTaskSyncUnavailable = z.infer<typeof DynaTaskSyncUnavailableSchema>;

export const DynaTaskSyncBatchInputSchema = z
  .object({
    requestId: z.uuid(),
    observations: z.array(DynaTaskSyncObservationSchema).max(8),
    unavailable: z.array(DynaTaskSyncUnavailableSchema).max(8),
  })
  .strict()
  .superRefine((input, context) => {
    const identities = [...input.observations, ...input.unavailable].map((entry) => entry.taskId);
    if (identities.length < 1 || identities.length > 8) {
      context.addIssue({
        code: "custom",
        message: "A task synchronization batch must contain between one and eight tasks.",
        path: ["observations"],
      });
    }
    if (new Set(identities).size !== identities.length) {
      context.addIssue({
        code: "custom",
        message: "A task synchronization batch cannot repeat a task.",
        path: ["observations"],
      });
    }
  });
export type DynaTaskSyncBatchInput = z.infer<typeof DynaTaskSyncBatchInputSchema>;

export const DynaTaskSyncBatchResultSchema = z
  .object({
    schema: z.literal("dyna/task-sync-batch-result-v1"),
    acceptedTasks: z.number().int().min(0).max(8),
    deduplicated: z.boolean(),
    leaseExpiresAt: TimestampSchema,
    summary: DynaTaskSyncSummarySchema,
  })
  .strict();
export type DynaTaskSyncBatchResult = z.infer<typeof DynaTaskSyncBatchResultSchema>;

export const DynaTaskSyncCompleteInputSchema = z.object({ requestId: z.uuid() }).strict();
export type DynaTaskSyncCompleteInput = z.infer<typeof DynaTaskSyncCompleteInputSchema>;

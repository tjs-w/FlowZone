import {
  DynaActionItemContextSchema,
  DynaActionKindSchema,
  DynaActionRequestSchema,
  DynaActionStateSchema,
  DynaArchiveReasonSchema,
  DynaArchiveStateSchema,
  DynaCredentialModeSchema,
  DynaDashboardSchema,
  DynaItemContextSchema,
  DynaItemHistorySchema,
  DynaNextStepSchema,
  DynaPersonSignalSchema,
  DynaPrioritySchema,
  DynaPublishSourceSlicesSchema,
  DynaPublisherSchema,
  DynaRequiredSourceSlicesSchema,
  DynaScheduledPublishedItemSchema,
  DynaSourceRefSchema,
  DynaTaskStatusSchema,
  DynaTodoInputSchema,
  DynaUiPayloadSchema,
} from "@flowzone/dyna-contracts";
import { DynaService } from "@flowzone/dyna-node";
import { z } from "zod";

import type { FlowZoneAppTool, FlowZonePlugin } from "../plugin.js";

export const DYNA_PLUGIN_ID = "dyna";
export const DYNA_TEMPLATE_URI = "ui://flowzone/dyna/v9.html";

const DashboardIdSchema = z.object({ dashboardId: z.uuid() }).strict();
const ViewTokenSchema = z
  .object({
    viewToken: z.string().min(32).max(128),
    currentRevision: z.number().int().nonnegative().optional(),
    query: z.string().trim().max(500).optional(),
    scope: z.enum(["active", "archive"]).default("active"),
  })
  .strict();
const AddAnnotationInputSchema = z
  .object({
    viewToken: z.string().min(32).max(128),
    itemId: z.uuid(),
    clientRequestId: z.uuid(),
    body: z.string().trim().min(1).max(1_000),
  })
  .strict();
const OrganizeItemInputSchema = z
  .object({
    viewToken: z.string().min(32).max(128),
    itemId: z.uuid(),
    action: z.enum(["bump", "lower", "earlier", "later", "place"]),
    targetPriority: DynaPrioritySchema.optional(),
    beforeItemId: z.uuid().optional(),
    expectedRevision: z.number().int().nonnegative(),
    expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.action === "place" && !input.targetPriority) {
      context.addIssue({
        code: "custom",
        path: ["targetPriority"],
        message: "Drag placement requires a target priority.",
      });
    }
    if (input.action !== "place" && (input.targetPriority || input.beforeItemId)) {
      context.addIssue({
        code: "custom",
        path: ["action"],
        message: "Target placement is only accepted for drag placement.",
      });
    }
  });
const EmptyResultSchema = z.object({ ok: z.literal(true) }).strict();
const DashboardListSchema = z
  .object({ dashboards: z.array(DynaDashboardSchema).max(100) })
  .strict();
const IdentifierSchema = z.string().trim().min(1).max(256);
const ScheduleSchema = z
  .object({
    scheduleId: IdentifierSchema,
    scheduleTitle: z.string().trim().min(1).max(200),
    scheduleState: z.enum(["active", "paused", "unknown"]),
    staleAfterMinutes: z.number().int().min(5).max(43_200).default(1_440),
  })
  .strict();
const SearchItemSchema = z
  .object({
    itemId: z.uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(1_000),
    sourceRef: DynaSourceRefSchema,
    priority: DynaPrioritySchema,
    priorityReason: z.string().trim().min(1).max(500),
    sourceUpdatedAt: z.iso.datetime({ offset: true }),
    dueAt: z.iso.datetime({ offset: true }).optional(),
    workflowState: z.enum(["todo", "executing", "paused", "attention", "completed"]),
    attention: z.string().trim().min(1).max(500).optional(),
    plan: z.array(z.string().trim().min(1).max(200)).max(4),
    nextSteps: z.array(DynaNextStepSchema).max(4),
    outcome: z.string().trim().min(1).max(200).optional(),
    linkedTasks: z.array(DynaTaskStatusSchema).max(8),
    archive: DynaArchiveStateSchema.optional(),
  })
  .strict();
const PublisherCreationResultSchema = z.discriminatedUnion("credentialHandling", [
  z
    .object({
      publisher: DynaPublisherSchema,
      credentialHandling: z.literal("disabled-no-publication"),
    })
    .strict(),
  z
    .object({
      publisher: DynaPublisherSchema,
      credentialHandling: z.literal("local-cli-user-boundary"),
    })
    .strict(),
  z
    .object({
      publisher: DynaPublisherSchema,
      secret: z.string().min(32).max(128),
      credentialHandling: z.literal("model-visible-trusted-local-preview-only"),
    })
    .strict(),
]);

const CompletionInputSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      requestId: z.uuid(),
      claimToken: z.string().min(32).max(128),
      outcome: z.literal("succeeded"),
      task: DynaTaskStatusSchema.optional(),
    })
    .strict(),
  z
    .object({
      requestId: z.uuid(),
      claimToken: z.string().min(32).max(128),
      outcome: z.enum(["failed", "needs_reconciliation"]),
      failureMessage: z.string().trim().min(1).max(500),
    })
    .strict(),
]);
const ReconciliationInputSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      requestId: z.uuid(),
      outcome: z.literal("task_linked"),
      task: DynaTaskStatusSchema,
    })
    .strict(),
  z
    .object({
      requestId: z.uuid(),
      outcome: z.literal("no_task_created"),
      explanation: z.string().trim().min(1).max(500),
    })
    .strict(),
]);

export interface DynaPluginOptions {
  readonly service?: DynaService;
}

function appTools(service: DynaService): readonly FlowZoneAppTool[] {
  return [
    {
      name: "dyna_get_snapshot",
      title: "Refresh Dyna dashboard",
      description: "Return the newest compiled snapshot for the capability-bound Dyna view.",
      inputSchema: ViewTokenSchema,
      outputSchema: z
        .object({ revision: z.number().int().nonnegative(), changed: z.boolean() })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      handler(input) {
        const { viewToken, currentRevision, query, scope } = ViewTokenSchema.parse(input);
        const payload = service.refresh(viewToken, query, scope);
        const changed = currentRevision !== payload.snapshot.revision;
        return {
          structuredContent: { revision: payload.snapshot.revision, changed },
          content: [],
          _meta: { dynaDashboard: payload },
        };
      },
    },
    {
      name: "dyna_archive_item",
      title: "Archive Dyna item",
      description: "Retry-safely archive an item in this dashboard with an explicit disposition.",
      inputSchema: z
        .object({
          viewToken: z.string().min(32).max(128),
          itemId: z.uuid(),
          reason: DynaArchiveReasonSchema,
          reasonDetail: z.string().trim().min(1).max(500).optional(),
          expectedRevision: z.number().int().nonnegative(),
          expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          clientRequestId: z.uuid(),
        })
        .strict(),
      outputSchema: z
        .object({
          archiveId: z.uuid(),
          itemId: z.uuid(),
          archivedAt: z.iso.datetime({ offset: true }),
          reason: DynaArchiveReasonSchema,
          mode: z.literal("manual"),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      handler(input) {
        const parsed = z
          .object({
            viewToken: z.string().min(32).max(128),
            itemId: z.uuid(),
            reason: DynaArchiveReasonSchema,
            reasonDetail: z.string().trim().min(1).max(500).optional(),
            expectedRevision: z.number().int().nonnegative(),
            expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            clientRequestId: z.uuid(),
          })
          .strict()
          .parse(input);
        const result = service.store.archiveItem(parsed.viewToken, parsed.itemId, {
          reason: parsed.reason,
          ...(parsed.reasonDetail ? { reasonDetail: parsed.reasonDetail } : {}),
          expectedRevision: parsed.expectedRevision,
          expectedFingerprint: parsed.expectedFingerprint,
          clientRequestId: parsed.clientRequestId,
        });
        return {
          structuredContent: { ...result },
          content: [],
        };
      },
    },
    {
      name: "dyna_restore_item",
      title: "Restore Dyna item",
      description: "Retry-safely restore one archived item to its current active lifecycle stage.",
      inputSchema: z
        .object({
          viewToken: z.string().min(32).max(128),
          itemId: z.uuid(),
          expectedRevision: z.number().int().nonnegative(),
          expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          clientRequestId: z.uuid(),
        })
        .strict(),
      outputSchema: z
        .object({ itemId: z.uuid(), restoredAt: z.iso.datetime({ offset: true }) })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      handler(input) {
        const parsed = z
          .object({
            viewToken: z.string().min(32).max(128),
            itemId: z.uuid(),
            expectedRevision: z.number().int().nonnegative(),
            expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            clientRequestId: z.uuid(),
          })
          .strict()
          .parse(input);
        return {
          structuredContent: service.store.restoreItem(parsed.viewToken, parsed.itemId, parsed),
          content: [],
        };
      },
    },
    {
      name: "dyna_add_annotation",
      title: "Add Dyna annotation",
      description: "Retry-safely add a bounded note to an item in the capability-bound Dyna view.",
      inputSchema: AddAnnotationInputSchema,
      outputSchema: z.object({ annotationId: z.uuid() }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      handler(input) {
        const parsed = AddAnnotationInputSchema.parse(input);
        const annotation = service.store.addAnnotation(
          parsed.viewToken,
          parsed.itemId,
          parsed.clientRequestId,
          parsed.body,
        );
        return { structuredContent: { annotationId: annotation.id }, content: [] };
      },
    },
    {
      name: "dyna_add_todo",
      title: "Add Dyna to-do",
      description: "Add a manual to-do to the priority queue in this capability-bound view.",
      inputSchema: z
        .object({
          viewToken: z.string().min(32).max(128),
          clientRequestId: z.uuid(),
        })
        .extend(DynaTodoInputSchema.shape)
        .strict(),
      outputSchema: z.object({ itemId: z.uuid() }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      handler(input) {
        const parsed = z
          .object({
            viewToken: z.string().min(32).max(128),
            clientRequestId: z.uuid(),
          })
          .extend(DynaTodoInputSchema.shape)
          .strict()
          .parse(input);
        const itemId = service.store.addTodo(
          parsed.viewToken,
          {
            title: parsed.title,
            ...(parsed.summary ? { summary: parsed.summary } : {}),
            priority: parsed.priority,
            ...(parsed.attention ? { attention: parsed.attention } : {}),
            labels: parsed.labels,
            ...(parsed.followUpOfItemId ? { followUpOfItemId: parsed.followUpOfItemId } : {}),
          },
          parsed.clientRequestId,
        );
        return { structuredContent: { itemId }, content: [] };
      },
    },
    {
      name: "dyna_organize_item",
      title: "Reprioritize Dyna item",
      description:
        "Apply a user-controlled priority, sequence, or direct queue placement with revision and fingerprint preconditions.",
      inputSchema: OrganizeItemInputSchema,
      outputSchema: z.object({ changed: z.boolean() }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
      handler(input) {
        const parsed = OrganizeItemInputSchema.parse(input);
        const result =
          parsed.action === "place" && parsed.targetPriority
            ? service.store.placeItem(
                parsed.viewToken,
                parsed.itemId,
                parsed.targetPriority,
                parsed.beforeItemId,
                parsed.expectedRevision,
                parsed.expectedFingerprint,
              )
            : service.store.organizeItem(
                parsed.viewToken,
                parsed.itemId,
                parsed.action as "bump" | "lower" | "earlier" | "later",
                parsed.expectedRevision,
                parsed.expectedFingerprint,
              );
        return { structuredContent: result, content: [] };
      },
    },
    {
      name: "dyna_prepare_action",
      title: "Prepare Dyna action",
      description:
        "Prepare a short-lived, capability-bound request for the current Codex task to handle.",
      inputSchema: z
        .object({
          viewToken: z.string().min(32).max(128),
          itemId: z.uuid(),
          taskId: IdentifierSchema.optional(),
          taskHostId: IdentifierSchema.optional(),
          kind: DynaActionKindSchema,
          expectedRevision: z.number().int().nonnegative(),
          expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          idempotencyKey: z.string().trim().min(1).max(1_024),
        })
        .strict(),
      outputSchema: z
        .object({ requestId: z.uuid(), expiresAt: z.iso.datetime({ offset: true }) })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
      handler(input) {
        const parsed = z
          .object({
            viewToken: z.string().min(32).max(128),
            itemId: z.uuid(),
            taskId: IdentifierSchema.optional(),
            taskHostId: IdentifierSchema.optional(),
            kind: DynaActionKindSchema,
            expectedRevision: z.number().int().nonnegative(),
            expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            idempotencyKey: z.string().trim().min(1).max(1_024),
          })
          .strict()
          .parse(input);
        const request = service.store.prepareAction(parsed.viewToken, parsed.kind, {
          itemId: parsed.itemId,
          ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
          ...(parsed.taskHostId ? { taskHostId: parsed.taskHostId } : {}),
          expectedRevision: parsed.expectedRevision,
          expectedFingerprint: parsed.expectedFingerprint,
          idempotencyKey: parsed.idempotencyKey,
        });
        return {
          structuredContent: { requestId: request.id, expiresAt: request.expiresAt },
          content: [],
        };
      },
    },
    {
      name: "dyna_mark_action_delivered",
      title: "Mark Dyna action delivered",
      description: "Atomically mark a prepared Dyna request ready for one Codex claim.",
      inputSchema: z
        .object({ viewToken: z.string().min(32).max(128), requestId: z.uuid() })
        .strict(),
      outputSchema: z.object({ state: DynaActionStateSchema }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
      handler(input) {
        const parsed = z
          .object({ viewToken: z.string().min(32).max(128), requestId: z.uuid() })
          .strict()
          .parse(input);
        const request = service.store.markDelivered(parsed.viewToken, parsed.requestId);
        return { structuredContent: { state: request.state }, content: [] };
      },
    },
    {
      name: "dyna_action_status",
      title: "Read Dyna action status",
      description:
        "Read status metadata for a Dyna request without exposing its completion capability.",
      inputSchema: z
        .object({ viewToken: z.string().min(32).max(128), requestId: z.uuid() })
        .strict(),
      outputSchema: DynaActionRequestSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      handler(input) {
        const { viewToken, requestId } = z
          .object({ viewToken: z.string().min(32).max(128), requestId: z.uuid() })
          .strict()
          .parse(input);
        const request = service.store.actionStatusForView(viewToken, requestId);
        return { structuredContent: request, content: [] };
      },
    },
  ];
}

export function createDynaPlugin(options: DynaPluginOptions = {}): FlowZonePlugin {
  const service = options.service ?? new DynaService();
  return {
    id: DYNA_PLUGIN_ID,
    displayName: "Dyna",
    version: "0.1.0",
    actions: [
      {
        id: "create-dashboard",
        title: "Create Dyna dashboard",
        description:
          "Create one persistent executive dashboard that can receive multiple scheduled publishers.",
        inputSchema: z
          .object({
            name: z.string().trim().min(1).max(96),
            description: z.string().trim().max(500).default(""),
            doneRetentionHours: z.number().int().min(1).max(8_760).default(24),
          })
          .strict(),
        outputSchema: DynaDashboardSchema,
        risk: { readOnly: false, destructive: false, openWorld: false, idempotent: false },
        executor: {
          kind: "module",
          execute(input) {
            const parsed = z
              .object({
                name: z.string().trim().min(1).max(96),
                description: z.string().trim().max(500).default(""),
                doneRetentionHours: z.number().int().min(1).max(8_760).default(24),
              })
              .strict()
              .parse(input);
            const dashboard = service.store.createDashboard(
              parsed.name,
              parsed.description,
              parsed.doneRetentionHours,
            );
            return { result: dashboard };
          },
        },
      },
      {
        id: "update-dashboard",
        title: "Update Dyna dashboard",
        description: "Rename, describe, archive, or restore a Dyna dashboard.",
        inputSchema: z
          .object({
            dashboardId: z.uuid(),
            name: z.string().trim().min(1).max(96).optional(),
            description: z.string().trim().max(500).optional(),
            archived: z.boolean().optional(),
            doneRetentionHours: z.number().int().min(1).max(8_760).optional(),
          })
          .strict(),
        outputSchema: DynaDashboardSchema,
        risk: { readOnly: false, destructive: true, openWorld: false, idempotent: true },
        executor: {
          kind: "module",
          execute(input) {
            const parsed = z
              .object({
                dashboardId: z.uuid(),
                name: z.string().trim().min(1).max(96).optional(),
                description: z.string().trim().max(500).optional(),
                archived: z.boolean().optional(),
                doneRetentionHours: z.number().int().min(1).max(8_760).optional(),
              })
              .strict()
              .parse(input);
            const dashboard = service.store.updateDashboard(parsed.dashboardId, {
              ...(parsed.name !== undefined ? { name: parsed.name } : {}),
              ...(parsed.description !== undefined ? { description: parsed.description } : {}),
              ...(parsed.archived !== undefined ? { archived: parsed.archived } : {}),
              ...(parsed.doneRetentionHours !== undefined
                ? { doneRetentionHours: parsed.doneRetentionHours }
                : {}),
            });
            return { result: dashboard };
          },
        },
      },
      {
        id: "purge-dashboard",
        title: "Purge Dyna dashboard",
        description:
          "Permanently delete one dashboard and its dashboard-local data after exact ID confirmation.",
        inputSchema: z.object({ dashboardId: z.uuid(), confirmDashboardId: z.uuid() }).strict(),
        outputSchema: EmptyResultSchema,
        risk: { readOnly: false, destructive: true, openWorld: false, idempotent: true },
        executor: {
          kind: "module",
          execute(input) {
            const parsed = z
              .object({ dashboardId: z.uuid(), confirmDashboardId: z.uuid() })
              .strict()
              .parse(input);
            service.store.purgeDashboard(parsed.dashboardId, parsed.confirmDashboardId);
            return { result: { ok: true as const } };
          },
        },
      },
      {
        id: "list-dashboards",
        title: "List Dyna dashboards",
        description: "List persistent Dyna dashboards and their archive state.",
        inputSchema: z.object({}).strict(),
        outputSchema: DashboardListSchema,
        risk: { readOnly: true, destructive: false, openWorld: false, idempotent: true },
        executor: {
          kind: "module",
          execute() {
            return { result: { dashboards: service.store.listDashboards() } };
          },
        },
      },
      {
        id: "search-items",
        title: "Search Dyna items",
        description:
          "Return a bounded actionable dashboard brief and stable item IDs for enrichment, task attachment, or clients without component UI.",
        inputSchema: z
          .object({
            dashboardId: z.uuid(),
            query: z.string().trim().max(500).default(""),
            scope: z.enum(["active", "archive"]).default("active"),
          })
          .strict(),
        outputSchema: z
          .object({
            dashboard: DynaDashboardSchema,
            revision: z.number().int().nonnegative(),
            freshness: z.enum(["fresh", "aging", "stale"]),
            total: z.number().int().nonnegative(),
            items: z.array(SearchItemSchema).max(20),
          })
          .strict(),
        risk: { readOnly: true, destructive: false, openWorld: false, idempotent: true },
        executor: {
          kind: "module",
          execute(input) {
            const { dashboardId, query, scope } = z
              .object({
                dashboardId: z.uuid(),
                query: z.string().trim().max(500).default(""),
                scope: z.enum(["active", "archive"]).default("active"),
              })
              .strict()
              .parse(input);
            const snapshot = service.store.snapshot(dashboardId, query, scope);
            return {
              result: {
                dashboard: snapshot.dashboard,
                revision: snapshot.revision,
                freshness: snapshot.freshness,
                total: scope === "archive" ? snapshot.counts.archived : snapshot.counts.total,
                items: snapshot.cards.slice(0, 20).map((card) => ({
                  itemId: card.id,
                  fingerprint: card.fingerprint,
                  title: card.title,
                  summary: card.summary,
                  sourceRef: service.store.itemContext(card.id).sourceRef,
                  priority: card.priority,
                  priorityReason: card.priorityReason,
                  sourceUpdatedAt: card.sourceUpdatedAt,
                  ...(card.dueAt ? { dueAt: card.dueAt } : {}),
                  workflowState: card.workflowState,
                  ...(card.attention ? { attention: card.attention } : {}),
                  plan: card.plan,
                  nextSteps: card.nextSteps,
                  ...(card.outcome ? { outcome: card.outcome } : {}),
                  linkedTasks: card.linkedTasks,
                  ...(card.archive ? { archive: card.archive } : {}),
                })),
              },
            };
          },
        },
      },
      {
        id: "create-publisher",
        title: "Create Dyna schedule publisher",
        description:
          "Create a Dyna publisher with its complete immutable required source manifest. Local CLI mode publishes without a prompt secret inside the same-user macOS trust boundary; only explicit local-preview mode returns a model-visible credential.",
        inputSchema: z
          .object({
            name: z.string().trim().min(1).max(96),
            schedule: ScheduleSchema.optional(),
            requiredSourceSlices: DynaRequiredSourceSlicesSchema,
            credentialMode: DynaCredentialModeSchema.default("disabled"),
          })
          .strict(),
        outputSchema: PublisherCreationResultSchema,
        risk: { readOnly: false, destructive: false, openWorld: false, idempotent: false },
        executor: {
          kind: "module",
          execute(input) {
            const { name, schedule, requiredSourceSlices, credentialMode } = z
              .object({
                name: z.string().trim().min(1).max(96),
                schedule: ScheduleSchema.optional(),
                requiredSourceSlices: DynaRequiredSourceSlicesSchema,
                credentialMode: DynaCredentialModeSchema.default("disabled"),
              })
              .strict()
              .parse(input);
            const created = service.store.createPublisher(
              name,
              schedule
                ? {
                    id: schedule.scheduleId,
                    title: schedule.scheduleTitle,
                    state: schedule.scheduleState,
                    staleAfterMinutes: schedule.staleAfterMinutes,
                  }
                : undefined,
              requiredSourceSlices,
              credentialMode,
            );
            if (credentialMode === "disabled") {
              return {
                result: {
                  publisher: created.publisher,
                  credentialHandling: "disabled-no-publication" as const,
                },
              };
            }
            if (credentialMode === "local_cli") {
              return {
                result: {
                  publisher: created.publisher,
                  credentialHandling: "local-cli-user-boundary" as const,
                },
              };
            }
            if (!created.secret) {
              throw new Error("Dyna could not issue a local-preview publisher credential.");
            }
            return {
              result: {
                publisher: created.publisher,
                secret: created.secret,
                credentialHandling: "model-visible-trusted-local-preview-only" as const,
              },
            };
          },
        },
        summarize(result) {
          const credentialHandling = PublisherCreationResultSchema.parse(result).credentialHandling;
          if (credentialHandling === "disabled-no-publication") {
            return "Created a Dyna publisher with publication disabled.";
          }
          return credentialHandling === "local-cli-user-boundary"
            ? "Created a Dyna publisher for secret-free local CLI publication."
            : "Created a Dyna publisher with a model-visible credential for explicitly authorized trusted non-production local preview.";
        },
      },
      {
        id: "rotate-publisher-secret",
        title: "Rotate Dyna publisher credential",
        description:
          "Invalidate an active publisher credential and return one replacement for trusted local preview.",
        inputSchema: z.object({ publisherId: z.uuid() }).strict(),
        outputSchema: z
          .object({
            publisherId: z.uuid(),
            secret: z.string().min(32).max(128),
            credentialHandling: z.literal("model-visible-trusted-local-preview-only"),
          })
          .strict(),
        risk: { readOnly: false, destructive: true, openWorld: false, idempotent: false },
        executor: {
          kind: "module",
          execute(input) {
            const { publisherId } = z.object({ publisherId: z.uuid() }).strict().parse(input);
            return {
              result: {
                publisherId,
                secret: service.store.rotatePublisherSecret(publisherId),
                credentialHandling: "model-visible-trusted-local-preview-only" as const,
              },
            };
          },
        },
      },
      {
        id: "enable-local-cli-publisher",
        title: "Enable local Dyna publisher",
        description:
          "Idempotently enable same-user local CLI publication for an existing disabled publisher with an immutable source manifest.",
        inputSchema: z.object({ publisherId: z.uuid() }).strict(),
        outputSchema: EmptyResultSchema,
        risk: { readOnly: false, destructive: false, openWorld: false, idempotent: true },
        executor: {
          kind: "module",
          execute(input) {
            const { publisherId } = z.object({ publisherId: z.uuid() }).strict().parse(input);
            service.store.enableLocalCliPublisher(publisherId);
            return { result: { ok: true as const } };
          },
        },
      },
      {
        id: "revoke-publisher",
        title: "Revoke Dyna publisher",
        description:
          "Stop a publisher from accepting runs, optionally purging its published records and bindings.",
        inputSchema: z
          .object({ publisherId: z.uuid(), purgePublishedData: z.boolean().default(false) })
          .strict(),
        outputSchema: EmptyResultSchema,
        risk: { readOnly: false, destructive: true, openWorld: false, idempotent: true },
        executor: {
          kind: "module",
          execute(input) {
            const { publisherId, purgePublishedData } = z
              .object({ publisherId: z.uuid(), purgePublishedData: z.boolean().default(false) })
              .strict()
              .parse(input);
            service.store.revokePublisher(publisherId, purgePublishedData);
            return { result: { ok: true as const } };
          },
        },
      },
      {
        id: "bind-schedule",
        title: "Bind schedule to Dyna dashboard",
        description:
          "Bind one scheduled publisher to one dashboard and optionally register its required source slices once; publishers and dashboards can have many bindings.",
        inputSchema: z
          .object({
            dashboardId: z.uuid(),
            publisherId: z.uuid(),
            requiredSourceSlices: DynaRequiredSourceSlicesSchema.optional(),
          })
          .extend(ScheduleSchema.shape)
          .strict(),
        outputSchema: EmptyResultSchema,
        risk: { readOnly: false, destructive: false, openWorld: false, idempotent: true },
        executor: {
          kind: "module",
          execute(input) {
            const parsed = z
              .object({
                dashboardId: z.uuid(),
                publisherId: z.uuid(),
                requiredSourceSlices: DynaRequiredSourceSlicesSchema.optional(),
              })
              .extend(ScheduleSchema.shape)
              .strict()
              .parse(input);
            service.store.bindSchedule(parsed.dashboardId, parsed.publisherId, {
              id: parsed.scheduleId,
              title: parsed.scheduleTitle,
              state: parsed.scheduleState,
              staleAfterMinutes: parsed.staleAfterMinutes,
              ...(parsed.requiredSourceSlices
                ? { requiredSourceSlices: parsed.requiredSourceSlices }
                : {}),
            });
            return { result: { ok: true as const } };
          },
        },
      },
      {
        id: "unbind-schedule",
        title: "Unbind schedule from Dyna dashboard",
        description:
          "Remove one dashboard/publisher binding without changing the native schedule or its other dashboards.",
        inputSchema: z.object({ dashboardId: z.uuid(), publisherId: z.uuid() }).strict(),
        outputSchema: EmptyResultSchema,
        risk: { readOnly: false, destructive: true, openWorld: false, idempotent: true },
        executor: {
          kind: "module",
          execute(input) {
            const { dashboardId, publisherId } = z
              .object({ dashboardId: z.uuid(), publisherId: z.uuid() })
              .strict()
              .parse(input);
            service.store.unbindSchedule(dashboardId, publisherId);
            return { result: { ok: true as const } };
          },
        },
      },
      {
        id: "list-publishers",
        title: "List Dyna scheduled sources",
        description:
          "List registered native schedule identities, required source manifests, and last-run status, optionally for one dashboard.",
        inputSchema: z.object({ dashboardId: z.uuid().optional() }).strict(),
        outputSchema: z.object({ publishers: z.array(DynaPublisherSchema).max(100) }).strict(),
        risk: { readOnly: true, destructive: false, openWorld: false, idempotent: true },
        executor: {
          kind: "module",
          execute(input) {
            const { dashboardId } = z
              .object({ dashboardId: z.uuid().optional() })
              .strict()
              .parse(input);
            return { result: { publishers: service.store.listPublishers(dashboardId) } };
          },
        },
      },
      {
        id: "update-schedule-status",
        title: "Update Dyna schedule status",
        description:
          "Reconcile a publisher with the current native Codex schedule metadata and optionally register its required source slices once.",
        inputSchema: z
          .object({
            publisherId: z.uuid(),
            scheduleTitle: z.string().trim().min(1).max(200).optional(),
            scheduleState: z.enum(["active", "paused", "unknown"]),
            staleAfterMinutes: z.number().int().min(5).max(43_200).optional(),
            requiredSourceSlices: DynaRequiredSourceSlicesSchema.optional(),
          })
          .strict(),
        outputSchema: EmptyResultSchema,
        risk: { readOnly: false, destructive: false, openWorld: false, idempotent: true },
        executor: {
          kind: "module",
          execute(input) {
            const parsed = z
              .object({
                publisherId: z.uuid(),
                scheduleTitle: z.string().trim().min(1).max(200).optional(),
                scheduleState: z.enum(["active", "paused", "unknown"]),
                staleAfterMinutes: z.number().int().min(5).max(43_200).optional(),
                requiredSourceSlices: DynaRequiredSourceSlicesSchema.optional(),
              })
              .strict()
              .parse(input);
            service.store.updateScheduleStatus(parsed.publisherId, {
              ...(parsed.scheduleTitle ? { title: parsed.scheduleTitle } : {}),
              state: parsed.scheduleState,
              ...(parsed.staleAfterMinutes ? { staleAfterMinutes: parsed.staleAfterMinutes } : {}),
              ...(parsed.requiredSourceSlices
                ? { requiredSourceSlices: parsed.requiredSourceSlices }
                : {}),
            });
            return { result: { ok: true as const } };
          },
        },
      },
      {
        id: "publish-run",
        title: "Publish scheduled Dyna run",
        description:
          "Validate and publish bounded email, messaging, source-control, TWG, skill, or Codex records with an explicit local-preview secret. Local schedules use the installed plugin's separate flowzone-publish launcher.",
        inputSchema: z
          .object({
            publisherId: z.uuid(),
            secret: z.string().min(32).max(128),
            runId: IdentifierSchema,
            sourceCompletedAt: z.iso.datetime({ offset: true }),
            mode: z.enum(["replace", "upsert"]).default("replace"),
            status: z.enum(["succeeded", "partial", "failed"]).default("succeeded"),
            failureMessage: z.string().trim().min(1).max(500).optional(),
            sourceSlices: DynaPublishSourceSlicesSchema.optional(),
            items: z.array(DynaScheduledPublishedItemSchema).max(200),
          })
          .strict(),
        outputSchema: z
          .object({
            accepted: z.number().int().nonnegative().max(200),
            deduplicated: z.boolean(),
            superseded: z.boolean(),
            status: z.enum(["succeeded", "partial", "failed"]),
          })
          .strict(),
        risk: { readOnly: false, destructive: false, openWorld: false, idempotent: true },
        executor: {
          kind: "module",
          execute(input) {
            const parsed = z
              .object({
                publisherId: z.uuid(),
                secret: z.string().min(32).max(128),
                runId: IdentifierSchema,
                sourceCompletedAt: z.iso.datetime({ offset: true }),
                mode: z.enum(["replace", "upsert"]).default("replace"),
                status: z.enum(["succeeded", "partial", "failed"]).default("succeeded"),
                failureMessage: z.string().trim().min(1).max(500).optional(),
                sourceSlices: DynaPublishSourceSlicesSchema.optional(),
                items: z.array(DynaScheduledPublishedItemSchema).max(200),
              })
              .strict()
              .parse(input);
            const options = {
              runId: parsed.runId,
              sourceCompletedAt: parsed.sourceCompletedAt,
              mode: parsed.mode,
              status: parsed.status,
              ...(parsed.failureMessage ? { failureMessage: parsed.failureMessage } : {}),
              ...(parsed.sourceSlices ? { sourceSlices: parsed.sourceSlices } : {}),
            };
            return {
              result: service.publish(parsed.publisherId, parsed.secret, parsed.items, options),
            };
          },
        },
      },
      {
        id: "apply-enrichment",
        title: "Enrich Dyna item",
        description:
          "Replace the bounded enrichment overlay for the current item fingerprint and increment every bound dashboard revision.",
        inputSchema: z
          .object({
            itemId: z.uuid(),
            expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            expectedEnrichmentVersion: z.number().int().nonnegative(),
            summary: z.string().trim().min(1).max(1_000).optional(),
            priority: DynaPrioritySchema.optional(),
            priorityReason: z.string().trim().min(1).max(500).optional(),
            dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
            labels: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
            people: z.array(DynaPersonSignalSchema).max(8).optional(),
            attention: z.string().trim().min(1).max(500).optional(),
            plan: z.array(z.string().trim().min(1).max(200)).max(4).optional(),
            nextSteps: z.array(DynaNextStepSchema).max(4).optional(),
            provenance: z.string().trim().min(1).max(128).default("codex-main-chat"),
          })
          .strict(),
        outputSchema: EmptyResultSchema,
        risk: { readOnly: false, destructive: false, openWorld: false, idempotent: false },
        executor: {
          kind: "module",
          execute(input) {
            const parsed = z
              .object({
                itemId: z.uuid(),
                expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
                expectedEnrichmentVersion: z.number().int().nonnegative(),
                summary: z.string().trim().min(1).max(1_000).optional(),
                priority: DynaPrioritySchema.optional(),
                priorityReason: z.string().trim().min(1).max(500).optional(),
                dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
                labels: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
                people: z.array(DynaPersonSignalSchema).max(8).optional(),
                attention: z.string().trim().min(1).max(500).optional(),
                plan: z.array(z.string().trim().min(1).max(200)).max(4).optional(),
                nextSteps: z.array(DynaNextStepSchema).max(4).optional(),
                provenance: z.string().trim().min(1).max(128).default("codex-main-chat"),
              })
              .strict()
              .parse(input);
            service.store.applyEnrichment(parsed.itemId, {
              expectedFingerprint: parsed.expectedFingerprint,
              expectedEnrichmentVersion: parsed.expectedEnrichmentVersion,
              ...(parsed.summary !== undefined ? { summary: parsed.summary } : {}),
              ...(parsed.priority !== undefined ? { priority: parsed.priority } : {}),
              ...(parsed.priorityReason !== undefined
                ? { priorityReason: parsed.priorityReason }
                : {}),
              ...(parsed.dueAt !== undefined ? { dueAt: parsed.dueAt } : {}),
              ...(parsed.labels !== undefined ? { labels: parsed.labels } : {}),
              ...(parsed.people !== undefined ? { people: parsed.people } : {}),
              ...(parsed.attention !== undefined ? { attention: parsed.attention } : {}),
              ...(parsed.plan !== undefined ? { plan: parsed.plan } : {}),
              ...(parsed.nextSteps !== undefined ? { nextSteps: parsed.nextSteps } : {}),
              provenance: parsed.provenance,
            });
            return { result: { ok: true as const } };
          },
        },
      },
      {
        id: "get-item-context",
        title: "Get Dyna item context",
        description:
          "Read the bounded immutable source context for a Dyna item before executing an approved action.",
        inputSchema: z.object({ itemId: z.uuid() }).strict(),
        outputSchema: DynaItemContextSchema,
        risk: { readOnly: true, destructive: false, openWorld: false, idempotent: true },
        executor: {
          kind: "module",
          execute(input) {
            const { itemId } = z.object({ itemId: z.uuid() }).strict().parse(input);
            return { result: service.store.itemContext(itemId) };
          },
        },
      },
      {
        id: "get-item-history",
        title: "Get Dyna item history",
        description:
          "Read dashboard-local archive dispositions, restorations, and priority ordering history for retrospective reporting.",
        inputSchema: z.object({ dashboardId: z.uuid(), itemId: z.uuid() }).strict(),
        outputSchema: DynaItemHistorySchema,
        risk: { readOnly: true, destructive: false, openWorld: false, idempotent: true },
        executor: {
          kind: "module",
          execute(input) {
            const { dashboardId, itemId } = z
              .object({ dashboardId: z.uuid(), itemId: z.uuid() })
              .strict()
              .parse(input);
            return { result: service.store.itemHistory(dashboardId, itemId) };
          },
        },
      },
      {
        id: "attach-codex-task",
        title: "Attach Codex task to Dyna item",
        description:
          "Attach controller-observed metadata for an existing Codex task so its status can be shown and refreshed from the dashboard.",
        inputSchema: z.object({ itemId: z.uuid(), task: DynaTaskStatusSchema }).strict(),
        outputSchema: EmptyResultSchema,
        risk: { readOnly: false, destructive: false, openWorld: false, idempotent: true },
        executor: {
          kind: "module",
          execute(input) {
            const { itemId, task } = z
              .object({ itemId: z.uuid(), task: DynaTaskStatusSchema })
              .strict()
              .parse(input);
            service.store.upsertTaskStatus(itemId, task);
            return { result: { ok: true as const } };
          },
        },
      },
      {
        id: "claim-action",
        title: "Claim Dyna action request",
        description:
          "Claim exactly one delivered, unexpired executive action and receive its immutable context plus one-time completion capability.",
        inputSchema: z.object({ requestId: z.uuid() }).strict(),
        outputSchema: z
          .object({
            request: DynaActionRequestSchema,
            claimToken: z.string().min(32).max(128),
            context: z
              .object({
                item: DynaActionItemContextSchema.optional(),
                task: DynaTaskStatusSchema.optional(),
              })
              .strict(),
          })
          .strict(),
        risk: { readOnly: false, destructive: false, openWorld: false, idempotent: false },
        executor: {
          kind: "module",
          execute(input) {
            const { requestId } = z.object({ requestId: z.uuid() }).strict().parse(input);
            return { result: service.store.claimAction(requestId) };
          },
        },
      },
      {
        id: "complete-action",
        title: "Complete Dyna action request",
        description:
          "Complete one claimed request using its one-time capability and optionally link controller-reported Codex task status.",
        inputSchema: CompletionInputSchema,
        outputSchema: DynaActionRequestSchema,
        risk: { readOnly: false, destructive: false, openWorld: false, idempotent: false },
        executor: {
          kind: "module",
          execute(input) {
            const parsed = CompletionInputSchema.parse(input);
            return {
              result: service.store.completeAction(
                parsed.requestId,
                parsed.claimToken,
                parsed.outcome === "succeeded"
                  ? { outcome: parsed.outcome, ...(parsed.task ? { task: parsed.task } : {}) }
                  : { outcome: parsed.outcome, failureMessage: parsed.failureMessage },
              ),
            };
          },
        },
      },
      {
        id: "resolve-action-reconciliation",
        title: "Resolve uncertain Dyna task creation",
        description:
          "Resolve a task-creation request that may have taken effect by linking the verified native task or confirming that no task was created.",
        inputSchema: ReconciliationInputSchema,
        outputSchema: DynaActionRequestSchema,
        risk: { readOnly: false, destructive: false, openWorld: false, idempotent: false },
        executor: {
          kind: "module",
          execute(input) {
            const parsed = ReconciliationInputSchema.parse(input);
            return {
              result: service.store.resolveActionReconciliation(
                parsed.requestId,
                parsed.outcome === "task_linked"
                  ? { outcome: parsed.outcome, task: parsed.task }
                  : { outcome: parsed.outcome, explanation: parsed.explanation },
              ),
            };
          },
        },
      },
      {
        id: "render-dashboard",
        title: "Open Dyna dashboard",
        description:
          "Open one persistent Dyna executive dashboard in its responsive, actionable MCP Apps surface.",
        inputSchema: DashboardIdSchema,
        outputSchema: z
          .object({
            dashboard: DynaDashboardSchema,
            revision: z.number().int().nonnegative(),
            itemCount: z.number().int().nonnegative(),
          })
          .strict(),
        risk: { readOnly: true, destructive: false, openWorld: false, idempotent: false },
        ui: {
          view: "dashboard",
          payloadSchema: DynaUiPayloadSchema,
          legacyMetaKey: "dynaDashboard",
        },
        presentation: { toolName: "render_dyna_dashboard", resourceUri: DYNA_TEMPLATE_URI },
        executor: {
          kind: "module",
          execute(input) {
            const { dashboardId } = DashboardIdSchema.parse(input);
            const payload = service.render(dashboardId);
            return {
              result: {
                dashboard: payload.snapshot.dashboard,
                revision: payload.snapshot.revision,
                itemCount: payload.snapshot.cards.length,
              },
              uiPayload: payload,
            };
          },
        },
        summarize(result) {
          const parsed = z
            .object({ dashboard: DynaDashboardSchema, revision: z.number(), itemCount: z.number() })
            .parse(result);
          return `Opened ${parsed.dashboard.name} with ${String(parsed.itemCount)} items at revision ${String(parsed.revision)}.`;
        },
      },
    ],
    appTools: appTools(service),
  };
}

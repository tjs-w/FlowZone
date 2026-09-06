import {
  DynaActionItemContextSchema,
  DynaActionKindSchema,
  DynaActionRequestSchema,
  DynaActionStateSchema,
  DynaDashboardSchema,
  DynaItemContextSchema,
  DynaNextStepSchema,
  DynaPersonSignalSchema,
  DynaPrioritySchema,
  DynaPublishedItemSchema,
  DynaPublisherSchema,
  DynaSourceRefSchema,
  DynaTaskStatusSchema,
  DynaTodoInputSchema,
  DynaUiPayloadSchema,
} from "@flowzone/dyna-contracts";
import { DynaService } from "@flowzone/dyna-node";
import { z } from "zod";

import type { FlowZoneAppTool, FlowZonePlugin } from "../plugin.js";

export const DYNA_PLUGIN_ID = "dyna";
export const DYNA_TEMPLATE_URI = "ui://flowzone/dyna/v5.html";

const DashboardIdSchema = z.object({ dashboardId: z.uuid() }).strict();
const ViewTokenSchema = z
  .object({
    viewToken: z.string().min(32).max(128),
    currentRevision: z.number().int().nonnegative().optional(),
    query: z.string().trim().max(500).optional(),
  })
  .strict();
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
  })
  .strict();
const PublisherSecretResultSchema = z
  .object({
    publisher: DynaPublisherSchema,
    secret: z.string().min(32).max(128),
    credentialHandling: z.literal("model-visible-trusted-local-preview-only"),
  })
  .strict();
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
        const { viewToken, currentRevision, query } = ViewTokenSchema.parse(input);
        const payload = service.refresh(viewToken, query);
        const changed = currentRevision !== payload.snapshot.revision;
        return {
          structuredContent: { revision: payload.snapshot.revision, changed },
          content: [],
          _meta: { dynaDashboard: payload },
        };
      },
    },
    {
      name: "dyna_add_annotation",
      title: "Add Dyna annotation",
      description: "Add a bounded note to an item in the capability-bound Dyna view.",
      inputSchema: z
        .object({
          viewToken: z.string().min(32).max(128),
          itemId: z.uuid(),
          body: z.string().trim().min(1).max(1_000),
        })
        .strict(),
      outputSchema: z.object({ annotationId: z.uuid() }).strict(),
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
            body: z.string().trim().min(1).max(1_000),
          })
          .strict()
          .parse(input);
        const annotation = service.store.addAnnotation(
          parsed.viewToken,
          parsed.itemId,
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
        "Apply a user-controlled priority or sequence change with revision and fingerprint preconditions.",
      inputSchema: z
        .object({
          viewToken: z.string().min(32).max(128),
          itemId: z.uuid(),
          action: z.enum(["bump", "lower", "earlier", "later"]),
          expectedRevision: z.number().int().nonnegative(),
          expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
      outputSchema: z.object({ changed: z.boolean() }).strict(),
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
            action: z.enum(["bump", "lower", "earlier", "later"]),
            expectedRevision: z.number().int().nonnegative(),
            expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict()
          .parse(input);
        const result = service.store.organizeItem(
          parsed.viewToken,
          parsed.itemId,
          parsed.action,
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
              })
              .strict()
              .parse(input);
            const dashboard = service.store.createDashboard(parsed.name, parsed.description);
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
              })
              .strict()
              .parse(input);
            const dashboard = service.store.updateDashboard(parsed.dashboardId, {
              ...(parsed.name !== undefined ? { name: parsed.name } : {}),
              ...(parsed.description !== undefined ? { description: parsed.description } : {}),
              ...(parsed.archived !== undefined ? { archived: parsed.archived } : {}),
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
            const { dashboardId, query } = z
              .object({ dashboardId: z.uuid(), query: z.string().trim().max(500).default("") })
              .strict()
              .parse(input);
            const snapshot = service.store.snapshot(dashboardId, query);
            return {
              result: {
                dashboard: snapshot.dashboard,
                revision: snapshot.revision,
                freshness: snapshot.freshness,
                total: snapshot.counts.total,
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
          "Create a model-visible publisher credential for one trusted single-user local-preview schedule; production use requires a protected host credential channel.",
        inputSchema: z
          .object({
            name: z.string().trim().min(1).max(96),
            schedule: ScheduleSchema.optional(),
          })
          .strict(),
        outputSchema: PublisherSecretResultSchema,
        risk: { readOnly: false, destructive: false, openWorld: false, idempotent: false },
        executor: {
          kind: "module",
          execute(input) {
            const { name, schedule } = z
              .object({
                name: z.string().trim().min(1).max(96),
                schedule: ScheduleSchema.optional(),
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
            );
            return {
              result: {
                ...created,
                credentialHandling: "model-visible-trusted-local-preview-only" as const,
              },
            };
          },
        },
        summarize() {
          return "Created a Dyna publisher for trusted local preview. Its one-time credential is model-visible and must be rotated or revoked when exposure is uncertain.";
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
          "Bind one scheduled publisher to one dashboard; publishers and dashboards can have many bindings.",
        inputSchema: z
          .object({ dashboardId: z.uuid(), publisherId: z.uuid() })
          .extend(ScheduleSchema.shape)
          .strict(),
        outputSchema: EmptyResultSchema,
        risk: { readOnly: false, destructive: false, openWorld: false, idempotent: true },
        executor: {
          kind: "module",
          execute(input) {
            const parsed = z
              .object({ dashboardId: z.uuid(), publisherId: z.uuid() })
              .extend(ScheduleSchema.shape)
              .strict()
              .parse(input);
            service.store.bindSchedule(parsed.dashboardId, parsed.publisherId, {
              id: parsed.scheduleId,
              title: parsed.scheduleTitle,
              state: parsed.scheduleState,
              staleAfterMinutes: parsed.staleAfterMinutes,
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
          "List registered native schedule identities and last-run status, optionally for one dashboard.",
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
          "Reconcile a publisher with the current native Codex schedule title and state.",
        inputSchema: z
          .object({
            publisherId: z.uuid(),
            scheduleTitle: z.string().trim().min(1).max(200).optional(),
            scheduleState: z.enum(["active", "paused", "unknown"]),
            staleAfterMinutes: z.number().int().min(5).max(43_200).optional(),
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
              })
              .strict()
              .parse(input);
            service.store.updateScheduleStatus(parsed.publisherId, {
              ...(parsed.scheduleTitle ? { title: parsed.scheduleTitle } : {}),
              state: parsed.scheduleState,
              ...(parsed.staleAfterMinutes ? { staleAfterMinutes: parsed.staleAfterMinutes } : {}),
            });
            return { result: { ok: true as const } };
          },
        },
      },
      {
        id: "publish-run",
        title: "Publish scheduled Dyna run",
        description:
          "Validate and upsert bounded email, messaging, source-control, TWG, skill, or Codex records from an authenticated scheduled run.",
        inputSchema: z
          .object({
            publisherId: z.uuid(),
            secret: z.string().min(32).max(128),
            runId: IdentifierSchema,
            sourceCompletedAt: z.iso.datetime({ offset: true }),
            mode: z.enum(["replace", "upsert"]).default("replace"),
            status: z.enum(["succeeded", "partial", "failed"]).default("succeeded"),
            failureMessage: z.string().trim().min(1).max(500).optional(),
            items: z.array(DynaPublishedItemSchema).max(200),
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
                items: z.array(DynaPublishedItemSchema).max(200),
              })
              .strict()
              .parse(input);
            return {
              result: service.publish(parsed.publisherId, parsed.secret, parsed.items, {
                runId: parsed.runId,
                sourceCompletedAt: parsed.sourceCompletedAt,
                mode: parsed.mode,
                status: parsed.status,
                ...(parsed.failureMessage ? { failureMessage: parsed.failureMessage } : {}),
              }),
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

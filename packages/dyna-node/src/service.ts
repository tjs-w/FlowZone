import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import {
  type DynaActionItemContextSchema,
  type DynaActionRequestSchema,
  DynaAnnotationSchema,
  DynaArchiveReasonSchema,
  DynaDashboardListResultSchema,
  DynaDashboardSchema,
  DynaDashboardShowResultSchema,
  DynaDashboardSnapshotSchema,
  DynaItemShowResultSchema,
  DynaFollowUpCreateInputSchema,
  DynaFollowUpCreateResultSchema,
  DynaItemArchiveResultSchema,
  DynaItemEnrichResultSchema,
  DynaItemPlaceResultSchema,
  DynaItemSearchResultSchema,
  DynaItemRestoreResultSchema,
  DynaItemUpdateResultSchema,
  DynaItemNumberSchema,
  DynaMaterializedItemSchema,
  DynaLifecycleArchiveInputSchema,
  DynaLifecycleRestoreInputSchema,
  DynaOrganizePlaceInputSchema,
  DynaOrganizePlaceManyInputSchema,
  DynaPlaceManyResultSchema,
  DynaPrioritySchema,
  DynaPublishedItemSchema,
  DynaTodoCreateInputSchema,
  DynaTodoCreateResultSchema,
  DynaTodoInputSchema,
  DynaTaskSyncBeginResultSchema,
  DynaTaskSyncScopeSchema,
  DynaTaskSyncStatusResultSchema,
  DynaTaskSyncSummarySchema,
  DynaUiPayloadSchema,
  DynaWorkEnrichInputSchema,
  DynaWorkUpdateInputSchema,
  DynaWorkUpdateSchema,
  dynaLeadershipScore,
  dynaSourceLabel,
  formatDynaItemNumber,
  type DynaCard,
  type DynaDashboardListResult,
  type DynaDashboard,
  type DynaDashboardSnapshot,
  type DynaDashboardShowResult,
  type DynaArchiveReason,
  type DynaCodexSessionCandidate,
  type DynaCliErrorCode,
  type DynaCredentialMode,
  type DynaFollowUpCreateInput,
  type DynaFollowUpCreateResult,
  type DynaItemArchiveResult,
  type DynaItemContext,
  type DynaItemEnrichResult,
  type DynaItemHistory,
  type DynaItemPlaceResult,
  type DynaItemRestoreResult,
  type DynaItemSearchResult,
  type DynaItemSearchScope,
  type DynaItemShowResult,
  type DynaItemStatusResult,
  type DynaItemUpdateResult,
  type DynaItemNumber,
  type DynaLifecycleArchiveInput,
  type DynaLifecycleRestoreInput,
  type DynaOrganizePlaceInput,
  type DynaOrganizePlaceManyInput,
  type DynaPlaceManyResult,
  type DynaPriority,
  type DynaPublishedItem,
  type DynaPublisher,
  type DynaPublishSourceSlice,
  type DynaRequiredSourceSlice,
  type DynaSetItemStatusInput,
  type DynaTaskStatus,
  type DynaTaskSyncBeginResult,
  type DynaTaskSyncScope,
  type DynaTaskSyncStatusResult,
  type DynaTaskSyncSummary,
  type DynaTodoCreateInput,
  type DynaTodoCreateResult,
  type DynaTodoInput,
  type DynaUiPayload,
  type DynaWorkActivityPage,
  type DynaWorkEnrichInput,
  type DynaWorkUpdateInput,
} from "@flowzone/dyna-contracts";
import {
  DynaTaskSyncBatchInputSchema,
  DynaTaskSyncBatchResultSchema,
  DynaTaskSyncClaimSchema,
  DynaTaskSyncCompleteInputSchema,
  type DynaTaskSyncBatchInput,
  type DynaTaskSyncBatchResult,
  type DynaTaskSyncClaim,
  type DynaTaskSyncCompleteInput,
  type DynaTaskSyncObservation,
} from "@flowzone/dyna-contracts/controller";
import { z } from "zod";

import {
  DynaCliStoreError as RepositoryDynaCliStoreError,
  SqliteDynaRepository,
  type DynaCliManualItemInsert,
  type DynaCliPlacementWrite,
  type DynaCliPositionedItem,
  type DynaRepositoryCardEvidence,
  type DynaRepositoryProjectionItem,
  type DynaRepositoryTaskSyncRun,
  type DynaRepository,
  type DynaPersistenceOutcome,
  type DynaReadUnitOfWork,
  type DynaWriteUnitOfWork,
} from "./repository.js";
import {
  projectDynaItemState,
  type DynaItemProjection,
  type DynaItemProjectionInput,
} from "./projector.js";

export const DYNA_APPLICATION_CAPABILITIES = [
  "dashboard:read",
  "dashboard:manage",
  "item:read",
  "item:write",
  "publisher:publish",
  "publisher:manage",
  "view:interact",
  "action:execute",
  "task:observe",
  "maintenance:backup",
] as const;

export type DynaApplicationCapability = (typeof DYNA_APPLICATION_CAPABILITIES)[number];
export type DynaApplicationActorKind =
  "trusted_local" | "mcp_host" | "codex_task" | "publisher" | "controller";

/**
 * A bounded in-process authority descriptor. It protects application entry points
 * from accidental adapter expansion; it is not a replacement for OS isolation.
 */
export interface DynaApplicationActor {
  readonly kind: DynaApplicationActorKind;
  readonly capabilities: readonly DynaApplicationCapability[];
}

export interface DynaApplicationServiceOptions {
  readonly databasePath?: string;
  readonly clock?: () => Date;
  readonly actor?: DynaApplicationActor;
}

export class DynaApplicationCapabilityError extends Error {
  readonly code = "capability_denied";
  readonly actorKind: DynaApplicationActorKind;
  readonly capability: DynaApplicationCapability;

  constructor(actorKind: DynaApplicationActorKind, capability: DynaApplicationCapability) {
    super(`The ${actorKind} Dyna actor lacks the ${capability} capability.`);
    this.name = "DynaApplicationCapabilityError";
    this.actorKind = actorKind;
    this.capability = capability;
  }
}

/** Domain error returned by the canonical Dyna CLI application operations. */
export class DynaCliError extends RepositoryDynaCliStoreError {
  constructor(code: DynaCliErrorCode, message: string) {
    super(code, message);
    this.name = "DynaCliError";
  }
}

const TASK_ATTRIBUTED_WORK_KINDS = new Set<DynaWorkUpdateInput["kind"]>([
  "progress",
  "needs_input",
  "blocked",
  "completion_reported",
  "handoff",
]);
const PRIORITIES = ["critical", "high", "normal", "low"] as const;
const MAX_DASHBOARDS = 100;
const MAX_PUBLISHERS = 100;
const MAX_SNAPSHOT_CARDS = 200;
const MAX_CODEX_TASK_TITLE_CODE_POINTS = 200;
const TASK_ASSOCIATION_RESERVATION_MS = 5 * 60 * 1_000;
const MAX_TASK_BINDINGS_PER_ITEM = 8;
const MAX_TASK_SYNC_TARGETS = 200;
const TASK_SYNC_CLAIM_LEASE_MS = 5 * 60 * 1_000;
const TASK_SYNC_RUN_TTL_MS = 15 * 60 * 1_000;
const TASK_SYNC_DELIVERY_RESERVATION_MS = 15 * 1_000;
const BIDI_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const LEADING_DYNA_ITEM_NUMBER_TOKENS_PATTERN = /^(?::\d+:\s*)+/u;
const HOUR_MS = 60 * 60 * 1_000;
const LegacyDynaFollowUpCreateResultSchema = z
  .object({
    schema: z.literal("dyna/follow-up-create-result-v1"),
    requestId: z.uuid(),
    itemId: z.uuid(),
    sourceItemId: z.uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    deduplicated: z.boolean(),
  })
  .strict();

/**
 * Return the one canonical native Codex task title for a Dyna item.
 *
 * Existing Dyna prefixes are removed before the immutable item prefix is added,
 * whitespace is normalized to one line, and truncation is by Unicode code point
 * so a retry produces exactly the same title without splitting a surrogate pair.
 */
export function canonicalDynaTaskTitle(itemNumber: DynaItemNumber, title: string): string {
  const prefix = formatDynaItemNumber(DynaItemNumberSchema.parse(itemNumber));
  const unprefixed = title
    .replace(BIDI_CONTROL_PATTERN, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(LEADING_DYNA_ITEM_NUMBER_TOKENS_PATTERN, "")
    .trim();
  const body = unprefixed || "Codex task";
  const titlePrefix = `${prefix} `;
  const remaining = MAX_CODEX_TASK_TITLE_CODE_POINTS - Array.from(titlePrefix).length;
  const boundedBody = Array.from(body).slice(0, remaining).join("").trimEnd();
  return `${titlePrefix}${boundedBody || "Codex task"}`;
}

export function isCanonicalDynaTaskTitle(itemNumber: DynaItemNumber, title: string): boolean {
  return title === canonicalDynaTaskTitle(itemNumber, title);
}

function exactItemNumberQuery(query: string): DynaItemNumber | undefined {
  const match = /^:?([1-9]\d*):?$/u.exec(query.trim());
  if (!match?.[1]) return undefined;
  const parsed = DynaItemNumberSchema.safeParse(Number(match[1]));
  return parsed.success ? parsed.data : undefined;
}

function taskTitleSyncNeeded(
  itemNumber: DynaItemNumber,
  tasks: readonly DynaTaskStatus[],
): boolean {
  return tasks.some((task) => !isCanonicalDynaTaskTitle(itemNumber, task.title));
}

interface ProjectedRepositoryItem {
  readonly fact: DynaRepositoryProjectionItem;
  readonly item: DynaPublishedItem;
  readonly projection: DynaItemProjection;
  readonly priorityPosition: number;
  readonly priorityCount: number;
}

interface DynaTaskAttachmentBlocker {
  readonly code: "archived_item" | "completed_item" | "outside_dashboard";
  readonly message: string;
}

type DynaTaskAssociationReservationResult =
  | {
      readonly association: "reserved";
      readonly reservationId: string;
      readonly expiresAt?: string;
    }
  | { readonly association: "same_item"; readonly hostId: string }
  | { readonly association: "not_attachable" };

export type DynaTaskAssociationCheck =
  | {
      readonly association: "attachable";
      readonly reservationId: string;
      readonly expiresAt: string;
    }
  | { readonly association: "same_item"; readonly hostId: string }
  | { readonly association: "not_attachable" };

function snapshotSearchTerms(query: string): readonly string[] {
  return [...new Set(query.toLocaleLowerCase().split(/\s+/u).filter(Boolean))].slice(0, 12);
}

function materializeProjectionItem(fact: DynaRepositoryProjectionItem): DynaPublishedItem {
  const enrichment =
    fact.enrichment?.baseFingerprint === fact.fingerprint ? fact.enrichment : undefined;
  const { dueAt: sourceDueAt, ...base } = fact.base;
  const dueAt = enrichment?.dueAtSet ? enrichment.dueAt : sourceDueAt;
  return DynaMaterializedItemSchema.parse({
    ...base,
    ...(dueAt ? { dueAt } : {}),
    ...(enrichment?.summary ? { summary: enrichment.summary } : {}),
    ...(enrichment?.priority ? { priority: enrichment.priority } : {}),
    ...(enrichment?.priorityReason ? { priorityReason: enrichment.priorityReason } : {}),
    ...(enrichment?.labels ? { labels: enrichment.labels } : {}),
    ...(enrichment?.people ? { people: enrichment.people } : {}),
    ...(enrichment?.attention ? { attention: enrichment.attention } : {}),
    ...(enrichment?.plan ? { plan: enrichment.plan } : {}),
    ...(enrichment?.nextSteps ? { nextSteps: enrichment.nextSteps } : {}),
  });
}

function projectRepositoryItems(
  facts: readonly DynaRepositoryProjectionItem[],
): readonly ProjectedRepositoryItem[] {
  const projected = facts.map((fact) => {
    const item = materializeProjectionItem(fact);
    const projection = projectDynaItemState({
      fingerprint: fact.fingerprint,
      sourcePriority: fact.base.priority,
      sourceLeadershipScore: fact.sourceLeadershipScore,
      ...(fact.enrichment
        ? {
            enrichment: {
              baseFingerprint: fact.enrichment.baseFingerprint,
              ...(fact.enrichment.priority ? { priority: fact.enrichment.priority } : {}),
              leadershipScore: fact.enrichment.leadershipScore,
            },
          }
        : {}),
      ...(fact.preferencePriority ? { preferencePriority: fact.preferencePriority } : {}),
      ...(fact.userWorkflow ? { userWorkflow: fact.userWorkflow } : {}),
      tasks: fact.tasks,
      workUpdates: fact.workUpdates,
    });
    return { fact, item, projection };
  });
  const positions = new Map<string, { readonly position: number; readonly count: number }>();
  for (const priority of PRIORITIES) {
    for (const completed of [false, true]) {
      const group = projected
        .filter(
          ({ projection }) =>
            projection.effectivePriority === priority &&
            (projection.workflowState === "completed") === completed,
        )
        .sort(
          (left, right) =>
            (left.fact.preferenceSequence ?? Number.MAX_SAFE_INTEGER) -
              (right.fact.preferenceSequence ?? Number.MAX_SAFE_INTEGER) ||
            right.projection.effectiveLeadershipScore - left.projection.effectiveLeadershipScore ||
            (left.item.dueAt ?? "9999").localeCompare(right.item.dueAt ?? "9999") ||
            right.fact.sourceUpdatedAtMs - left.fact.sourceUpdatedAtMs ||
            left.fact.id.localeCompare(right.fact.id),
        );
      group.forEach(({ fact }, index) => {
        positions.set(fact.id, { position: index + 1, count: group.length });
      });
    }
  }
  return projected.map((value) => {
    const position = positions.get(value.fact.id);
    if (!position) throw new Error("Dyna could not position a projected item.");
    return {
      ...value,
      priorityPosition: position.position,
      priorityCount: position.count,
    };
  });
}

function sortProjectedItems(
  items: readonly ProjectedRepositoryItem[],
): readonly ProjectedRepositoryItem[] {
  return [...items].sort(
    (left, right) =>
      PRIORITIES.indexOf(left.projection.effectivePriority) -
        PRIORITIES.indexOf(right.projection.effectivePriority) ||
      left.priorityPosition - right.priorityPosition ||
      Number(left.projection.workflowState === "completed") -
        Number(right.projection.workflowState === "completed") ||
      left.fact.id.localeCompare(right.fact.id),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function secureDigestMatches(left: string | undefined, right: string): boolean {
  if (left?.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function taskSyncObservationReceiptIdentity(observation: DynaTaskSyncObservation): string {
  const eventAnchor = observation.nextCursor
    ? { kind: "cursor", value: observation.nextCursor }
    : observation.lastTurnId
      ? {
          kind: "turn-status",
          turnId: observation.lastTurnId,
          state: observation.task.state,
          statusUpdatedAt: observation.task.statusUpdatedAt,
        }
      : {
          kind: "status",
          state: observation.task.state,
          statusUpdatedAt: observation.task.statusUpdatedAt,
        };
  return sha256(canonicalJson({ taskId: observation.taskId, eventAnchor }));
}

function taskSyncObservationPayloadHash(observation: DynaTaskSyncObservation): string {
  return sha256(canonicalJson(observation));
}

function scopedUuid(scope: readonly string[]): string {
  const digest = sha256(JSON.stringify(["dyna/scoped-uuid-v1", ...scope]));
  const variant = ((Number.parseInt(digest[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function unwrapPersistenceOutcome<T>(outcome: DynaPersistenceOutcome<T>): T {
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

export interface DynaPublishResult {
  readonly accepted: number;
  readonly deduplicated: boolean;
  readonly superseded: boolean;
  readonly status: "succeeded" | "partial" | "failed";
}

export interface DynaPublishOptions {
  readonly runId: string;
  readonly sourceCompletedAt: string;
  readonly mode: "replace" | "upsert";
  readonly status: "succeeded" | "partial" | "failed";
  readonly failureMessage?: string;
  readonly sourceSlices?: readonly DynaPublishSourceSlice[];
}

export interface DynaItemHistoryOptions {
  readonly limit?: number;
  readonly archiveCursor?: string;
  readonly orderCursor?: string;
  readonly statusCursor?: string;
  readonly workCursor?: string;
}

export interface DynaItemActivityOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface DynaDashboardChanges {
  readonly name?: string;
  readonly description?: string;
  readonly archived?: boolean;
  readonly doneRetentionHours?: number;
}

export interface DynaScheduleRegistration {
  readonly id: string;
  readonly title: string;
  readonly state: "active" | "paused" | "unknown";
  readonly staleAfterMinutes?: number;
}

export interface DynaScheduleBinding extends DynaScheduleRegistration {
  readonly staleAfterMinutes: number;
  readonly requiredSourceSlices?: readonly DynaRequiredSourceSlice[];
}

export interface DynaScheduleStatusUpdate {
  readonly title?: string;
  readonly state: "active" | "paused" | "unknown";
  readonly staleAfterMinutes?: number;
  readonly requiredSourceSlices?: readonly DynaRequiredSourceSlice[];
}

export interface DynaEnrichmentUpdate {
  readonly summary?: string;
  readonly priority?: DynaPriority;
  readonly priorityReason?: string;
  readonly dueAt?: string | null;
  readonly labels?: readonly string[];
  readonly people?: DynaPublishedItem["people"];
  readonly attention?: string;
  readonly plan?: readonly string[];
  readonly nextSteps?: DynaPublishedItem["nextSteps"];
  readonly expectedFingerprint: string;
  readonly expectedEnrichmentVersion: number;
  readonly provenance: string;
}

export interface DynaArchiveResult {
  readonly archiveId: string;
  readonly itemId: string;
  readonly archivedAt: string;
  readonly reason: DynaArchiveReason;
  readonly mode: "manual" | "automatic";
}

export interface DynaViewArchiveInput {
  readonly reason: DynaArchiveReason;
  readonly reasonDetail?: string;
  readonly expectedRevision: number;
  readonly expectedFingerprint: string;
  readonly clientRequestId: string;
}

export interface DynaViewRestoreInput {
  readonly expectedRevision: number;
  readonly expectedFingerprint: string;
  readonly clientRequestId: string;
}

export type DynaAnnotation = z.infer<typeof DynaAnnotationSchema>;
export type DynaActionRequest = z.infer<typeof DynaActionRequestSchema>;
export type DynaActionItemContext = z.infer<typeof DynaActionItemContextSchema>;
export type DynaActionKind = DynaActionRequest["kind"];

export interface DynaPrepareActionInput {
  readonly itemId: string;
  readonly taskId?: string;
  readonly taskHostId?: string;
  readonly sessionListRequestId?: string;
  readonly expectedRevision: number;
  readonly expectedFingerprint: string;
  readonly idempotencyKey: string;
}

export interface DynaClaimedAction {
  readonly request: DynaActionRequest;
  readonly claimToken: string;
  readonly context: {
    readonly item?: DynaActionItemContext;
    readonly task?: DynaTaskStatus;
  };
}

export type DynaActionCompletion =
  | {
      readonly outcome: "succeeded";
      readonly task?: DynaTaskStatus;
      readonly candidates?: readonly DynaCodexSessionCandidate[];
    }
  | {
      readonly outcome: "failed" | "needs_reconciliation";
      readonly failureMessage: string;
    };

export type DynaActionReconciliation =
  | { readonly outcome: "task_linked"; readonly task: DynaTaskStatus }
  | { readonly outcome: "no_task_created"; readonly explanation: string };

const DEFAULT_APPLICATION_ACTOR: DynaApplicationActor = Object.freeze({
  kind: "trusted_local",
  capabilities: Object.freeze([...DYNA_APPLICATION_CAPABILITIES]),
});

const APPLICATION_CAPABILITY_SET = new Set<string>(DYNA_APPLICATION_CAPABILITIES);
const APPLICATION_ACTOR_KIND_SET = new Set<string>([
  "trusted_local",
  "mcp_host",
  "codex_task",
  "publisher",
  "controller",
]);
const APPLICATION_ACTOR_CAPABILITIES = {
  trusted_local: new Set<DynaApplicationCapability>(DYNA_APPLICATION_CAPABILITIES),
  mcp_host: new Set<DynaApplicationCapability>(
    DYNA_APPLICATION_CAPABILITIES.filter((capability) => capability !== "maintenance:backup"),
  ),
  codex_task: new Set<DynaApplicationCapability>(["dashboard:read", "item:read", "item:write"]),
  publisher: new Set<DynaApplicationCapability>(["publisher:publish"]),
  controller: new Set<DynaApplicationCapability>(["task:observe"]),
} as const satisfies Record<DynaApplicationActorKind, ReadonlySet<DynaApplicationCapability>>;

/** The single application boundary shared by Dyna's CLI and MCP adapters. */
export class DynaApplicationService {
  readonly #repository: DynaRepository;
  readonly #actorKind: DynaApplicationActorKind;
  readonly #capabilities: ReadonlySet<DynaApplicationCapability>;
  readonly #clock: () => Date;

  constructor(options: DynaApplicationServiceOptions = {}) {
    const actor = options.actor ?? DEFAULT_APPLICATION_ACTOR;
    if (!APPLICATION_ACTOR_KIND_SET.has(actor.kind)) {
      throw new TypeError("Dyna application actor kind is not supported.");
    }
    if (
      actor.capabilities.length > DYNA_APPLICATION_CAPABILITIES.length ||
      new Set(actor.capabilities).size !== actor.capabilities.length ||
      actor.capabilities.some((capability) => !APPLICATION_CAPABILITY_SET.has(capability)) ||
      actor.capabilities.some(
        (capability) => !APPLICATION_ACTOR_CAPABILITIES[actor.kind].has(capability),
      )
    ) {
      throw new TypeError("Dyna application actor capabilities are invalid.");
    }
    this.#actorKind = actor.kind;
    this.#capabilities = new Set(actor.capabilities);
    this.#clock = options.clock ?? (() => new Date());
    this.#repository = new SqliteDynaRepository({
      ...(options.databasePath !== undefined ? { databasePath: options.databasePath } : {}),
      clock: this.#clock,
    });
  }

  #requireCapability(capability: DynaApplicationCapability): void {
    if (!this.#capabilities.has(capability)) {
      throw new DynaApplicationCapabilityError(this.#actorKind, capability);
    }
  }

  #now(): string {
    return this.#clock().toISOString();
  }

  #taskSyncSummary(run: DynaRepositoryTaskSyncRun): DynaTaskSyncSummary {
    const active = new Set(["prepared", "delivered", "claimed", "syncing"]);
    const state = active.has(run.state)
      ? "syncing"
      : run.state === "completed"
        ? run.updatedItems > 0
          ? "updated"
          : "current"
        : run.state;
    return DynaTaskSyncSummarySchema.parse({
      runId: run.id,
      dashboardId: run.dashboardId,
      state,
      processedTasks: run.processedTasks,
      totalTasks: run.totalTasks,
      updatedItems: run.updatedItems,
      unavailableTasks: run.unavailableTasks,
      incompleteMetadataTasks: run.incompleteMetadataTasks,
      remainingTasks: Math.max(0, run.totalTasks - run.processedTasks) + run.excessTasks,
      startedAt: run.createdAt,
      ...(run.completedAt ? { completedAt: run.completedAt } : {}),
      updatedAt: run.updatedAt,
    });
  }

  #expireTaskSyncRuns(
    unitOfWork: DynaWriteUnitOfWork,
    dashboardId: string,
  ): readonly DynaRepositoryTaskSyncRun[] {
    const instant = this.#now();
    const runs = unitOfWork.listTaskSyncRuns(dashboardId, 50);
    for (const run of runs) {
      if (
        ["prepared", "delivered", "claimed", "syncing"].includes(run.state) &&
        run.expiresAt <= instant
      ) {
        unitOfWork.updateTaskSyncRun({
          ...run,
          state: "expired",
          claimTokenHash: undefined,
          leaseExpiresAt: undefined,
          updatedAt: instant,
          completedAt: instant,
        });
      }
    }
    return unitOfWork.listTaskSyncRuns(dashboardId, 50);
  }

  #taskSyncRun(unitOfWork: DynaReadUnitOfWork, runId: string): DynaRepositoryTaskSyncRun {
    const run = unitOfWork.findTaskSyncRun(runId);
    if (!run)
      throw new DynaCliError("not_found", "The Dyna task synchronization run was not found.");
    return run;
  }

  #assertTaskSyncClaim(run: DynaRepositoryTaskSyncRun, claimToken: string): void {
    const digest = sha256(claimToken);
    if (!secureDigestMatches(run.claimTokenHash, digest)) {
      throw new DynaCliError("request_conflict", "The Dyna task synchronization claim is invalid.");
    }
    const instant = this.#now();
    if (!run.leaseExpiresAt || run.leaseExpiresAt <= instant || run.expiresAt <= instant) {
      throw new DynaCliError("request_conflict", "The Dyna task synchronization claim expired.");
    }
  }

  #dashboard(unitOfWork: DynaReadUnitOfWork, dashboardId: string): DynaDashboard {
    if (!unitOfWork.findDashboardState(dashboardId)) {
      throw new DynaCliError("not_found", "Dyna dashboard was not found.");
    }
    return unitOfWork.getDashboard(dashboardId);
  }

  #assertItemMembership(unitOfWork: DynaReadUnitOfWork, dashboardId: string, itemId: string): void {
    this.#dashboard(unitOfWork, dashboardId);
    if (!unitOfWork.findItemBase(itemId)) {
      throw new DynaCliError("not_found", "Dyna item was not found.");
    }
    if (!unitOfWork.dashboardContainsItem(dashboardId, itemId)) {
      throw new DynaCliError(
        "outside_dashboard",
        "The Dyna item is outside the requested dashboard.",
      );
    }
  }

  #assertExpectedRevision(
    unitOfWork: DynaReadUnitOfWork,
    dashboardId: string,
    expectedRevision: number,
    message: string,
  ): void {
    const dashboard = unitOfWork.findDashboardState(dashboardId);
    if (dashboard?.revision !== expectedRevision) {
      throw new DynaCliError("stale_dashboard", message);
    }
  }

  #assertExpectedFingerprint(
    unitOfWork: DynaReadUnitOfWork,
    itemId: string,
    expectedFingerprint: string,
    message: string,
  ): void {
    const item = unitOfWork.findItemBase(itemId);
    if (!item) throw new DynaCliError("not_found", "Dyna item was not found.");
    if (item.fingerprint !== expectedFingerprint) {
      throw new DynaCliError("stale_item", message);
    }
  }

  #assertPublisher(unitOfWork: DynaReadUnitOfWork, publisherId: string): void {
    if (!unitOfWork.listPublishers().some((publisher) => publisher.id === publisherId)) {
      throw new DynaCliError("not_found", "Dyna publisher was not found.");
    }
  }

  #assertCanonicalTaskObservation(
    unitOfWork: DynaReadUnitOfWork,
    itemId: string,
    status: DynaTaskStatus,
  ): void {
    const item = unitOfWork.findItemBase(itemId);
    if (!item) throw new DynaCliError("not_found", "Dyna item was not found.");
    const owner = unitOfWork.findTaskOwner(status.taskId);
    if (owner && owner.itemId !== itemId) {
      throw new DynaCliError(
        "request_conflict",
        "This Codex task is already associated with another Dyna item.",
      );
    }
    if (!isCanonicalDynaTaskTitle(item.itemNumber, status.title)) {
      throw new DynaCliError(
        "invalid_input",
        `The controller-observed Codex task title must begin with ${formatDynaItemNumber(item.itemNumber)} exactly once.`,
      );
    }
  }

  #reserveTaskAssociation(
    unitOfWork: DynaWriteUnitOfWork,
    dashboardId: string,
    itemId: string,
    taskId: string,
    requestId: string,
    actionRequestId?: string,
  ): DynaTaskAssociationReservationResult {
    const owner = unitOfWork.findTaskOwner(taskId);
    if (owner?.itemId === itemId) {
      return { association: "same_item", hostId: owner.hostId };
    }
    if (owner || this.#taskAttachmentBlocker(unitOfWork, dashboardId, itemId)) {
      return { association: "not_attachable" };
    }
    const instant = this.#now();
    unitOfWork.expireTaskAssociationReservations(instant);
    const existingRequest = unitOfWork.findTaskAssociationReservation(requestId);
    if (existingRequest) {
      if (
        existingRequest.itemId !== itemId ||
        existingRequest.taskId !== taskId ||
        existingRequest.actionRequestId !== actionRequestId
      ) {
        throw new DynaCliError(
          "request_conflict",
          "This task-association reservation ID was reused for different work.",
        );
      }
      if (
        existingRequest.state === "reserved" &&
        (!existingRequest.expiresAt || existingRequest.expiresAt > instant)
      ) {
        return {
          association: "reserved",
          reservationId: requestId,
          ...(existingRequest.expiresAt ? { expiresAt: existingRequest.expiresAt } : {}),
        };
      }
      throw new DynaCliError(
        "request_conflict",
        "This task-association reservation is no longer usable; inspect the task again and reserve it with a new request ID.",
      );
    }
    const active = unitOfWork.findActiveTaskAssociationReservation(taskId);
    if (active) return { association: "not_attachable" };
    if (
      unitOfWork.countTaskBindingsForItem(itemId) +
        unitOfWork.countActiveTaskAssociationReservationsForItem(itemId) >=
      MAX_TASK_BINDINGS_PER_ITEM
    ) {
      return { association: "not_attachable" };
    }
    const expiresAt = actionRequestId
      ? undefined
      : new Date(Date.parse(instant) + TASK_ASSOCIATION_RESERVATION_MS).toISOString();
    unitOfWork.insertTaskAssociationReservation({
      requestId,
      taskId,
      itemId,
      ...(actionRequestId ? { actionRequestId } : {}),
      state: "reserved",
      ...(expiresAt ? { expiresAt } : {}),
      createdAt: instant,
      updatedAt: instant,
    });
    return {
      association: "reserved",
      reservationId: requestId,
      ...(expiresAt ? { expiresAt } : {}),
    };
  }

  #taskAssociationReservationForAttachment(
    unitOfWork: DynaWriteUnitOfWork,
    itemId: string,
    taskId: string,
    reservationId: string | undefined,
    allowUncertain = false,
  ): string | undefined {
    const owner = unitOfWork.findTaskOwner(taskId);
    if (owner?.itemId === itemId) return undefined;
    if (owner) {
      throw new DynaCliError(
        "request_conflict",
        "This Codex task cannot be associated with the requested Dyna item.",
      );
    }
    const reservation = reservationId
      ? unitOfWork.findTaskAssociationReservation(reservationId)
      : undefined;
    if (!reservation && (this.#actorKind === "trusted_local" || this.#actorKind === "controller")) {
      if (!unitOfWork.findActiveTaskAssociationReservation(taskId)) return undefined;
    }
    const instant = this.#now();
    const allowedState =
      reservation?.state === "reserved" || (allowUncertain && reservation?.state === "uncertain");
    if (
      reservation?.itemId !== itemId ||
      reservation.taskId !== taskId ||
      !allowedState ||
      (reservation.expiresAt !== undefined && reservation.expiresAt <= instant)
    ) {
      throw new DynaCliError(
        "request_conflict",
        "The task-association reservation is missing, expired, or belongs to another item.",
      );
    }
    return reservation.requestId;
  }

  #canonicalMutation<T extends { readonly deduplicated: boolean }>(
    dashboardId: string,
    itemId: string,
    requestId: string,
    operation: string,
    request: unknown,
    parseResult: (value: unknown, unitOfWork: DynaReadUnitOfWork) => T,
    mutate: (unitOfWork: DynaWriteUnitOfWork) => T,
  ): T {
    const requestHash = sha256(canonicalJson([operation, dashboardId, itemId, request]));
    return this.#repository.write((unitOfWork) => {
      const existing = unitOfWork.findCliReceipt(requestId);
      if (existing) {
        if (
          existing.dashboardId !== dashboardId ||
          existing.operation !== operation ||
          existing.itemId !== itemId ||
          existing.requestHash !== requestHash
        ) {
          throw new DynaCliError(
            "request_conflict",
            "This Dyna request ID was already used for different input.",
          );
        }
        return parseResult(
          { ...parseResult(existing.result, unitOfWork), deduplicated: true },
          unitOfWork,
        );
      }
      const dashboard = unitOfWork.findDashboardState(dashboardId);
      if (!dashboard) throw new DynaCliError("not_found", "Dyna dashboard was not found.");
      if (dashboard.archived) {
        throw new DynaCliError("not_found", "Dyna dashboard is archived.");
      }
      const item = unitOfWork.findItemBase(itemId);
      if (!item) throw new DynaCliError("not_found", "Dyna item was not found.");
      if (!unitOfWork.dashboardContainsItem(dashboardId, itemId)) {
        throw new DynaCliError(
          "outside_dashboard",
          "The Dyna item is outside the requested dashboard.",
        );
      }
      const result = parseResult(mutate(unitOfWork), unitOfWork);
      unitOfWork.insertCliReceipt(
        requestId,
        { dashboardId, operation, itemId, requestHash, result },
        this.#now(),
      );
      return result;
    });
  }

  #positionedItem(
    unitOfWork: DynaReadUnitOfWork,
    dashboardId: string,
    itemId: string,
  ): DynaCliPositionedItem | undefined {
    return this.#positionedItems(unitOfWork, dashboardId).find((item) => item.id === itemId);
  }

  #positionedItems(
    unitOfWork: DynaReadUnitOfWork,
    dashboardId: string,
  ): readonly DynaCliPositionedItem[] {
    return sortProjectedItems(
      projectRepositoryItems(unitOfWork.listProjectionItems(dashboardId)),
    ).map(({ fact, projection, priorityPosition }) => ({
      id: fact.id,
      fingerprint: fact.fingerprint,
      effectivePriority: projection.effectivePriority,
      priorityPosition,
      workflowState: projection.workflowState,
      ...(fact.preferenceSequence !== undefined
        ? { preferenceSequence: fact.preferenceSequence }
        : {}),
      ...(fact.userWorkflow?.outcome ? { userWorkflowOutcome: fact.userWorkflow.outcome } : {}),
      ...(fact.userWorkflow ? { userWorkflowCreatedMs: fact.userWorkflow.createdAtMs } : {}),
    }));
  }

  #placeProjectedItem(
    unitOfWork: DynaWriteUnitOfWork,
    dashboardId: string,
    positioned: readonly DynaCliPositionedItem[],
    itemId: string,
    targetPriority: DynaPriority,
    beforeItemId: string | undefined,
    auditSuffix: string,
  ): { readonly changed: boolean; readonly action?: "bump" | "lower" | "earlier" | "later" } {
    const source = positioned.find((candidate) => candidate.id === itemId);
    if (!source) throw new DynaCliError("not_found", "The Dyna item is no longer active.");
    if (beforeItemId === itemId) return { changed: false };
    const currentGroup = positioned.filter(
      (candidate) =>
        candidate.workflowState !== "completed" &&
        candidate.effectivePriority === source.effectivePriority,
    );
    const targetGroup = positioned.filter(
      (candidate) =>
        candidate.workflowState !== "completed" &&
        candidate.effectivePriority === targetPriority &&
        candidate.id !== itemId,
    );
    const insertAt = beforeItemId
      ? targetGroup.findIndex((candidate) => candidate.id === beforeItemId)
      : targetGroup.length;
    if (beforeItemId && insertAt < 0) {
      throw new DynaCliError(
        "stale_dashboard",
        "The queue target changed; refresh before moving this item.",
      );
    }
    targetGroup.splice(insertAt, 0, source);
    const currentIds = currentGroup.map(({ id }) => id);
    const nextIds = targetGroup.map(({ id }) => id);
    const changed =
      source.effectivePriority !== targetPriority || currentIds.join("\n") !== nextIds.join("\n");
    if (!changed) return { changed: false };
    const action =
      source.effectivePriority !== targetPriority
        ? PRIORITIES.indexOf(targetPriority) < PRIORITIES.indexOf(source.effectivePriority)
          ? "bump"
          : "lower"
        : nextIds.indexOf(itemId) < currentIds.indexOf(itemId)
          ? "earlier"
          : "later";
    const instant = this.#now();
    unitOfWork.writePlacements(
      dashboardId,
      targetGroup.map((candidate, position) => ({
        itemId: candidate.id,
        priority: targetPriority,
        ...(candidate.id === itemId ? { priorityOverride: targetPriority } : {}),
        sequence: position * 100,
        action: candidate.id === itemId ? action : "resequence",
      })),
      instant,
    );
    unitOfWork.touchDashboards([dashboardId], instant);
    unitOfWork.appendAudit(`item.organized.${action}.${auditSuffix}`, itemId, instant);
    return { changed: true, action };
  }

  #placeProjectedItemsAsBlock(
    unitOfWork: DynaWriteUnitOfWork,
    dashboardId: string,
    positioned: readonly DynaCliPositionedItem[],
    items: readonly { readonly itemId: string; readonly expectedFingerprint: string }[],
    targetPriority: DynaPriority,
    auditSuffix: string,
    includeTargetSelection = true,
  ): { readonly changed: boolean; readonly changedCount: number } {
    if (items.length === 0 || items.length > 200) {
      throw new DynaCliError(
        "invalid_input",
        "Select between 1 and 200 Dyna items to change their priority group.",
      );
    }
    const uniqueIds = new Set(items.map(({ itemId }) => itemId));
    if (uniqueIds.size !== items.length) {
      throw new DynaCliError(
        "invalid_input",
        "Each Dyna item can appear only once in a bulk priority change.",
      );
    }
    const activeById = new Map(
      positioned
        .filter((candidate) => candidate.workflowState !== "completed")
        .map((candidate) => [candidate.id, candidate] as const),
    );
    for (const selected of items) {
      const candidate = activeById.get(selected.itemId);
      if (!candidate) {
        throw new DynaCliError(
          "invalid_input",
          "Only active, unfinished queue items can change priority group.",
        );
      }
      if (candidate.fingerprint !== selected.expectedFingerprint) {
        throw new DynaCliError(
          "stale_item",
          "A selected Dyna item changed; refresh before moving these items.",
        );
      }
    }
    const orderedSelection = items
      .map(({ itemId }) => activeById.get(itemId))
      .filter((candidate): candidate is DynaCliPositionedItem => candidate !== undefined)
      .filter(
        (candidate) => includeTargetSelection || candidate.effectivePriority !== targetPriority,
      )
      .sort(
        (left, right) =>
          PRIORITIES.indexOf(left.effectivePriority) -
            PRIORITIES.indexOf(right.effectivePriority) ||
          left.priorityPosition - right.priorityPosition ||
          left.id.localeCompare(right.id),
      );
    const selectedIds = new Set(orderedSelection.map(({ id }) => id));
    const targetGroup = positioned.filter(
      (candidate) =>
        candidate.workflowState !== "completed" && candidate.effectivePriority === targetPriority,
    );
    const currentTargetIds = targetGroup.map(({ id }) => id);
    const nextTargetGroup = [
      ...targetGroup.filter((candidate) => !selectedIds.has(candidate.id)),
      ...orderedSelection,
    ];
    const nextTargetIds = nextTargetGroup.map(({ id }) => id);
    const changedSelectionIds = new Set(
      orderedSelection
        .filter(
          (candidate) =>
            candidate.effectivePriority !== targetPriority ||
            currentTargetIds.indexOf(candidate.id) !== nextTargetIds.indexOf(candidate.id),
        )
        .map(({ id }) => id),
    );
    if (changedSelectionIds.size === 0) return { changed: false, changedCount: 0 };
    const writes: DynaCliPlacementWrite[] = nextTargetGroup.map((candidate, position) => {
      const isSelected = selectedIds.has(candidate.id);
      const action = isSelected
        ? candidate.effectivePriority !== targetPriority
          ? PRIORITIES.indexOf(targetPriority) < PRIORITIES.indexOf(candidate.effectivePriority)
            ? "bump"
            : "lower"
          : changedSelectionIds.has(candidate.id)
            ? nextTargetIds.indexOf(candidate.id) < currentTargetIds.indexOf(candidate.id)
              ? "earlier"
              : "later"
            : "resequence"
        : "resequence";
      return {
        itemId: candidate.id,
        priority: targetPriority,
        ...(isSelected ? { priorityOverride: targetPriority } : {}),
        sequence: position * 100,
        action,
      };
    });
    const instant = this.#now();
    unitOfWork.writePlacements(dashboardId, writes, instant);
    unitOfWork.touchDashboards([dashboardId], instant);
    for (const itemId of changedSelectionIds) {
      unitOfWork.appendAudit(`item.organized.group.${auditSuffix}`, itemId, instant);
    }
    return { changed: true, changedCount: changedSelectionIds.size };
  }

  #taskAttachmentBlocker(
    unitOfWork: DynaReadUnitOfWork,
    dashboardId: string,
    itemId: string,
  ): DynaTaskAttachmentBlocker | undefined {
    if (unitOfWork.findOpenArchive(dashboardId, itemId)) {
      return {
        code: "archived_item",
        message:
          "A new Codex task cannot be attached to an archived Dyna item; restore it or create a follow-up.",
      };
    }
    const active = this.#positionedItem(unitOfWork, dashboardId, itemId);
    if (!active) {
      return {
        code: "outside_dashboard",
        message: "A new Codex task cannot be attached because the Dyna item is no longer active.",
      };
    }
    if (active.workflowState === "completed") {
      return {
        code: "completed_item",
        message: "A new Codex task cannot be attached to completed Dyna work; create a follow-up.",
      };
    }
    return undefined;
  }

  #taskAttachmentBlockerForAction(
    unitOfWork: DynaReadUnitOfWork,
    requestId: string,
  ): DynaTaskAttachmentBlocker | undefined {
    const action = unitOfWork.loadAction(requestId);
    const itemId = action.itemId;
    if (!itemId || (action.kind !== "create_codex_task" && action.kind !== "attach_codex_task")) {
      return undefined;
    }
    return this.#taskAttachmentBlocker(unitOfWork, action.dashboardId, itemId);
  }

  #archiveExpiredCompleted(
    unitOfWork: DynaWriteUnitOfWork,
    dashboardId: string,
    items: readonly ProjectedRepositoryItem[],
    now: Date,
  ): readonly ProjectedRepositoryItem[] {
    const dashboard = unitOfWork.getDashboard(dashboardId);
    const cutoff = now.getTime() - dashboard.doneRetentionHours * HOUR_MS;
    const expired = items.filter(({ fact, projection }) => {
      if (projection.workflowState !== "completed") return false;
      const completionAt =
        projection.completedAtMs ?? fact.userWorkflow?.createdAtMs ?? fact.sourceUpdatedAtMs;
      return Math.max(completionAt, fact.lastRestoredAtMs ?? 0) <= cutoff;
    });
    if (expired.length === 0) return items;
    const instant = now.toISOString();
    for (const { fact, projection } of expired) {
      unitOfWork.insertArchive({
        id: randomUUID(),
        dashboardId,
        itemId: fact.id,
        reason: "completed",
        mode: "automatic",
        archivedAt: instant,
        fingerprint: fact.fingerprint,
        workflowState: "completed",
        ...(projection.completedAtMs !== undefined
          ? { completedAtMs: projection.completedAtMs }
          : {}),
        ...(projection.outcome ? { outcome: projection.outcome } : {}),
        priority: projection.effectivePriority,
        ...(fact.preferenceSequence !== undefined ? { sequence: fact.preferenceSequence } : {}),
      });
      unitOfWork.appendAudit("item.archived.completed.automatic", fact.id, instant);
    }
    unitOfWork.touchDashboards([dashboardId], instant);
    return projectRepositoryItems(unitOfWork.listProjectionItems(dashboardId));
  }

  #cardFromProjection(
    value: ProjectedRepositoryItem,
    evidence: DynaRepositoryCardEvidence,
  ): DynaCard {
    const { fact, item, projection, priorityPosition, priorityCount } = value;
    const displayedLeadershipScore = dynaLeadershipScore(item.people);
    const priorityMode: DynaCard["priorityMode"] = fact.preferencePriority
      ? "manual"
      : projection.effectivePriority !== item.priority
        ? "leadership"
        : item.priority !== fact.base.priority
          ? "enrichment"
          : "source";
    return {
      id: fact.id,
      itemNumber: fact.itemNumber,
      fingerprint: fact.fingerprint,
      source: item.sourceRef.source,
      sourceRef: item.sourceRef,
      sourceLabel: dynaSourceLabel(item.sourceRef),
      title: item.title,
      summary: item.summary,
      sourcePriority: fact.base.priority,
      priority: projection.effectivePriority,
      priorityReason: item.priorityReason,
      sourceUpdatedAt: item.sourceUpdatedAt,
      ...(item.dueAt ? { dueAt: item.dueAt } : {}),
      labels: item.labels,
      people: item.people,
      leadershipScore: displayedLeadershipScore,
      priorityMode,
      ...(fact.preferenceSequence !== undefined ? { sequence: fact.preferenceSequence } : {}),
      canMoveEarlier: priorityPosition > 1,
      canMoveLater: priorityPosition < priorityCount,
      workflowState: projection.workflowState,
      ...(projection.completedAt ? { completedAt: projection.completedAt } : {}),
      ...(projection.outcome ? { outcome: projection.outcome } : {}),
      ...(fact.followUpOfItemId ? { followUpOfItemId: fact.followUpOfItemId } : {}),
      ...(fact.followUpOfItemNumber ? { followUpOfItemNumber: fact.followUpOfItemNumber } : {}),
      ...(item.attention ? { attention: item.attention } : {}),
      plan: item.plan,
      nextSteps: item.nextSteps,
      ...(fact.enrichment
        ? {
            enrichmentState:
              fact.enrichment.baseFingerprint === fact.fingerprint ? "active" : "stale",
          }
        : {}),
      annotations: [...evidence.annotations],
      workUpdates: [...evidence.workUpdates],
      workUpdateCount: evidence.workUpdateCount,
      ...(projection.workflowState !== "completed" && projection.workState
        ? { workState: projection.workState }
        : {}),
      ...(projection.workflowState !== "completed" && projection.workConditionSummary
        ? { workConditionSummary: projection.workConditionSummary }
        : {}),
      ...(projection.workflowState !== "completed" && projection.workConditionTask
        ? { workConditionTask: projection.workConditionTask }
        : {}),
      ...(evidence.matchedActivity
        ? { matchedActivity: evidence.matchedActivity.slice(0, 500) }
        : {}),
      blocked: projection.workflowState !== "completed" && projection.blocked,
      titleSyncNeeded: taskTitleSyncNeeded(fact.itemNumber, evidence.linkedTasks),
      linkedTasks: [...evidence.linkedTasks],
      ...(fact.archive ? { archive: fact.archive } : {}),
    };
  }

  #touchItemDashboards(unitOfWork: DynaWriteUnitOfWork, itemId: string, instant: string): void {
    unitOfWork.touchDashboards(unitOfWork.listDashboardIdsForItem(itemId), instant);
  }

  #ensureManualPublisher(
    unitOfWork: DynaWriteUnitOfWork,
    dashboardId: string,
    instant: string,
  ): string {
    const existing = unitOfWork.findManualPublisher(dashboardId);
    if (existing) return existing;
    if (unitOfWork.countPublishers() >= MAX_PUBLISHERS) {
      throw new DynaCliError("invalid_input", "Dyna cannot create more than 100 publishers.");
    }
    const publisherId = randomUUID();
    unitOfWork.insertManualPublisher(dashboardId, publisherId, instant);
    return publisherId;
  }

  #createManualItem(
    unitOfWork: DynaWriteUnitOfWork,
    dashboardId: string,
    todo: DynaTodoInput,
    reason: string,
    fallbackSummary: string,
    followUpOfItemId?: string,
  ): {
    readonly itemId: string;
    readonly itemNumber: DynaItemNumber;
    readonly fingerprint: string;
    readonly instant: string;
  } {
    const instant = this.#now();
    const publisherId = this.#ensureManualPublisher(unitOfWork, dashboardId, instant);
    const todoId = randomUUID();
    const published = DynaPublishedItemSchema.parse({
      externalId: todoId,
      sourceRef: { source: "manual", todoId },
      sourceScope: `manual:${dashboardId}`,
      title: todo.title,
      summary: todo.summary ?? fallbackSummary,
      priority: todo.priority,
      priorityReason: reason,
      sourceUpdatedAt: instant,
      labels: todo.labels,
      people: [],
      ...(todo.attention ? { attention: todo.attention } : {}),
      plan: [],
      nextSteps: [],
    });
    const itemId = randomUUID();
    const fingerprint = sha256(JSON.stringify(published));
    const record: DynaCliManualItemInsert = {
      itemId,
      publisherId,
      published,
      fingerprint,
      instant,
      ...(followUpOfItemId ? { followUpOfItemId } : {}),
    };
    unitOfWork.insertManualItem(record);
    const itemNumber = unitOfWork.findItemBase(itemId)?.itemNumber;
    if (!itemNumber) throw new Error("Dyna could not allocate an item number.");
    return { itemId, itemNumber, fingerprint, instant };
  }

  #createTodoWithReceipt(
    unitOfWork: DynaWriteUnitOfWork,
    dashboardId: string,
    todo: DynaTodoInput,
    requestId: string,
  ): DynaTodoCreateResult {
    const requestHash = sha256(JSON.stringify(todo));
    const existing = unitOfWork.findTodoReceipt(dashboardId, requestId);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new DynaCliError(
          "request_conflict",
          "This Dyna to-do request ID was reused with different content.",
        );
      }
      const item = unitOfWork.findItemBase(existing.itemId);
      if (!item) throw new Error("Dyna to-do receipt refers to a missing item.");
      return DynaTodoCreateResultSchema.parse({
        schema: "dyna/todo-create-result-v2",
        requestId,
        itemId: existing.itemId,
        itemNumber: item.itemNumber,
        fingerprint: item.fingerprint,
        deduplicated: true,
      });
    }
    const dashboard = unitOfWork.findDashboardState(dashboardId);
    if (!dashboard || dashboard.archived) {
      throw new DynaCliError("not_found", "Dyna dashboard was not found.");
    }
    if (
      todo.followUpOfItemId &&
      !unitOfWork.dashboardContainsItem(dashboardId, todo.followUpOfItemId)
    ) {
      throw new DynaCliError(
        "outside_dashboard",
        "The follow-up source is outside this dashboard view.",
      );
    }
    const created = this.#createManualItem(
      unitOfWork,
      dashboardId,
      todo,
      "Manually added to your priority queue.",
      "Added from Dyna and ready to prioritize.",
      todo.followUpOfItemId,
    );
    unitOfWork.insertTodoReceipt(dashboardId, requestId, requestHash, created.itemId);
    unitOfWork.touchDashboards([dashboardId], created.instant);
    unitOfWork.appendAudit("todo.created", created.itemId, created.instant);
    return DynaTodoCreateResultSchema.parse({
      schema: "dyna/todo-create-result-v2",
      requestId,
      itemId: created.itemId,
      itemNumber: created.itemNumber,
      fingerprint: created.fingerprint,
      deduplicated: false,
    });
  }

  #materializeSnapshot(
    dashboardId: string,
    query = "",
    scope: DynaItemSearchScope = "active",
  ): DynaDashboardSnapshot {
    return this.#repository.write((unitOfWork) => {
      const normalizedQuery = query.trim().slice(0, 500);
      const terms = snapshotSearchTerms(normalizedQuery);
      const now = this.#clock();
      const dashboardState = unitOfWork.findDashboardState(dashboardId);
      if (!dashboardState) throw new DynaCliError("not_found", "Dyna dashboard was not found.");
      const dashboard = unitOfWork.getDashboard(dashboardId);
      const taskSyncRun = this.#expireTaskSyncRuns(unitOfWork, dashboardId)[0];
      let active = projectRepositoryItems(unitOfWork.listProjectionItems(dashboardId, "active"));
      active = this.#archiveExpiredCompleted(unitOfWork, dashboardId, active, now);
      const archived = projectRepositoryItems(
        unitOfWork.listProjectionItems(dashboardId, "archive"),
      );
      const activeMatches =
        terms.length === 0
          ? new Set(active.map(({ fact }) => fact.id))
          : unitOfWork.matchingProjectionItemIds(dashboardId, "active", terms);
      const archiveMatches =
        terms.length === 0
          ? new Set(archived.map(({ fact }) => fact.id))
          : unitOfWork.matchingProjectionItemIds(dashboardId, "archive", terms);
      const matchingActive = active.filter(({ fact }) => activeMatches.has(fact.id));
      const matchingArchived = archived.filter(({ fact }) => archiveMatches.has(fact.id));
      const sorted = sortProjectedItems(scope === "archive" ? matchingArchived : matchingActive);
      const exactItemNumber = exactItemNumberQuery(normalizedQuery);
      const selected = (
        exactItemNumber === undefined
          ? sorted
          : [
              ...sorted.filter(({ fact }) => fact.itemNumber === exactItemNumber),
              ...sorted.filter(({ fact }) => fact.itemNumber !== exactItemNumber),
            ]
      ).slice(0, MAX_SNAPSHOT_CARDS);
      const evidenceById = new Map(
        unitOfWork
          .loadCardEvidence(
            selected.map(({ fact }) => fact.id),
            terms,
          )
          .map((evidence) => [evidence.itemId, evidence] as const),
      );
      const cards = selected.map((value) => {
        const evidence = evidenceById.get(value.fact.id);
        if (!evidence) throw new Error("Dyna could not load projected card evidence.");
        return this.#cardFromProjection(value, evidence);
      });
      const schedules = unitOfWork.listPublishers(dashboardId);
      const relevantSchedules = schedules.filter(
        (schedule) =>
          schedule.scheduleState === "active" ||
          schedule.lastRunStatus === "never" ||
          Boolean(schedule.revokedAt),
      );
      const scheduleFreshness = relevantSchedules.map((schedule) => {
        if (
          schedule.revokedAt ||
          schedule.lastRunStatus === "never" ||
          schedule.lastRunStatus === "failed" ||
          schedule.lastRunStatus === "partial" ||
          !schedule.lastRunAt
        ) {
          return "stale" as const;
        }
        const age = Math.max(0, now.getTime() - Date.parse(schedule.lastRunAt));
        const staleAfter = schedule.staleAfterMinutes * 60_000;
        return age > staleAfter
          ? ("stale" as const)
          : age > staleAfter * 0.75
            ? ("aging" as const)
            : ("fresh" as const);
      });
      const newest = matchingActive.reduce(
        (latest, { fact }) => Math.max(latest, fact.sourceUpdatedAtMs),
        Number.NEGATIVE_INFINITY,
      );
      const unscheduledAge = Number.isFinite(newest)
        ? Math.max(0, now.getTime() - newest)
        : Number.POSITIVE_INFINITY;
      const freshness = scheduleFreshness.includes("stale")
        ? "stale"
        : scheduleFreshness.includes("aging")
          ? "aging"
          : scheduleFreshness.length > 0
            ? "fresh"
            : unscheduledAge <= 15 * 60_000
              ? "fresh"
              : unscheduledAge <= 60 * 60_000
                ? "aging"
                : "stale";
      return DynaDashboardSnapshotSchema.parse({
        schema: "dyna/snapshot-v7",
        dashboard,
        generatedAt: now.toISOString(),
        query: normalizedQuery,
        scope,
        revision: dashboardState.revision,
        freshness,
        counts: {
          critical: matchingActive.filter(
            ({ projection }) =>
              projection.workflowState !== "completed" &&
              projection.effectivePriority === "critical",
          ).length,
          high: matchingActive.filter(
            ({ projection }) =>
              projection.workflowState !== "completed" && projection.effectivePriority === "high",
          ).length,
          leadership: matchingActive.filter(
            ({ projection }) => projection.effectiveLeadershipScore > 0,
          ).length,
          total: matchingActive.length,
          archived: matchingArchived.length,
          blocked: matchingActive.filter(
            ({ projection }) => projection.workflowState !== "completed" && projection.blocked,
          ).length,
        },
        schedules,
        cards,
        ...(taskSyncRun ? { taskSync: this.#taskSyncSummary(taskSyncRun) } : {}),
      });
    });
  }

  projectItemState(input: DynaItemProjectionInput): DynaItemProjection {
    return projectDynaItemState(input);
  }

  close(): void {
    this.#repository.close();
  }

  backup(destinationPath: string): string {
    this.#requireCapability("maintenance:backup");
    return this.#repository.backup(destinationPath);
  }

  render(dashboardId: string): DynaUiPayload {
    this.#requireCapability("view:interact");
    const snapshot = this.#materializeSnapshot(dashboardId);
    const viewToken = this.#repository.write((unitOfWork) =>
      unitOfWork.persistCreateView(dashboardId),
    );
    return DynaUiPayloadSchema.parse({
      schema: "dyna/ui-v9",
      viewToken,
      snapshot,
    });
  }

  refresh(viewToken: string, query = "", scope: DynaItemSearchScope = "active"): DynaUiPayload {
    this.#requireCapability("view:interact");
    const dashboardId = this.#repository.write((unitOfWork) =>
      unitOfWork.authorizeViewToken(viewToken),
    );
    const snapshot = this.#materializeSnapshot(dashboardId, query, scope);
    return DynaUiPayloadSchema.parse({ schema: "dyna/ui-v9", viewToken, snapshot });
  }

  snapshot(
    dashboardId: string,
    query = "",
    scope: DynaItemSearchScope = "active",
  ): DynaDashboardSnapshot {
    this.#requireCapability("dashboard:read");
    return DynaDashboardSnapshotSchema.parse(this.#materializeSnapshot(dashboardId, query, scope));
  }

  beginTaskSyncForView(
    viewToken: string,
    scope: DynaTaskSyncScope = { kind: "dashboard" },
  ): DynaTaskSyncBeginResult {
    this.#requireCapability("view:interact");
    const parsedScope = DynaTaskSyncScopeSchema.parse(scope);
    return this.#repository.write((unitOfWork) => {
      const dashboardId = unitOfWork.authorizeViewToken(
        viewToken,
        parsedScope.kind === "task" ? parsedScope.itemId : undefined,
      );
      const dashboard = unitOfWork.findDashboardState(dashboardId);
      if (!dashboard || dashboard.archived) {
        throw new DynaCliError("not_found", "Dyna dashboard was not found.");
      }
      const runs = this.#expireTaskSyncRuns(unitOfWork, dashboardId);
      const active = runs.find((run) =>
        ["prepared", "delivered", "claimed", "syncing"].includes(run.state),
      );
      if (active) {
        const instant = this.#now();
        const leaseExpired = !active.leaseExpiresAt || active.leaseExpiresAt <= instant;
        const deliveryRequired = leaseExpired;
        let joined = active;
        if (deliveryRequired) {
          const leaseExpiresAt = new Date(
            Math.min(
              Date.parse(active.expiresAt),
              Date.parse(instant) + TASK_SYNC_DELIVERY_RESERVATION_MS,
            ),
          ).toISOString();
          if (active.state === "claimed" || active.state === "syncing") {
            const unclaimed = { ...active };
            delete unclaimed.claimTokenHash;
            joined = {
              ...unclaimed,
              state: "prepared",
              leaseExpiresAt,
              updatedAt: instant,
            };
          } else {
            joined = { ...active, leaseExpiresAt, updatedAt: instant };
          }
        }
        if (joined !== active) unitOfWork.updateTaskSyncRun(joined);
        return DynaTaskSyncBeginResultSchema.parse({
          schema: "dyna/task-sync-begin-result-v1",
          joined: true,
          deliveryRequired,
          summary: this.#taskSyncSummary(joined),
        });
      }
      if (parsedScope.kind === "task") {
        this.#assertItemMembership(unitOfWork, dashboardId, parsedScope.itemId);
        const owner = unitOfWork.findTaskOwner(parsedScope.taskId);
        if (owner?.itemId !== parsedScope.itemId || owner.hostId !== parsedScope.hostId) {
          throw new DynaCliError(
            "task_not_linked",
            "The requested Codex task is not linked to this Dyna item and host.",
          );
        }
      }
      const selected = unitOfWork.listTaskSyncCandidates(
        dashboardId,
        parsedScope,
        MAX_TASK_SYNC_TARGETS,
      );
      if (parsedScope.kind === "task" && selected.total !== 1) {
        throw new DynaCliError(
          "task_not_linked",
          "The requested Codex task is not active in this Dyna dashboard.",
        );
      }
      const instant = this.#now();
      const terminal = selected.candidates.length === 0;
      const run: DynaRepositoryTaskSyncRun = {
        id: randomUUID(),
        dashboardId,
        scope: parsedScope,
        state: terminal ? "completed" : "prepared",
        expiresAt: new Date(Date.parse(instant) + TASK_SYNC_RUN_TTL_MS).toISOString(),
        totalTasks: selected.candidates.length,
        excessTasks: Math.max(0, selected.total - selected.candidates.length),
        processedTasks: 0,
        updatedItems: 0,
        unavailableTasks: 0,
        incompleteMetadataTasks: 0,
        createdAt: instant,
        updatedAt: instant,
        ...(!terminal
          ? {
              leaseExpiresAt: new Date(
                Date.parse(instant) + TASK_SYNC_DELIVERY_RESERVATION_MS,
              ).toISOString(),
            }
          : {}),
        ...(terminal ? { completedAt: instant } : {}),
      };
      unitOfWork.insertTaskSyncRun(run);
      unitOfWork.insertTaskSyncTargets(run.id, selected.candidates);
      unitOfWork.appendAudit("task-sync.started", run.id, instant);
      return DynaTaskSyncBeginResultSchema.parse({
        schema: "dyna/task-sync-begin-result-v1",
        joined: false,
        deliveryRequired: !terminal,
        summary: this.#taskSyncSummary(run),
      });
    });
  }

  markTaskSyncDeliveredForView(viewToken: string, runId: string): DynaTaskSyncStatusResult {
    this.#requireCapability("view:interact");
    const parsedRunId = z.uuid().parse(runId);
    return this.#repository.write((unitOfWork) => {
      const run = this.#taskSyncRun(unitOfWork, parsedRunId);
      const dashboardId = unitOfWork.authorizeViewToken(viewToken);
      if (run.dashboardId !== dashboardId) {
        throw new DynaCliError("outside_dashboard", "The task sync belongs to another dashboard.");
      }
      const [current] = this.#expireTaskSyncRuns(unitOfWork, dashboardId).filter(
        (candidate) => candidate.id === parsedRunId,
      );
      if (!current) throw new DynaCliError("not_found", "The task sync was not found.");
      const instant = this.#now();
      const delivered =
        current.state === "prepared" || current.state === "delivered"
          ? {
              ...current,
              state: "delivered" as const,
              leaseExpiresAt: new Date(
                Math.min(
                  Date.parse(current.expiresAt),
                  Date.parse(instant) + TASK_SYNC_DELIVERY_RESERVATION_MS,
                ),
              ).toISOString(),
              updatedAt: instant,
            }
          : current;
      if (delivered !== current) unitOfWork.updateTaskSyncRun(delivered);
      return DynaTaskSyncStatusResultSchema.parse({
        schema: "dyna/task-sync-status-result-v1",
        summary: this.#taskSyncSummary(delivered),
      });
    });
  }

  taskSyncStatusForView(viewToken: string, runId: string): DynaTaskSyncStatusResult {
    this.#requireCapability("view:interact");
    const parsedRunId = z.uuid().parse(runId);
    return this.#repository.write((unitOfWork) => {
      const dashboardId = unitOfWork.authorizeViewToken(viewToken);
      const run = this.#expireTaskSyncRuns(unitOfWork, dashboardId).find(
        (candidate) => candidate.id === parsedRunId,
      );
      if (!run) throw new DynaCliError("not_found", "The task sync was not found.");
      return DynaTaskSyncStatusResultSchema.parse({
        schema: "dyna/task-sync-status-result-v1",
        summary: this.#taskSyncSummary(run),
      });
    });
  }

  claimTaskSync(runId: string): DynaTaskSyncClaim {
    this.#requireCapability("action:execute");
    this.#requireCapability("task:observe");
    const parsedRunId = z.uuid().parse(runId);
    return this.#repository.write((unitOfWork) => {
      let run = this.#taskSyncRun(unitOfWork, parsedRunId);
      const instant = this.#now();
      if (run.expiresAt <= instant) {
        if (["prepared", "delivered", "claimed", "syncing"].includes(run.state)) {
          run = { ...run, state: "expired", updatedAt: instant, completedAt: instant };
          unitOfWork.updateTaskSyncRun(run);
        }
        throw new DynaCliError("request_conflict", "The Dyna task synchronization run expired.");
      }
      const reclaimable =
        (run.state === "claimed" || run.state === "syncing") &&
        Boolean(run.leaseExpiresAt && run.leaseExpiresAt <= instant);
      if (run.state !== "delivered" && !reclaimable) {
        throw new DynaCliError("request_conflict", "The Dyna task sync cannot be claimed.");
      }
      const claimToken = randomBytes(32).toString("hex");
      const leaseExpiresAt = new Date(
        Math.min(Date.parse(run.expiresAt), Date.parse(instant) + TASK_SYNC_CLAIM_LEASE_MS),
      ).toISOString();
      run = {
        ...run,
        state: "claimed",
        claimTokenHash: sha256(claimToken),
        leaseExpiresAt,
        updatedAt: instant,
      };
      unitOfWork.updateTaskSyncRun(run);
      const targets = unitOfWork
        .listTaskSyncTargets(run.id)
        .filter((target) => target.state === "pending")
        .map((target) => ({
          itemId: target.itemId,
          itemNumber: target.itemNumber,
          taskId: target.taskId,
          hostId: target.hostId,
          checkpointVersion: target.checkpointVersion,
          ...(target.cursor ? { afterCursor: target.cursor } : {}),
          ...(target.lastTurnId ? { lastTurnId: target.lastTurnId } : {}),
          expectedTitle: canonicalDynaTaskTitle(target.itemNumber, target.taskTitle),
        }));
      return DynaTaskSyncClaimSchema.parse({
        schema: "dyna/task-sync-claim-v1",
        runId: run.id,
        dashboardId: run.dashboardId,
        claimToken,
        leaseExpiresAt,
        totalTasks: run.totalTasks,
        remainingTasks: targets.length + run.excessTasks,
        targets,
      });
    });
  }

  submitTaskSyncBatch(
    runId: string,
    claimToken: string,
    input: DynaTaskSyncBatchInput,
  ): DynaTaskSyncBatchResult {
    this.#requireCapability("action:execute");
    this.#requireCapability("task:observe");
    const parsedRunId = z.uuid().parse(runId);
    const parsed = DynaTaskSyncBatchInputSchema.parse(input);
    const requestHash = sha256(canonicalJson([parsedRunId, parsed]));
    const receiptId = `task-sync-batch:${parsed.requestId}`;
    return this.#repository.write((unitOfWork) => {
      const replay = unitOfWork.findTaskSyncReceipt(receiptId);
      if (replay) {
        if (replay.runId !== parsedRunId || replay.requestHash !== requestHash) {
          throw new DynaCliError(
            "request_conflict",
            "This task sync batch request ID was reused for different input.",
          );
        }
        return DynaTaskSyncBatchResultSchema.parse({
          ...(replay.result as object),
          deduplicated: true,
        });
      }
      let run = this.#taskSyncRun(unitOfWork, parsedRunId);
      this.#assertTaskSyncClaim(run, claimToken);
      if (run.state !== "claimed" && run.state !== "syncing") {
        throw new DynaCliError("request_conflict", "The task sync no longer accepts batches.");
      }
      const targets = new Map(
        unitOfWork.listTaskSyncTargets(run.id).map((target) => [target.taskId, target] as const),
      );
      for (const observation of parsed.observations) {
        const target = targets.get(observation.taskId);
        if (target?.state !== "pending") {
          throw new DynaCliError("request_conflict", "A task sync target was already submitted.");
        }
        if (target.checkpointVersion !== observation.checkpointVersion) {
          throw new DynaCliError("request_conflict", "A task sync checkpoint is stale.");
        }
        if (!unitOfWork.stageTaskSyncObservation(run.id, target.taskId, observation)) {
          throw new DynaCliError("request_conflict", "A task sync target was already submitted.");
        }
      }
      for (const unavailable of parsed.unavailable) {
        const target = targets.get(unavailable.taskId);
        if (
          target?.state !== "pending" ||
          target.hostId !== unavailable.hostId ||
          target.checkpointVersion !== unavailable.checkpointVersion
        ) {
          throw new DynaCliError("request_conflict", "An unavailable task target is stale.");
        }
        if (!unitOfWork.stageTaskSyncUnavailable(run.id, target.taskId, unavailable.reason)) {
          throw new DynaCliError("request_conflict", "A task sync target was already submitted.");
        }
      }
      const acceptedTasks = parsed.observations.length + parsed.unavailable.length;
      const coverageFailures = parsed.observations.filter(
        (observation) => observation.summaryCoverage === "unavailable",
      ).length;
      const instant = this.#now();
      const leaseExpiresAt = new Date(
        Math.min(Date.parse(run.expiresAt), Date.parse(instant) + TASK_SYNC_CLAIM_LEASE_MS),
      ).toISOString();
      run = {
        ...run,
        state: "syncing",
        processedTasks: run.processedTasks + acceptedTasks,
        unavailableTasks: run.unavailableTasks + parsed.unavailable.length + coverageFailures,
        leaseExpiresAt,
        updatedAt: instant,
      };
      unitOfWork.updateTaskSyncRun(run);
      const result = DynaTaskSyncBatchResultSchema.parse({
        schema: "dyna/task-sync-batch-result-v1",
        acceptedTasks,
        deduplicated: false,
        leaseExpiresAt,
        summary: this.#taskSyncSummary(run),
      });
      unitOfWork.insertTaskSyncReceipt({
        id: receiptId,
        runId: run.id,
        kind: "batch",
        requestHash,
        result,
        createdAt: instant,
      });
      return result;
    });
  }

  completeTaskSync(
    runId: string,
    claimToken: string,
    input: DynaTaskSyncCompleteInput,
  ): DynaTaskSyncStatusResult {
    this.#requireCapability("action:execute");
    this.#requireCapability("task:observe");
    const parsedRunId = z.uuid().parse(runId);
    const parsed = DynaTaskSyncCompleteInputSchema.parse(input);
    const requestHash = sha256(canonicalJson([parsedRunId, parsed]));
    const receiptId = `task-sync-complete:${parsed.requestId}`;
    return this.#repository.write((unitOfWork) => {
      const replay = unitOfWork.findTaskSyncReceipt(receiptId);
      if (replay) {
        if (replay.runId !== parsedRunId || replay.requestHash !== requestHash) {
          throw new DynaCliError(
            "request_conflict",
            "This task sync completion request ID was reused for different input.",
          );
        }
        return DynaTaskSyncStatusResultSchema.parse(replay.result);
      }
      let run = this.#taskSyncRun(unitOfWork, parsedRunId);
      this.#assertTaskSyncClaim(run, claimToken);
      if (run.state !== "claimed" && run.state !== "syncing") {
        throw new DynaCliError("request_conflict", "The task sync cannot be completed.");
      }
      const targets = unitOfWork.listTaskSyncTargets(run.id);
      if (targets.some((target) => target.state === "pending")) {
        throw new DynaCliError(
          "invalid_input",
          "Every task sync target must be submitted before completion.",
        );
      }
      const unavailableTaskIds = new Set(
        targets
          .filter(
            (target) =>
              target.state === "unavailable" ||
              target.observation?.summaryCoverage === "unavailable",
          )
          .map((target) => target.taskId),
      );
      const incompleteMetadataTaskIds = new Set<string>();
      const updatedItems = new Set<string>();
      const dashboardsToTouch = new Set<string>();
      const finalizingAt = this.#now();
      for (const target of targets) {
        if (target.state === "unavailable") {
          const checkpoint = unitOfWork.findTaskSyncCheckpoint(target.taskId);
          unitOfWork.upsertTaskSyncCheckpoint({
            taskId: target.taskId,
            hostId: checkpoint?.hostId ?? target.hostId,
            version: checkpoint?.version ?? target.checkpointVersion,
            ...(checkpoint?.cursor && target.unavailableReason !== "cursor_invalid"
              ? { cursor: checkpoint.cursor }
              : {}),
            ...(checkpoint?.lastTurnId ? { lastTurnId: checkpoint.lastTurnId } : {}),
            ...(checkpoint?.statusUpdatedAt ? { statusUpdatedAt: checkpoint.statusUpdatedAt } : {}),
            ...(checkpoint?.observedAt ? { observedAt: checkpoint.observedAt } : {}),
            updatedAt: finalizingAt,
          });
          unitOfWork.markTaskSyncTarget(run.id, target.taskId, "skipped");
          continue;
        }
        if (target.state !== "staged" || !target.observation) continue;
        const observation = target.observation;
        const observationIdentity = taskSyncObservationReceiptIdentity(observation);
        const observationPayloadHash = taskSyncObservationPayloadHash(observation);
        const observationReceiptId = `task-sync-observation:${observationIdentity}`;
        const existingReceipt = unitOfWork.findTaskSyncReceipt(observationReceiptId);
        const checkpoint = unitOfWork.findTaskSyncCheckpoint(target.taskId);
        if (existingReceipt) {
          if (existingReceipt.requestHash !== observationPayloadHash) {
            unavailableTaskIds.add(target.taskId);
            unitOfWork.markTaskSyncTarget(run.id, target.taskId, "skipped");
            continue;
          }
          if (observation.task.state === "succeeded" && !observation.task.outcome) {
            incompleteMetadataTaskIds.add(target.taskId);
          }
          unitOfWork.markTaskSyncTarget(run.id, target.taskId, "applied");
          continue;
        }
        const owner = unitOfWork.findTaskOwner(target.taskId);
        const membershipValid =
          owner?.itemId === target.itemId &&
          unitOfWork.dashboardContainsItem(run.dashboardId, target.itemId) &&
          !unitOfWork.findOpenArchive(run.dashboardId, target.itemId);
        if (
          !membershipValid ||
          (checkpoint?.version ?? 0) !== target.checkpointVersion ||
          !isCanonicalDynaTaskTitle(target.itemNumber, observation.task.title)
        ) {
          unavailableTaskIds.add(target.taskId);
          unitOfWork.markTaskSyncTarget(run.id, target.taskId, "skipped");
          continue;
        }
        let statusChanged = false;
        try {
          statusChanged = unitOfWork.persistTaskStatusForSync(target.itemId, observation.task);
        } catch (error: unknown) {
          if (!(error instanceof RepositoryDynaCliStoreError)) throw error;
          unavailableTaskIds.add(target.taskId);
          unitOfWork.markTaskSyncTarget(run.id, target.taskId, "skipped");
          continue;
        }
        if (observation.task.state === "succeeded" && !observation.task.outcome) {
          incompleteMetadataTaskIds.add(target.taskId);
        }
        let activityChanged = false;
        if (observation.delta) {
          unitOfWork.insertWorkUpdate(
            DynaWorkUpdateSchema.parse({
              schema: "dyna/work-update-v1",
              id: scopedUuid(["task-sync-update", observationIdentity]),
              itemId: target.itemId,
              originDashboardId: run.dashboardId,
              workAttemptId: scopedUuid(["task-sync-attempt", target.taskId]),
              kind: observation.delta.kind,
              body: observation.delta.body,
              ...(observation.delta.outcome ? { outcome: observation.delta.outcome } : {}),
              artifacts: observation.delta.artifacts,
              task: {
                taskId: target.taskId,
                hostId: observation.task.hostId,
                title: observation.task.title,
              },
              createdAt: observation.task.observedAt,
            }),
          );
          activityChanged = true;
        }
        const hostChanged = Boolean(checkpoint && checkpoint.hostId !== observation.task.hostId);
        unitOfWork.upsertTaskSyncCheckpoint({
          taskId: target.taskId,
          hostId: observation.task.hostId,
          version: (checkpoint?.version ?? 0) + 1,
          ...(!hostChanged && observation.nextCursor
            ? { cursor: observation.nextCursor }
            : !hostChanged && checkpoint?.cursor
              ? { cursor: checkpoint.cursor }
              : {}),
          ...((observation.lastTurnId ?? checkpoint?.lastTurnId)
            ? { lastTurnId: observation.lastTurnId ?? checkpoint?.lastTurnId }
            : {}),
          statusUpdatedAt: observation.task.statusUpdatedAt,
          observedAt: observation.task.observedAt,
        });
        unitOfWork.insertTaskSyncReceipt({
          id: observationReceiptId,
          runId: run.id,
          kind: "observation",
          taskId: target.taskId,
          requestHash: observationPayloadHash,
          createdAt: this.#now(),
        });
        unitOfWork.markTaskSyncTarget(run.id, target.taskId, "applied");
        if (statusChanged || activityChanged) {
          updatedItems.add(target.itemId);
          for (const dashboardId of unitOfWork.listDashboardIdsForItem(target.itemId)) {
            dashboardsToTouch.add(dashboardId);
          }
        }
      }
      const instant = finalizingAt;
      if (updatedItems.size > 0) unitOfWork.touchDashboards(dashboardsToTouch, instant);
      const partial =
        unavailableTaskIds.size > 0 || incompleteMetadataTaskIds.size > 0 || run.excessTasks > 0;
      run = {
        ...run,
        state: partial ? "partial" : "completed",
        claimTokenHash: undefined,
        leaseExpiresAt: undefined,
        processedTasks: run.totalTasks,
        updatedItems: updatedItems.size,
        unavailableTasks: unavailableTaskIds.size,
        incompleteMetadataTasks: incompleteMetadataTaskIds.size,
        updatedAt: instant,
        completedAt: instant,
      };
      unitOfWork.updateTaskSyncRun(run);
      unitOfWork.appendAudit("task-sync.completed", run.id, instant);
      const result = DynaTaskSyncStatusResultSchema.parse({
        schema: "dyna/task-sync-status-result-v1",
        summary: this.#taskSyncSummary(run),
      });
      unitOfWork.insertTaskSyncReceipt({
        id: receiptId,
        runId: run.id,
        kind: "completion",
        requestHash,
        result,
        createdAt: instant,
      });
      return result;
    });
  }

  authorizeView(viewToken: string, itemId?: string): string {
    this.#requireCapability("view:interact");
    return this.#repository.write((unitOfWork) => unitOfWork.authorizeViewToken(viewToken, itemId));
  }

  createDashboard(name: string, description: string, doneRetentionHours = 24): DynaDashboard {
    this.#requireCapability("dashboard:manage");
    return this.#repository.write((unitOfWork) => {
      if (unitOfWork.listDashboards().length >= MAX_DASHBOARDS) {
        throw new DynaCliError("invalid_input", "Dyna cannot create more than 100 dashboards.");
      }
      const instant = this.#now();
      const dashboard = DynaDashboardSchema.parse({
        id: randomUUID(),
        name,
        description,
        archived: false,
        doneRetentionHours,
        createdAt: instant,
        updatedAt: instant,
      });
      unitOfWork.insertDashboard(dashboard);
      return dashboard;
    });
  }

  updateDashboard(id: string, changes: DynaDashboardChanges): DynaDashboard {
    this.#requireCapability("dashboard:manage");
    return this.#repository.write((unitOfWork) => {
      const current = this.#dashboard(unitOfWork, id);
      const updated = DynaDashboardSchema.parse({
        ...current,
        ...changes,
        updatedAt: this.#now(),
      });
      unitOfWork.updateDashboardRecord(updated);
      return updated;
    });
  }

  purgeDashboard(id: string, confirmation: string): void {
    this.#requireCapability("dashboard:manage");
    if (confirmation !== id) throw new Error("Dashboard purge confirmation did not match.");
    this.#repository.write((unitOfWork) => {
      this.#dashboard(unitOfWork, id);
      unitOfWork.deleteDashboardRecord(id);
      unitOfWork.appendAudit("dashboard.purged", id, this.#now());
    });
  }

  getDashboard(id: string): DynaDashboard {
    this.#requireCapability("dashboard:read");
    return this.#repository.read((unitOfWork) => this.#dashboard(unitOfWork, id));
  }

  listDashboards(): DynaDashboardListResult {
    this.#requireCapability("dashboard:read");
    const dashboards = this.#repository.read((unitOfWork) => unitOfWork.listDashboards());
    return DynaDashboardListResultSchema.parse({
      schema: "dyna/dashboard-list-result-v1",
      dashboards,
      total: dashboards.length,
    });
  }

  showDashboard(dashboardId: string): DynaDashboardShowResult {
    this.#requireCapability("dashboard:read");
    const snapshot = this.#materializeSnapshot(dashboardId);
    return DynaDashboardShowResultSchema.parse({
      schema: "dyna/dashboard-show-result-v1",
      dashboardId: snapshot.dashboard.id,
      name: snapshot.dashboard.name,
      revision: snapshot.revision,
      freshness: snapshot.freshness,
      counts: { active: snapshot.counts.total, archived: snapshot.counts.archived },
      scheduledSources: snapshot.schedules.map((schedule) => ({
        name: schedule.name,
        ...(schedule.scheduleTitle ? { scheduleTitle: schedule.scheduleTitle } : {}),
        scheduleState: schedule.scheduleState,
        lastRunStatus: schedule.lastRunStatus,
        ...(schedule.lastRunAt ? { lastRunAt: schedule.lastRunAt } : {}),
        ...(schedule.lastSourceSlices
          ? {
              sourceSlices: schedule.lastSourceSlices.map((slice) => ({
                source: slice.source,
                status: slice.status,
                freshness: slice.freshness,
              })),
            }
          : {}),
      })),
    });
  }

  searchItems(
    dashboardId: string,
    query: string,
    scope: DynaItemSearchScope,
  ): DynaItemSearchResult {
    this.#requireCapability("item:read");
    const snapshot = this.#materializeSnapshot(dashboardId, query, scope);
    return DynaItemSearchResultSchema.parse({
      schema: "dyna/item-search-result-v3",
      dashboardId,
      dashboardName: snapshot.dashboard.name,
      query,
      scope,
      revision: snapshot.revision,
      freshness: snapshot.freshness,
      total: scope === "archive" ? snapshot.counts.archived : snapshot.counts.total,
      items: snapshot.cards.slice(0, 20).map((card) => ({
        itemId: card.id,
        itemNumber: card.itemNumber,
        fingerprint: card.fingerprint,
        title: card.title,
        summary: card.summary,
        sourceRef: card.sourceRef,
        priority: card.priority,
        priorityReason: card.priorityReason,
        sourceUpdatedAt: card.sourceUpdatedAt,
        ...(card.dueAt ? { dueAt: card.dueAt } : {}),
        workflowState: card.workflowState,
        ...(card.followUpOfItemId ? { followUpOfItemId: card.followUpOfItemId } : {}),
        ...(card.followUpOfItemNumber ? { followUpOfItemNumber: card.followUpOfItemNumber } : {}),
        ...(card.attention ? { attention: card.attention } : {}),
        plan: card.plan,
        nextSteps: card.nextSteps,
        ...(card.outcome ? { outcome: card.outcome } : {}),
        ...(card.workState ? { workState: card.workState } : {}),
        workUpdates: card.workUpdates,
        workUpdateCount: card.workUpdateCount,
        ...(card.workConditionSummary ? { workConditionSummary: card.workConditionSummary } : {}),
        ...(card.workConditionTask ? { workConditionTask: card.workConditionTask } : {}),
        ...(card.matchedActivity ? { matchedActivity: card.matchedActivity } : {}),
        titleSyncNeeded: card.titleSyncNeeded,
        linkedTasks: card.linkedTasks,
        ...(card.archive ? { archive: card.archive } : {}),
      })),
    });
  }

  createPublisher(
    name: string,
    schedule?: DynaScheduleRegistration,
    requiredSourceSlices?: readonly DynaRequiredSourceSlice[],
    credentialMode: DynaCredentialMode = "disabled",
  ): { readonly publisher: DynaPublisher; readonly secret?: string | undefined } {
    this.#requireCapability("publisher:manage");
    return this.#repository.write((unitOfWork) => {
      if (unitOfWork.listPublishers().length >= MAX_PUBLISHERS) {
        throw new DynaCliError("invalid_input", "Dyna cannot create more than 100 publishers.");
      }
      return unitOfWork.persistCreatePublisher(
        name,
        schedule,
        requiredSourceSlices,
        credentialMode,
      );
    });
  }

  rotatePublisherSecret(publisherId: string): string {
    this.#requireCapability("publisher:manage");
    return this.#repository.write((unitOfWork) => {
      this.#assertPublisher(unitOfWork, publisherId);
      return unitOfWork.persistRotatePublisherSecret(publisherId);
    });
  }

  enableLocalCliPublisher(publisherId: string): void {
    this.#requireCapability("publisher:manage");
    this.#repository.write((unitOfWork) => {
      this.#assertPublisher(unitOfWork, publisherId);
      unitOfWork.persistEnableLocalCliPublisher(publisherId);
    });
  }

  revokePublisher(publisherId: string, purgePublishedData: boolean): void {
    this.#requireCapability("publisher:manage");
    this.#repository.write((unitOfWork) => {
      this.#assertPublisher(unitOfWork, publisherId);
      unitOfWork.persistRevokePublisher(publisherId, purgePublishedData);
    });
  }

  bindSchedule(dashboardId: string, publisherId: string, schedule: DynaScheduleBinding): void {
    this.#requireCapability("publisher:manage");
    this.#repository.write((unitOfWork) => {
      this.#dashboard(unitOfWork, dashboardId);
      if (!unitOfWork.listPublishers().some((publisher) => publisher.id === publisherId)) {
        throw new DynaCliError("not_found", "Dyna publisher was not found.");
      }
      unitOfWork.persistBindSchedule(dashboardId, publisherId, schedule);
    });
  }

  unbindSchedule(dashboardId: string, publisherId: string): void {
    this.#requireCapability("publisher:manage");
    this.#repository.write((unitOfWork) => {
      this.#dashboard(unitOfWork, dashboardId);
      unitOfWork.persistUnbindSchedule(dashboardId, publisherId);
    });
  }

  updateScheduleStatus(publisherId: string, schedule: DynaScheduleStatusUpdate): void {
    this.#requireCapability("publisher:manage");
    this.#repository.write((unitOfWork) => {
      this.#assertPublisher(unitOfWork, publisherId);
      unitOfWork.persistUpdateScheduleStatus(publisherId, schedule);
    });
  }

  listPublishers(dashboardId?: string): DynaPublisher[] {
    this.#requireCapability("publisher:manage");
    return this.#repository.read((unitOfWork) => unitOfWork.listPublishers(dashboardId));
  }

  publish(
    publisherId: string,
    secret: string,
    items: readonly DynaPublishedItem[],
    options: DynaPublishOptions,
  ): DynaPublishResult {
    this.#requireCapability("publisher:publish");
    return this.#repository.write((unitOfWork) => {
      this.#assertPublisher(unitOfWork, publisherId);
      return unitOfWork.persistPublish(publisherId, secret, items, options, false);
    });
  }

  publishLocal(
    publisherId: string,
    items: readonly DynaPublishedItem[],
    options: DynaPublishOptions,
  ): DynaPublishResult {
    this.#requireCapability("publisher:publish");
    return this.#repository.write((unitOfWork) => {
      this.#assertPublisher(unitOfWork, publisherId);
      return unitOfWork.persistPublish(publisherId, undefined, items, options, true);
    });
  }

  getItemContext(dashboardId: string, itemId: string): DynaItemContext {
    this.#requireCapability("item:read");
    return this.#repository.read((unitOfWork) => {
      this.#assertItemMembership(unitOfWork, dashboardId, itemId);
      return unitOfWork.loadItemContext(itemId);
    });
  }

  /** Test/migration compatibility; production callers must provide dashboard membership. */
  compatibilityItemContext(itemId: string): DynaItemContext {
    this.#requireCapability("item:read");
    return this.#repository.read((unitOfWork) => unitOfWork.loadItemContext(itemId));
  }

  /** Test/migration compatibility for the former store-level view snapshot. */
  compatibilitySnapshotForView(
    viewToken: string,
    query = "",
    scope: DynaItemSearchScope = "active",
  ): DynaDashboardSnapshot {
    this.#requireCapability("item:read");
    const dashboardId = this.#repository.write((unitOfWork) =>
      unitOfWork.authorizeViewToken(viewToken),
    );
    return this.#materializeSnapshot(dashboardId, query, scope);
  }

  /** Test/migration compatibility for creating a view capability directly. */
  compatibilityCreateView(dashboardId: string): string {
    this.#requireCapability("view:interact");
    return this.#repository.write((unitOfWork) => unitOfWork.persistCreateView(dashboardId));
  }

  /** Test/migration compatibility for the former array-returning store API. */
  compatibilityListDashboards(): DynaDashboard[] {
    this.#requireCapability("dashboard:read");
    return this.#repository.read((unitOfWork) => unitOfWork.listDashboards());
  }

  /** Controller fixture compatibility for task updates without a dashboard assertion. */
  compatibilityUpsertTaskStatus(itemId: string, status: DynaTaskStatus): void {
    this.#requireCapability("task:observe");
    this.#repository.write((unitOfWork) => {
      unitOfWork.persistTaskStatus(itemId, status);
    });
  }

  showItem(dashboardId: string, itemId: string): DynaItemShowResult {
    this.#requireCapability("item:read");
    return this.#repository.write((unitOfWork) => {
      const dashboardState = unitOfWork.findDashboardState(dashboardId);
      if (!dashboardState) throw new DynaCliError("not_found", "Dyna dashboard was not found.");
      const dashboard = unitOfWork.getDashboard(dashboardId);
      if (!unitOfWork.findItemBase(itemId)) {
        throw new DynaCliError("not_found", "Dyna item was not found.");
      }
      if (!unitOfWork.dashboardContainsItem(dashboardId, itemId)) {
        throw new DynaCliError(
          "outside_dashboard",
          "The Dyna item is outside the requested dashboard.",
        );
      }
      let active = projectRepositoryItems(unitOfWork.listProjectionItems(dashboardId, "active"));
      active = this.#archiveExpiredCompleted(unitOfWork, dashboardId, active, this.#clock());
      const value =
        active.find(({ fact }) => fact.id === itemId) ??
        projectRepositoryItems(unitOfWork.listProjectionItems(dashboardId, "archive")).find(
          ({ fact }) => fact.id === itemId,
        );
      if (!value) {
        throw new DynaCliError("not_found", "Dyna item was not found in this dashboard.");
      }
      const evidence = unitOfWork.loadCardEvidence([itemId])[0];
      if (!evidence) throw new Error("Dyna could not materialize the requested item.");
      return DynaItemShowResultSchema.parse({
        schema: "dyna/item-show-result-v3",
        dashboard,
        revision: unitOfWork.findDashboardState(dashboardId)?.revision ?? dashboardState.revision,
        enrichmentVersion: value.fact.enrichment?.version ?? 0,
        item: this.#cardFromProjection(value, evidence),
      });
    });
  }

  itemHistory(
    dashboardId: string,
    itemId: string,
    options?: DynaItemHistoryOptions,
  ): DynaItemHistory {
    this.#requireCapability("item:read");
    return this.#repository.read((unitOfWork) => {
      this.#assertItemMembership(unitOfWork, dashboardId, itemId);
      return unitOfWork.loadItemHistory(dashboardId, itemId, options);
    });
  }

  itemActivityPage(
    dashboardId: string,
    itemId: string,
    options?: DynaItemActivityOptions,
  ): DynaWorkActivityPage {
    this.#requireCapability("item:read");
    return this.#repository.read((unitOfWork) => {
      this.#assertItemMembership(unitOfWork, dashboardId, itemId);
      return unitOfWork.loadItemActivityPage(dashboardId, itemId, options);
    });
  }

  checkTaskAssociation(
    dashboardId: string,
    itemId: string,
    taskId: string,
    reservationRequestId: string,
  ): DynaTaskAssociationCheck {
    this.#requireCapability("item:read");
    this.#requireCapability("task:observe");
    const requestId = z.uuid().parse(reservationRequestId);
    return this.#repository.write((unitOfWork) => {
      this.#assertItemMembership(unitOfWork, dashboardId, itemId);
      const reserved = this.#reserveTaskAssociation(
        unitOfWork,
        dashboardId,
        itemId,
        taskId,
        requestId,
      );
      if (reserved.association !== "reserved") return reserved;
      if (!reserved.expiresAt) throw new Error("A direct task reservation requires an expiry.");
      return {
        association: "attachable",
        reservationId: reserved.reservationId,
        expiresAt: reserved.expiresAt,
      };
    });
  }

  applyEnrichment(itemId: string, update: DynaEnrichmentUpdate): void {
    this.#requireCapability("item:write");
    this.#repository.write((unitOfWork) => {
      const item = unitOfWork.findItemBase(itemId);
      if (!item) throw new DynaCliError("not_found", "Dyna item was not found.");
      if (item.fingerprint !== update.expectedFingerprint) {
        throw new DynaCliError(
          "stale_item",
          "The Dyna item changed; retrieve its latest context before enrichment.",
        );
      }
      const priority =
        update.priority === undefined ? undefined : DynaPrioritySchema.parse(update.priority);
      if (priority === "critical" && item.sourcePriority !== "critical") {
        throw new DynaCliError(
          "invalid_input",
          "Dyna enrichment cannot set critical unless the source priority is already critical.",
        );
      }
      if (unitOfWork.currentEnrichmentVersion(itemId) !== update.expectedEnrichmentVersion) {
        throw new DynaCliError(
          "stale_enrichment",
          "The Dyna enrichment changed; retrieve its latest context before replacing it.",
        );
      }
      const instant = this.#now();
      unitOfWork.replaceEnrichment({
        itemId,
        ...(update.summary !== undefined ? { summary: update.summary } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(update.priorityReason !== undefined ? { priorityReason: update.priorityReason } : {}),
        ...(update.dueAt ? { dueAt: new Date(update.dueAt).toISOString() } : {}),
        dueAtSet: update.dueAt !== undefined,
        ...(update.labels !== undefined ? { labels: update.labels } : {}),
        ...(update.people !== undefined ? { people: update.people } : {}),
        leadershipScore: dynaLeadershipScore(update.people ?? []),
        ...(update.attention !== undefined ? { attention: update.attention } : {}),
        ...(update.plan !== undefined ? { plan: update.plan } : {}),
        ...(update.nextSteps !== undefined ? { nextSteps: update.nextSteps } : {}),
        baseFingerprint: item.fingerprint,
        baseSourceUpdatedAt: item.sourceUpdatedAt,
        appliedAt: instant,
        provenance: update.provenance,
      });
      this.#touchItemDashboards(unitOfWork, itemId, instant);
      unitOfWork.appendAudit("item.enriched", itemId, instant);
    });
  }

  updateTask(
    dashboardId: string,
    itemId: string,
    status: DynaTaskStatus,
    associationReservationId?: string,
  ): void {
    this.#requireCapability("task:observe");
    this.#repository.write((unitOfWork) => {
      this.#assertItemMembership(unitOfWork, dashboardId, itemId);
      const reservationId = this.#taskAssociationReservationForAttachment(
        unitOfWork,
        itemId,
        status.taskId,
        associationReservationId,
      );
      this.#assertCanonicalTaskObservation(unitOfWork, itemId, status);
      const attachmentBlocker = this.#taskAttachmentBlocker(unitOfWork, dashboardId, itemId);
      unitOfWork.persistTaskStatusForDashboard(
        dashboardId,
        itemId,
        status,
        attachmentBlocker,
        reservationId,
      );
      if (reservationId) {
        unitOfWork.transitionTaskAssociationReservation(reservationId, "consumed", this.#now());
      }
    });
  }

  addAnnotation(
    viewToken: string,
    itemId: string,
    clientRequestId: string,
    body: string,
  ): DynaAnnotation {
    this.#requireCapability("view:interact");
    return this.#repository.write((unitOfWork) => {
      const dashboardId = unitOfWork.authorizeViewToken(viewToken, itemId);
      this.#assertItemMembership(unitOfWork, dashboardId, itemId);
      const input = DynaAnnotationSchema.parse({
        id: clientRequestId,
        itemId,
        body,
        createdAt: this.#now(),
      });
      const annotationId = scopedUuid([
        "annotation-request",
        dashboardId,
        itemId,
        input.id.toLowerCase(),
      ]);
      const existing = unitOfWork.findAnnotation(annotationId);
      if (existing) {
        if (existing.itemId !== itemId || existing.body !== input.body) {
          throw new DynaCliError(
            "request_conflict",
            "Dyna rejected an annotation request ID reused with different content.",
          );
        }
        return existing;
      }
      const annotation = DynaAnnotationSchema.parse({ ...input, id: annotationId });
      unitOfWork.insertAnnotation(annotation);
      this.#touchItemDashboards(unitOfWork, itemId, annotation.createdAt);
      unitOfWork.appendAudit("annotation.created", itemId, annotation.createdAt);
      return annotation;
    });
  }

  addTodo(viewToken: string, input: DynaTodoInput, clientRequestId: string): string {
    this.#requireCapability("view:interact");
    return this.#repository.write((unitOfWork) => {
      const dashboardId = unitOfWork.authorizeViewToken(viewToken);
      return this.#createTodoWithReceipt(
        unitOfWork,
        dashboardId,
        DynaTodoInputSchema.parse(input),
        clientRequestId,
      ).itemId;
    });
  }

  setItemStatus(input: DynaSetItemStatusInput): DynaItemStatusResult {
    this.#requireCapability("view:interact");
    return this.#repository.write((unitOfWork) => {
      const dashboardId = unitOfWork.authorizeViewToken(input.viewToken, input.itemId);
      if (!unitOfWork.findCliReceipt(input.clientRequestId)) {
        this.#assertItemMembership(unitOfWork, dashboardId, input.itemId);
        this.#assertExpectedRevision(
          unitOfWork,
          dashboardId,
          input.expectedRevision,
          "The Dyna dashboard changed; refresh before changing this item status.",
        );
        this.#assertExpectedFingerprint(
          unitOfWork,
          input.itemId,
          input.expectedFingerprint,
          "The Dyna item changed; refresh before changing its status.",
        );
      }
      const positioned = this.#positionedItem(unitOfWork, dashboardId, input.itemId);
      return unitOfWork.persistItemStatus(input, positioned);
    });
  }

  organizeItem(
    viewToken: string,
    itemId: string,
    action: "bump" | "lower" | "earlier" | "later",
    expectedRevision: number,
    expectedFingerprint: string,
  ): { readonly changed: boolean } {
    this.#requireCapability("view:interact");
    return this.#repository.write((unitOfWork) => {
      const dashboardId = unitOfWork.authorizeViewToken(viewToken, itemId);
      this.#assertItemMembership(unitOfWork, dashboardId, itemId);
      this.#assertExpectedRevision(
        unitOfWork,
        dashboardId,
        expectedRevision,
        "The Dyna dashboard changed; refresh before reprioritizing this item.",
      );
      this.#assertExpectedFingerprint(
        unitOfWork,
        itemId,
        expectedFingerprint,
        "The Dyna dashboard changed; refresh before reprioritizing this item.",
      );
      const positioned = this.#positionedItems(unitOfWork, dashboardId);
      const selected = positioned.find((candidate) => candidate.id === itemId);
      if (!selected) throw new DynaCliError("not_found", "The Dyna item is no longer active.");
      if (selected.workflowState === "completed") {
        throw new DynaCliError(
          "completed_item",
          "Completed Dyna items cannot be reprioritized; create a follow-up instead.",
        );
      }
      if (action === "bump" || action === "lower") {
        const currentIndex = PRIORITIES.indexOf(selected.effectivePriority);
        const targetIndex = Math.max(
          0,
          Math.min(PRIORITIES.length - 1, currentIndex + (action === "bump" ? -1 : 1)),
        );
        const targetPriority = PRIORITIES[targetIndex] ?? selected.effectivePriority;
        if (targetPriority === selected.effectivePriority) return { changed: false };
        const placement = this.#placeProjectedItem(
          unitOfWork,
          dashboardId,
          positioned,
          itemId,
          targetPriority,
          undefined,
          "view",
        );
        return { changed: placement.changed };
      }
      const group = positioned.filter(
        (candidate) =>
          candidate.workflowState !== "completed" &&
          candidate.effectivePriority === selected.effectivePriority,
      );
      const index = group.findIndex((candidate) => candidate.id === itemId);
      if (
        index < 0 ||
        (action === "earlier" && index === 0) ||
        (action === "later" && index === group.length - 1)
      ) {
        return { changed: false };
      }
      const beforeItemId = action === "earlier" ? group[index - 1]?.id : group[index + 2]?.id;
      const placement = this.#placeProjectedItem(
        unitOfWork,
        dashboardId,
        positioned,
        itemId,
        selected.effectivePriority,
        beforeItemId,
        "view",
      );
      return { changed: placement.changed };
    });
  }

  groupItems(
    viewToken: string,
    items: readonly { readonly itemId: string; readonly expectedFingerprint: string }[],
    targetPriority: DynaPriority,
    expectedRevision: number,
  ): { readonly changed: boolean; readonly changedCount: number } {
    this.#requireCapability("view:interact");
    return this.#repository.write((unitOfWork) => {
      const dashboardId = unitOfWork.authorizeViewToken(viewToken);
      this.#assertExpectedRevision(
        unitOfWork,
        dashboardId,
        expectedRevision,
        "The Dyna dashboard changed; refresh before moving these items.",
      );
      const positioned = this.#positionedItems(unitOfWork, dashboardId);
      return this.#placeProjectedItemsAsBlock(
        unitOfWork,
        dashboardId,
        positioned,
        items,
        DynaPrioritySchema.parse(targetPriority),
        "view",
        false,
      );
    });
  }

  placeItemForView(
    viewToken: string,
    itemId: string,
    targetPriority: DynaPriority,
    beforeItemId: string | undefined,
    expectedRevision: number,
    expectedFingerprint: string,
  ): { readonly changed: boolean } {
    this.#requireCapability("view:interact");
    return this.#repository.write((unitOfWork) => {
      const dashboardId = unitOfWork.authorizeViewToken(viewToken, itemId);
      this.#assertItemMembership(unitOfWork, dashboardId, itemId);
      this.#assertExpectedRevision(
        unitOfWork,
        dashboardId,
        expectedRevision,
        "The Dyna dashboard changed; refresh before placing this item.",
      );
      this.#assertExpectedFingerprint(
        unitOfWork,
        itemId,
        expectedFingerprint,
        "The Dyna item changed; refresh before placing it.",
      );
      const positioned = this.#positionedItems(unitOfWork, dashboardId);
      const selected = positioned.find((candidate) => candidate.id === itemId);
      if (!selected) throw new DynaCliError("not_found", "The Dyna item is no longer active.");
      if (selected.workflowState === "completed") {
        throw new DynaCliError(
          "completed_item",
          "Completed Dyna items cannot be placed; create a follow-up for continued work.",
        );
      }
      const placement = this.#placeProjectedItem(
        unitOfWork,
        dashboardId,
        positioned,
        itemId,
        DynaPrioritySchema.parse(targetPriority),
        beforeItemId,
        "view",
      );
      return { changed: placement.changed };
    });
  }

  archiveItemForView(
    viewToken: string,
    itemId: string,
    input: DynaViewArchiveInput,
  ): DynaArchiveResult {
    this.#requireCapability("view:interact");
    return this.#repository.write((unitOfWork) => {
      const dashboardId = unitOfWork.authorizeViewToken(viewToken, itemId);
      const reason = DynaArchiveReasonSchema.parse(input.reason);
      const reasonDetail = input.reasonDetail?.trim();
      if (reason === "other" && !reasonDetail) {
        throw new DynaCliError(
          "invalid_input",
          "Other archive reasons require a short explanation.",
        );
      }
      if (reason !== "other" && reasonDetail) {
        throw new DynaCliError(
          "invalid_input",
          "Archive reason details are only accepted for Other.",
        );
      }
      if (reasonDetail && reasonDetail.length > 500) {
        throw new DynaCliError(
          "invalid_input",
          "Archive reason details cannot exceed 500 characters.",
        );
      }
      const requestHash = sha256(
        JSON.stringify([
          "dyna/archive-v1",
          itemId,
          reason,
          reasonDetail ?? null,
          input.expectedRevision,
          input.expectedFingerprint,
        ]),
      );
      const retry = unitOfWork.findArchiveReceipt(dashboardId, input.clientRequestId);
      if (retry) {
        if (retry.requestHash !== requestHash) {
          throw new DynaCliError(
            "request_conflict",
            "The archive request ID was already used for different input.",
          );
        }
        return retry.result;
      }
      this.#assertItemMembership(unitOfWork, dashboardId, itemId);
      this.#assertExpectedRevision(
        unitOfWork,
        dashboardId,
        input.expectedRevision,
        "The Dyna dashboard changed; refresh before archiving this item.",
      );
      const positioned = this.#positionedItem(unitOfWork, dashboardId, itemId);
      if (positioned?.fingerprint !== input.expectedFingerprint) {
        throw new DynaCliError(
          "stale_item",
          "The Dyna item changed or is no longer active; refresh before archiving.",
        );
      }
      if (reason === "completed" && positioned.workflowState !== "completed") {
        throw new DynaCliError(
          "invalid_input",
          "Only completed work can use the Completed archive disposition.",
        );
      }
      const taskEvidence = unitOfWork.completionEvidence(itemId);
      const completedAtMs =
        positioned.workflowState === "completed"
          ? (taskEvidence.completedAtMs ?? positioned.userWorkflowCreatedMs)
          : undefined;
      const outcome =
        positioned.workflowState === "completed"
          ? (taskEvidence.outcome ?? positioned.userWorkflowOutcome)
          : undefined;
      const archiveId = randomUUID();
      const archivedAt = this.#now();
      unitOfWork.insertArchive({
        id: archiveId,
        dashboardId,
        itemId,
        reason,
        ...(reasonDetail ? { reasonDetail } : {}),
        mode: "manual",
        archivedAt,
        fingerprint: positioned.fingerprint,
        workflowState: positioned.workflowState,
        ...(completedAtMs !== undefined ? { completedAtMs } : {}),
        ...(outcome ? { outcome } : {}),
        priority: positioned.effectivePriority,
        ...(positioned.preferenceSequence !== undefined
          ? { sequence: positioned.preferenceSequence }
          : {}),
        requestId: input.clientRequestId,
        requestHash,
      });
      unitOfWork.touchDashboards([dashboardId], archivedAt);
      unitOfWork.appendAudit(`item.archived.${reason}.manual`, itemId, archivedAt);
      return { archiveId, itemId, archivedAt, reason, mode: "manual" };
    });
  }

  restoreItemForView(
    viewToken: string,
    itemId: string,
    input: DynaViewRestoreInput,
  ): { readonly itemId: string; readonly restoredAt: string } {
    this.#requireCapability("view:interact");
    return this.#repository.write((unitOfWork) => {
      const dashboardId = unitOfWork.authorizeViewToken(viewToken, itemId);
      const requestHash = sha256(
        JSON.stringify([
          "dyna/restore-v1",
          itemId,
          input.expectedRevision,
          input.expectedFingerprint,
        ]),
      );
      const retry = unitOfWork.findRestoreReceipt(dashboardId, input.clientRequestId);
      if (retry) {
        if (retry.requestHash !== requestHash || retry.itemId !== itemId) {
          throw new DynaCliError(
            "request_conflict",
            "The restore request ID was already used for different input.",
          );
        }
        return { itemId, restoredAt: retry.restoredAt };
      }
      this.#assertItemMembership(unitOfWork, dashboardId, itemId);
      this.#assertExpectedRevision(
        unitOfWork,
        dashboardId,
        input.expectedRevision,
        "The Dyna dashboard changed; refresh before restoring this item.",
      );
      this.#assertExpectedFingerprint(
        unitOfWork,
        itemId,
        input.expectedFingerprint,
        "The Dyna dashboard changed; refresh before restoring this item.",
      );
      const archive = unitOfWork.findOpenArchive(dashboardId, itemId);
      if (!archive) {
        throw new DynaCliError("invalid_input", "The Dyna item is not currently archived.");
      }
      const restoredAt = this.#now();
      if (
        !unitOfWork.restoreArchive(archive.id, restoredAt, {
          id: input.clientRequestId,
          hash: requestHash,
        })
      ) {
        throw new DynaCliError("invalid_input", "The Dyna item is not currently archived.");
      }
      unitOfWork.touchDashboards([dashboardId], restoredAt);
      unitOfWork.appendAudit("item.restored", itemId, restoredAt);
      return { itemId, restoredAt };
    });
  }

  prepareAction(
    viewToken: string,
    kind: DynaActionKind,
    input: DynaPrepareActionInput,
  ): DynaActionRequest {
    this.#requireCapability("view:interact");
    return unwrapPersistenceOutcome(
      this.#repository.write((unitOfWork) => {
        const dashboardId = unitOfWork.authorizeViewToken(viewToken, input.itemId);
        if (kind === "attach_codex_task" && input.taskId) {
          const owner = unitOfWork.findTaskOwner(input.taskId);
          if (owner && owner.itemId !== input.itemId) {
            throw new DynaCliError(
              "request_conflict",
              "This Codex task is already associated with another Dyna item.",
            );
          }
        }
        const attachmentBlocker =
          kind === "create_codex_task" || kind === "attach_codex_task"
            ? this.#taskAttachmentBlocker(unitOfWork, dashboardId, input.itemId)
            : undefined;
        return unitOfWork.persistPrepareAction(viewToken, kind, input, attachmentBlocker);
      }),
    );
  }

  markDelivered(viewToken: string, requestId: string): DynaActionRequest {
    this.#requireCapability("view:interact");
    return this.#repository.write((unitOfWork) =>
      unitOfWork.persistMarkDelivered(viewToken, requestId),
    );
  }

  actionStatusForView(
    viewToken: string,
    requestId: string,
  ): DynaActionRequest & {
    readonly candidates?: readonly DynaCodexSessionCandidate[] | undefined;
  } {
    this.#requireCapability("view:interact");
    return this.#repository.write((unitOfWork) =>
      unitOfWork.loadActionForView(viewToken, requestId),
    );
  }

  claimAction(requestId: string): DynaClaimedAction {
    this.#requireCapability("action:execute");
    return unwrapPersistenceOutcome(
      this.#repository.write((unitOfWork) => {
        const action = unitOfWork.loadAction(requestId);
        const attachmentBlocker = this.#taskAttachmentBlockerForAction(unitOfWork, requestId);
        let reservedForClaim = false;
        if (
          action.state === "delivered" &&
          action.kind === "attach_codex_task" &&
          action.itemId &&
          action.taskId &&
          !attachmentBlocker
        ) {
          const reservation = this.#reserveTaskAssociation(
            unitOfWork,
            action.dashboardId,
            action.itemId,
            action.taskId,
            requestId,
            requestId,
          );
          if (reservation.association === "not_attachable") {
            throw new DynaCliError(
              "request_conflict",
              "The selected Codex task is already owned or reserved for other Dyna work.",
            );
          }
          reservedForClaim = reservation.association === "reserved";
        }
        const persisted = unitOfWork.persistClaimAction(requestId, attachmentBlocker);
        if (!persisted.ok && reservedForClaim) {
          unitOfWork.transitionTaskAssociationReservation(requestId, "released", this.#now());
        }
        return persisted;
      }),
    );
  }

  completeAction(
    requestId: string,
    claimToken: string,
    result: DynaActionCompletion,
  ): DynaActionRequest {
    this.#requireCapability("action:execute");
    return this.#repository.write((unitOfWork) => {
      const action = unitOfWork.loadAction(requestId);
      if (result.outcome === "succeeded" && result.task && action.itemId) {
        if (
          (action.kind === "attach_codex_task" || action.kind === "refresh_codex_status") &&
          result.task.taskId !== action.taskId
        ) {
          throw new DynaCliError(
            "invalid_input",
            "The controller-observed Codex task does not match the claimed request.",
          );
        }
        if (action.kind === "attach_codex_task") {
          this.#taskAssociationReservationForAttachment(
            unitOfWork,
            action.itemId,
            result.task.taskId,
            requestId,
          );
        }
        this.#assertCanonicalTaskObservation(unitOfWork, action.itemId, result.task);
      }
      const completed = unitOfWork.persistCompleteAction(
        requestId,
        claimToken,
        result,
        this.#taskAttachmentBlockerForAction(unitOfWork, requestId),
      );
      const reservation =
        action.kind === "attach_codex_task"
          ? unitOfWork.findTaskAssociationReservation(requestId)
          : undefined;
      if (reservation?.state === "reserved") {
        const state =
          completed.state === "succeeded"
            ? "consumed"
            : completed.state === "needs_reconciliation"
              ? "uncertain"
              : "released";
        unitOfWork.transitionTaskAssociationReservation(requestId, state, this.#now());
      }
      return completed;
    });
  }

  resolveActionReconciliation(
    requestId: string,
    resolution: DynaActionReconciliation,
  ): DynaActionRequest {
    this.#requireCapability("action:execute");
    return this.#repository.write((unitOfWork) => {
      const action = unitOfWork.loadAction(requestId);
      if (resolution.outcome === "task_linked" && action.itemId) {
        if (action.kind === "attach_codex_task" && resolution.task.taskId !== action.taskId) {
          throw new DynaCliError(
            "invalid_input",
            "The reconciled Codex task does not match the selected attachment.",
          );
        }
        if (action.kind === "attach_codex_task") {
          this.#taskAssociationReservationForAttachment(
            unitOfWork,
            action.itemId,
            resolution.task.taskId,
            requestId,
            true,
          );
        }
        this.#assertCanonicalTaskObservation(unitOfWork, action.itemId, resolution.task);
      }
      const completed = unitOfWork.persistResolveActionReconciliation(
        requestId,
        resolution,
        this.#taskAttachmentBlockerForAction(unitOfWork, requestId),
      );
      const reservation =
        action.kind === "attach_codex_task"
          ? unitOfWork.findTaskAssociationReservation(requestId)
          : undefined;
      if (reservation && (reservation.state === "reserved" || reservation.state === "uncertain")) {
        unitOfWork.transitionTaskAssociationReservation(
          requestId,
          resolution.outcome === "task_linked" ? "consumed" : "released",
          this.#now(),
        );
      }
      return completed;
    });
  }

  actionStatus(requestId: string): DynaActionRequest {
    this.#requireCapability("action:execute");
    return this.#repository.read((unitOfWork) => unitOfWork.loadAction(requestId));
  }

  recordWorkUpdate(
    dashboardId: string,
    itemId: string,
    expectedFingerprint: string,
    input: DynaWorkUpdateInput,
  ): DynaItemUpdateResult {
    this.#requireCapability("item:write");
    if (TASK_ATTRIBUTED_WORK_KINDS.has(input.kind) && !input.task) {
      throw new DynaCliError(
        "invalid_input",
        "This Dyna lifecycle update requires attribution to a linked Codex task.",
      );
    }
    const parsed = DynaWorkUpdateInputSchema.parse(input);
    return this.#canonicalMutation(
      dashboardId,
      itemId,
      parsed.requestId,
      "item.update",
      { expectedFingerprint, input: parsed },
      (value) => DynaItemUpdateResultSchema.parse(value),
      (unitOfWork) => {
        if (this.#actorKind === "codex_task" && !parsed.task) {
          throw new DynaCliError(
            "invalid_input",
            "A Codex-task Dyna update requires attribution to the receiving linked Codex task. Verify and synchronize that task before retrying.",
          );
        }
        const item = unitOfWork.findItemBase(itemId);
        if (item?.fingerprint !== expectedFingerprint) {
          throw new DynaCliError(
            "stale_item",
            "The Dyna item changed; run item show before updating it.",
          );
        }
        const archived = unitOfWork.findOpenArchive(dashboardId, itemId) !== undefined;
        const positioned = archived
          ? undefined
          : this.#positionedItem(unitOfWork, dashboardId, itemId);
        const completed = positioned?.workflowState === "completed";
        if ((archived || completed) && parsed.kind !== "note") {
          throw new DynaCliError(
            archived ? "archived_item" : "completed_item",
            archived
              ? "Archived Dyna items accept historical notes only; create a follow-up for continued work."
              : "Completed Dyna items accept historical notes only; create a follow-up for continued work.",
          );
        }
        let taskTitle: string | undefined;
        if (parsed.task) {
          taskTitle = unitOfWork.findLinkedTaskTitle(
            itemId,
            parsed.task.taskId,
            parsed.task.hostId,
          );
          if (!taskTitle) {
            throw new DynaCliError(
              "task_not_linked",
              "The attributed Codex task is not linked to this Dyna item.",
            );
          }
          if (!isCanonicalDynaTaskTitle(item.itemNumber, taskTitle)) {
            throw new DynaCliError(
              "invalid_input",
              `The linked Codex task title is not synchronized. Rename it so ${formatDynaItemNumber(item.itemNumber)} appears exactly once at the start, verify the title, and retry this update.`,
            );
          }
        }
        const priorAttempt = unitOfWork.findWorkAttemptAttribution(itemId, parsed.workAttemptId);
        if (priorAttempt && priorAttempt.taskId !== parsed.task?.taskId) {
          throw new DynaCliError(
            "request_conflict",
            "A Dyna work attempt cannot be reassigned to a different Codex task; host routing may change after handoff.",
          );
        }
        const instant = this.#now();
        const update = DynaWorkUpdateSchema.parse({
          schema: "dyna/work-update-v1",
          id: randomUUID(),
          itemId,
          originDashboardId: dashboardId,
          workAttemptId: parsed.workAttemptId,
          kind: parsed.kind,
          body: parsed.body,
          ...(parsed.outcome ? { outcome: parsed.outcome } : {}),
          artifacts: parsed.artifacts,
          ...(parsed.task ? { task: { ...parsed.task, title: taskTitle } } : {}),
          createdAt: instant,
        });
        unitOfWork.insertWorkUpdate(update);
        this.#touchItemDashboards(unitOfWork, itemId, instant);
        unitOfWork.appendAudit(`item.work_updated.${update.kind}`, itemId, instant);
        return DynaItemUpdateResultSchema.parse({
          schema: "dyna/item-update-result-v1",
          requestId: parsed.requestId,
          itemId,
          workUpdateId: update.id,
          deduplicated: false,
        });
      },
    );
  }

  enrichItem(
    dashboardId: string,
    itemId: string,
    expectedFingerprint: string,
    expectedEnrichmentVersion: number,
    input: DynaWorkEnrichInput,
  ): DynaItemEnrichResult {
    this.#requireCapability("item:write");
    const parsed = DynaWorkEnrichInputSchema.parse(input);
    const enrichedInput = { ...parsed, provenance: "codex-task" };
    return this.#canonicalMutation(
      dashboardId,
      itemId,
      parsed.requestId,
      "item.enrich",
      { expectedFingerprint, expectedEnrichmentVersion, input: enrichedInput },
      (value) => DynaItemEnrichResultSchema.parse(value),
      (unitOfWork) => {
        const item = unitOfWork.findItemBase(itemId);
        if (item?.fingerprint !== expectedFingerprint) {
          throw new DynaCliError(
            "stale_item",
            "The Dyna item changed; run item show before enriching it.",
          );
        }
        const positioned = this.#positionedItem(unitOfWork, dashboardId, itemId);
        if (!positioned) {
          throw new DynaCliError(
            "archived_item",
            "Archived Dyna items cannot be enriched; restore or create a follow-up.",
          );
        }
        if (positioned.workflowState === "completed") {
          throw new DynaCliError(
            "completed_item",
            "Completed Dyna items cannot be enriched; create a follow-up for continued work.",
          );
        }
        const priority =
          parsed.priority === undefined ? undefined : DynaPrioritySchema.parse(parsed.priority);
        if (priority === "critical" && item.sourcePriority !== "critical") {
          throw new DynaCliError(
            "invalid_input",
            "Dyna enrichment cannot set critical unless the source priority is already critical.",
          );
        }
        const currentVersion = unitOfWork.currentEnrichmentVersion(itemId);
        if (currentVersion !== expectedEnrichmentVersion) {
          throw new DynaCliError(
            "stale_enrichment",
            "The Dyna enrichment changed; run item show before replacing it.",
          );
        }
        const instant = this.#now();
        const enrichmentVersion = unitOfWork.replaceEnrichment({
          itemId,
          ...(parsed.summary !== undefined ? { summary: parsed.summary } : {}),
          ...(priority !== undefined ? { priority } : {}),
          ...(parsed.priorityReason !== undefined ? { priorityReason: parsed.priorityReason } : {}),
          ...(parsed.dueAt ? { dueAt: new Date(parsed.dueAt).toISOString() } : {}),
          dueAtSet: parsed.dueAt !== undefined,
          ...(parsed.labels !== undefined ? { labels: parsed.labels } : {}),
          ...(parsed.people !== undefined ? { people: parsed.people } : {}),
          leadershipScore: dynaLeadershipScore(parsed.people ?? []),
          ...(parsed.attention !== undefined ? { attention: parsed.attention } : {}),
          ...(parsed.plan !== undefined ? { plan: parsed.plan } : {}),
          ...(parsed.nextSteps !== undefined ? { nextSteps: parsed.nextSteps } : {}),
          baseFingerprint: expectedFingerprint,
          baseSourceUpdatedAt: item.sourceUpdatedAt,
          appliedAt: instant,
          provenance: enrichedInput.provenance,
        });
        this.#touchItemDashboards(unitOfWork, itemId, instant);
        unitOfWork.appendAudit("item.enriched.cli", itemId, instant);
        return DynaItemEnrichResultSchema.parse({
          schema: "dyna/item-enrich-result-v1",
          requestId: parsed.requestId,
          itemId,
          enrichmentVersion,
          deduplicated: false,
        });
      },
    );
  }

  placeItem(
    dashboardId: string,
    itemId: string,
    expectedRevision: number,
    expectedFingerprint: string,
    input: DynaOrganizePlaceInput,
  ): DynaItemPlaceResult {
    this.#requireCapability("item:write");
    const parsed = DynaOrganizePlaceInputSchema.parse(input);
    return this.#canonicalMutation(
      dashboardId,
      itemId,
      parsed.requestId,
      "item.place",
      { expectedRevision, expectedFingerprint, input: parsed },
      (value) => DynaItemPlaceResultSchema.parse(value),
      (unitOfWork) => {
        const dashboard = unitOfWork.findDashboardState(dashboardId);
        if (dashboard?.revision !== expectedRevision) {
          throw new DynaCliError(
            "stale_dashboard",
            "The Dyna dashboard changed; run item show before moving this item.",
          );
        }
        const item = unitOfWork.findItemBase(itemId);
        if (item?.fingerprint !== expectedFingerprint) {
          throw new DynaCliError(
            "stale_item",
            "The Dyna item changed; run item show before moving it.",
          );
        }
        const positioned = this.#positionedItems(unitOfWork, dashboardId);
        const source = positioned.find((candidate) => candidate.id === itemId);
        if (!source) {
          throw new DynaCliError(
            "archived_item",
            "Archived Dyna items cannot be placed; restore the item first.",
          );
        }
        if (source.workflowState === "completed") {
          throw new DynaCliError(
            "completed_item",
            "Completed Dyna items cannot be placed; create a follow-up for continued work.",
          );
        }
        const placement = this.#placeProjectedItem(
          unitOfWork,
          dashboardId,
          positioned,
          itemId,
          parsed.targetPriority,
          parsed.beforeItemId,
          "cli",
        );
        return DynaItemPlaceResultSchema.parse({
          schema: "dyna/item-place-result-v1",
          requestId: parsed.requestId,
          itemId,
          changed: placement.changed,
          deduplicated: false,
        });
      },
    );
  }

  placeMany(
    dashboardId: string,
    expectedRevision: number,
    input: DynaOrganizePlaceManyInput,
  ): DynaPlaceManyResult {
    this.#requireCapability("item:write");
    const parsed = DynaOrganizePlaceManyInputSchema.parse(input);
    const items = [...parsed.items].sort((left, right) => left.itemId.localeCompare(right.itemId));
    const anchor = items[0];
    if (!anchor) {
      throw new DynaCliError(
        "invalid_input",
        "Select between 1 and 200 Dyna items to change their priority group.",
      );
    }
    return this.#canonicalMutation(
      dashboardId,
      anchor.itemId,
      parsed.requestId,
      "organize.place-many",
      { expectedRevision, items, targetPriority: parsed.targetPriority },
      (value) => DynaPlaceManyResultSchema.parse(value),
      (unitOfWork) => {
        const dashboard = unitOfWork.findDashboardState(dashboardId);
        if (dashboard?.revision !== expectedRevision) {
          throw new DynaCliError(
            "stale_dashboard",
            "The Dyna dashboard changed; refresh before moving these items.",
          );
        }
        const placement = this.#placeProjectedItemsAsBlock(
          unitOfWork,
          dashboardId,
          this.#positionedItems(unitOfWork, dashboardId),
          items,
          parsed.targetPriority,
          "cli",
        );
        return DynaPlaceManyResultSchema.parse({
          schema: "dyna/place-many-result-v1",
          requestId: parsed.requestId,
          dashboardId,
          changed: placement.changed,
          changedCount: placement.changedCount,
          deduplicated: false,
        });
      },
    );
  }

  archiveItem(
    dashboardId: string,
    itemId: string,
    expectedRevision: number,
    expectedFingerprint: string,
    input: DynaLifecycleArchiveInput,
  ): DynaItemArchiveResult {
    this.#requireCapability("item:write");
    const parsed = DynaLifecycleArchiveInputSchema.parse(input);
    return this.#canonicalMutation(
      dashboardId,
      itemId,
      parsed.requestId,
      "item.archive",
      { expectedRevision, expectedFingerprint, input: parsed },
      (value) => DynaItemArchiveResultSchema.parse(value),
      (unitOfWork) => {
        const dashboard = unitOfWork.findDashboardState(dashboardId);
        if (dashboard?.revision !== expectedRevision) {
          throw new DynaCliError(
            "stale_dashboard",
            "The Dyna dashboard changed; run item show before archiving this item.",
          );
        }
        const positioned = this.#positionedItem(unitOfWork, dashboardId, itemId);
        if (!positioned) {
          throw new DynaCliError("archived_item", "The Dyna item is already archived.");
        }
        if (positioned.fingerprint !== expectedFingerprint) {
          throw new DynaCliError(
            "stale_item",
            "The Dyna item changed; run item show before archiving it.",
          );
        }
        if (parsed.reason === "completed" && positioned.workflowState !== "completed") {
          throw new DynaCliError(
            "invalid_input",
            "Only controller-confirmed completed work can use the Completed disposition.",
          );
        }
        const taskEvidence = unitOfWork.completionEvidence(itemId);
        const completedAtMs =
          positioned.workflowState === "completed"
            ? (taskEvidence.completedAtMs ?? positioned.userWorkflowCreatedMs)
            : undefined;
        const outcome =
          positioned.workflowState === "completed"
            ? (taskEvidence.outcome ?? positioned.userWorkflowOutcome)
            : undefined;
        const archiveId = randomUUID();
        const archivedAt = this.#now();
        unitOfWork.insertArchive({
          id: archiveId,
          dashboardId,
          itemId,
          reason: parsed.reason,
          ...(parsed.reasonDetail ? { reasonDetail: parsed.reasonDetail } : {}),
          mode: "manual",
          archivedAt,
          fingerprint: positioned.fingerprint,
          workflowState: positioned.workflowState,
          ...(completedAtMs !== undefined ? { completedAtMs } : {}),
          ...(outcome ? { outcome } : {}),
          priority: positioned.effectivePriority,
          ...(positioned.preferenceSequence !== undefined
            ? { sequence: positioned.preferenceSequence }
            : {}),
        });
        unitOfWork.touchDashboards([dashboardId], archivedAt);
        unitOfWork.appendAudit(`item.archived.${parsed.reason}.manual.cli`, itemId, archivedAt);
        return DynaItemArchiveResultSchema.parse({
          schema: "dyna/item-archive-result-v1",
          requestId: parsed.requestId,
          itemId,
          archiveId,
          archivedAt,
          reason: parsed.reason,
          deduplicated: false,
        });
      },
    );
  }

  restoreItem(
    dashboardId: string,
    itemId: string,
    expectedRevision: number,
    expectedFingerprint: string,
    input: DynaLifecycleRestoreInput,
  ): DynaItemRestoreResult {
    this.#requireCapability("item:write");
    const parsed = DynaLifecycleRestoreInputSchema.parse(input);
    return this.#canonicalMutation(
      dashboardId,
      itemId,
      parsed.requestId,
      "item.restore",
      { expectedRevision, expectedFingerprint },
      (value) => DynaItemRestoreResultSchema.parse(value),
      (unitOfWork) => {
        const dashboard = unitOfWork.findDashboardState(dashboardId);
        if (dashboard?.revision !== expectedRevision) {
          throw new DynaCliError(
            "stale_dashboard",
            "The Dyna dashboard changed; run item show before restoring this item.",
          );
        }
        const item = unitOfWork.findItemBase(itemId);
        if (item?.fingerprint !== expectedFingerprint) {
          throw new DynaCliError(
            "stale_item",
            "The Dyna item changed; run item show before restoring it.",
          );
        }
        const archive = unitOfWork.findOpenArchive(dashboardId, itemId);
        if (!archive) {
          throw new DynaCliError(
            "invalid_input",
            "The Dyna item is not currently archived in this dashboard.",
          );
        }
        const restoredAt = this.#now();
        if (!unitOfWork.restoreArchive(archive.id, restoredAt)) {
          throw new DynaCliError(
            "invalid_input",
            "The Dyna item is not currently archived in this dashboard.",
          );
        }
        unitOfWork.touchDashboards([dashboardId], restoredAt);
        unitOfWork.appendAudit("item.restored.cli", itemId, restoredAt);
        return DynaItemRestoreResultSchema.parse({
          schema: "dyna/item-restore-result-v1",
          requestId: parsed.requestId,
          itemId,
          restoredAt,
          deduplicated: false,
        });
      },
    );
  }

  createTodo(dashboardId: string, input: DynaTodoCreateInput): DynaTodoCreateResult {
    this.#requireCapability("item:write");
    const parsed = DynaTodoCreateInputSchema.parse(input);
    const { requestId, ...todoInput } = parsed;
    const todo = DynaTodoInputSchema.parse(todoInput);
    return this.#repository.write((unitOfWork) =>
      this.#createTodoWithReceipt(unitOfWork, dashboardId, todo, requestId),
    );
  }

  createFollowUp(
    dashboardId: string,
    sourceItemId: string,
    expectedRevision: number,
    expectedFingerprint: string,
    input: DynaFollowUpCreateInput,
  ): DynaFollowUpCreateResult {
    this.#requireCapability("item:write");
    const parsed = DynaFollowUpCreateInputSchema.parse(input);
    const { requestId, ...todoInput } = parsed;
    const todo = DynaTodoInputSchema.parse({ ...todoInput, followUpOfItemId: sourceItemId });
    return this.#canonicalMutation(
      dashboardId,
      sourceItemId,
      requestId,
      "follow-up.create",
      { expectedRevision, expectedFingerprint, input: parsed },
      (value, unitOfWork) => {
        const current = DynaFollowUpCreateResultSchema.safeParse(value);
        if (current.success) return current.data;
        const legacy = LegacyDynaFollowUpCreateResultSchema.parse(value);
        if (legacy.requestId !== requestId || legacy.sourceItemId !== sourceItemId) {
          throw new DynaCliError(
            "request_conflict",
            "The stored Dyna follow-up receipt does not match this request.",
          );
        }
        const created = unitOfWork.findItemBase(legacy.itemId);
        const source = unitOfWork.findItemBase(legacy.sourceItemId);
        const createdContext = unitOfWork.loadItemContext(legacy.itemId);
        if (
          !created ||
          !source ||
          created.fingerprint !== legacy.fingerprint ||
          createdContext.followUpOfItemId !== legacy.sourceItemId
        ) {
          throw new Error("The stored Dyna follow-up receipt is inconsistent.");
        }
        return DynaFollowUpCreateResultSchema.parse({
          ...legacy,
          schema: "dyna/follow-up-create-result-v2",
          itemNumber: created.itemNumber,
          sourceItemNumber: source.itemNumber,
        });
      },
      (unitOfWork) => {
        const dashboard = unitOfWork.findDashboardState(dashboardId);
        if (dashboard?.revision !== expectedRevision) {
          throw new DynaCliError(
            "stale_dashboard",
            "The Dyna dashboard changed; run item show before creating a follow-up.",
          );
        }
        const source = unitOfWork.findItemBase(sourceItemId);
        if (source?.fingerprint !== expectedFingerprint) {
          throw new DynaCliError(
            "stale_item",
            "The Dyna item changed; run item show before creating a follow-up.",
          );
        }
        const archived = unitOfWork.findOpenArchive(dashboardId, sourceItemId) !== undefined;
        const positioned = archived
          ? undefined
          : this.#positionedItem(unitOfWork, dashboardId, sourceItemId);
        if (!archived && positioned?.workflowState !== "completed") {
          throw new DynaCliError(
            "invalid_input",
            "Follow-ups can only be created from completed or archived Dyna items.",
          );
        }
        const created = this.#createManualItem(
          unitOfWork,
          dashboardId,
          todo,
          "Follow-up created from completed or archived Dyna work.",
          "Follow-up work created from Dyna.",
          sourceItemId,
        );
        unitOfWork.touchDashboards([dashboardId], created.instant);
        unitOfWork.appendAudit("todo.follow_up.created.cli", created.itemId, created.instant);
        return DynaFollowUpCreateResultSchema.parse({
          schema: "dyna/follow-up-create-result-v2",
          requestId,
          itemId: created.itemId,
          itemNumber: created.itemNumber,
          sourceItemId,
          sourceItemNumber: source.itemNumber,
          fingerprint: created.fingerprint,
          deduplicated: false,
        });
      },
    );
  }
}

export { RepositoryDynaCliStoreError as DynaCliStoreError };
export type { DynaItemProjection, DynaItemProjectionInput } from "./projector.js";

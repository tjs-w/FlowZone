import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

import {
  DynaActionItemContextSchema,
  DynaActionKindSchema,
  DynaActionRequestSchema,
  DynaAnnotationSchema,
  DynaBacklogStateSchema,
  DynaArchiveReasonSchema,
  DynaArchiveStateSchema,
  DynaCodexSessionCandidatesSchema,
  DynaCredentialModeSchema,
  DynaDashboardSchema,
  DynaItemContextSchema,
  DynaItemHistorySchema,
  DynaItemBacklogResultSchema,
  DynaItemStatusResultSchema,
  DynaMaterializedItemSchema,
  DynaPrioritySchema,
  DynaPublishSourceSlicesSchema,
  DynaPublishedItemSchema,
  DynaPublisherSchema,
  DynaRequiredSourceSlicesSchema,
  DynaScheduledPublishedItemSchema,
  DynaSourceRefSchema,
  DynaTaskStatusSchema,
  DynaTaskSyncScopeSchema,
  DynaTodoCreateInputSchema,
  DynaTodoCreateResultSchema,
  DynaTodoInputSchema,
  DynaSetItemStatusInputSchema,
  DynaSetItemBacklogInputSchema,
  DynaUserWorkflowEventSchema,
  DynaUserWorkflowStageSchema,
  DynaWorkActivityPageSchema,
  DynaWorkUpdateSchema,
  dynaLeadershipScore,
  type DynaAnnotation,
  type DynaBacklogState,
  type DynaCard,
  type DynaArchiveReason,
  type DynaCodexSessionCandidate,
  type DynaCredentialMode,
  type DynaDashboard,
  type DynaItemContext,
  type DynaItemHistory,
  type DynaItemBacklogResult,
  type DynaItemNumber,
  type DynaItemStatusResult,
  type DynaPublishedItem,
  type DynaPublishSourceSlice,
  type DynaPublisher,
  type DynaRequiredSourceSlice,
  type DynaTaskStatus,
  type DynaTaskSyncScope,
  type DynaTodoCreateInput,
  type DynaTodoCreateResult,
  type DynaTodoInput,
  type DynaSetItemStatusInput,
  type DynaSetItemBacklogInput,
  type DynaUserWorkflowEvent,
  type DynaUserWorkflowStage,
  type DynaWorkActivityPage,
  type DynaWorkUpdate,
  type DynaCliErrorCode,
} from "@flowzone/dyna-contracts";
import {
  DynaTaskSyncObservationSchema,
  type DynaTaskSyncObservation,
} from "@flowzone/dyna-contracts/controller";
import type { z } from "zod";

type DynaActionKind = z.infer<typeof DynaActionKindSchema>;
type DynaPriority = z.infer<typeof DynaPrioritySchema>;
type SqlRow = Readonly<Record<string, unknown>>;

export class DynaCliStoreError extends Error {
  readonly code: DynaCliErrorCode;

  constructor(code: DynaCliErrorCode, message: string) {
    super(message);
    this.name = "DynaCliStoreError";
    this.code = code;
  }
}

class DynaCommittedMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DynaCommittedMutationError";
  }
}

export type DynaPersistenceOutcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Error };

export interface DynaCliEnrichmentInput {
  readonly requestId: string;
  readonly summary?: string | undefined;
  readonly priority?: string | undefined;
  readonly priorityReason?: string | undefined;
  readonly dueAt?: string | null | undefined;
  readonly labels?: readonly string[] | undefined;
  readonly people?: DynaPublishedItem["people"] | undefined;
  readonly attention?: string | undefined;
  readonly plan?: readonly string[] | undefined;
  readonly nextSteps?: DynaPublishedItem["nextSteps"] | undefined;
  readonly provenance: string;
}

export interface DynaCliPlacementInput {
  readonly requestId: string;
  readonly targetPriority: DynaPriority;
  readonly beforeItemId?: string | undefined;
}

export interface DynaCliArchiveInput {
  readonly requestId: string;
  readonly reason: DynaArchiveReason;
  readonly reasonDetail?: string | undefined;
}

export interface DynaCliFollowUpInput {
  readonly requestId: string;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly priority: DynaPriority;
  readonly labels: readonly string[];
  readonly attention?: string | undefined;
}

const VIEW_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const ACTION_TTL_MS = 10 * 60 * 1_000;
const CODEX_SESSION_CANDIDATE_TTL_MS = 10 * 60 * 1_000;
const CLAIM_LEASE_MS = 5 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const DYNA_SCHEMA_VERSION = 12;
const MAX_SAFE_ITEM_NUMBER = Number.MAX_SAFE_INTEGER;
const MAX_DASHBOARDS = 100;
const MAX_PUBLISHERS = 100;
const MAX_SCHEDULES_PER_DASHBOARD = 50;
const MAX_TASK_BINDINGS_PER_ITEM = 8;
const MAX_TASK_SYNC_TARGETS = 200;
const MAX_CODEX_SESSION_CANDIDATE_LISTS = 100;
const MAX_CODEX_SESSION_ATTACH_AUTHORIZATIONS = 200;
const MAX_PUBLIC_FAILURE_LENGTH = 500;
const MAX_FAILURE_SANITIZATION_INPUT = 4_096;
const MAX_WORK_UPDATES_PER_CARD = 1;
const MAX_HISTORY_PAGE_SIZE = 50;
const MAX_ACTIVITY_PAGE_SIZE = 25;
const MAX_HISTORY_CURSOR_LENGTH = 256;
const MAX_MATCHED_ACTIVITY_LENGTH = 500;
const LEGACY_COMPLETION_OUTCOME =
  "Completed before outcome tracking; refresh this task for details.";
const LEGACY_UNSPECIFIED_FAILURE = "An earlier operation reported an unspecified failure.";

/**
 * Persistence-only membership query used by the application projector. It deliberately
 * returns raw source, enrichment, preference, workflow, and archive facts: lifecycle,
 * priority, blocked-state, and queue-position decisions are made in service.ts.
 */
function dynaProjectionMembershipCte(scope: "active" | "archive" = "active"): string {
  const membership =
    scope === "archive"
      ? `JOIN item_archive_events ar ON ar.item_id = i.id
          AND ar.dashboard_id = ?1 AND ar.restored_at IS NULL
         JOIN dashboard_publishers dp ON dp.dashboard_id = ar.dashboard_id
          AND dp.publisher_id = i.publisher_id
         LEFT JOIN publisher_items pi ON pi.item_id = i.id AND pi.publisher_id = i.publisher_id`
      : `JOIN publisher_items pi ON pi.item_id = i.id
         JOIN dashboard_publishers dp ON dp.publisher_id = pi.publisher_id
         LEFT JOIN item_archive_events ar ON ar.item_id = i.id
          AND ar.dashboard_id = dp.dashboard_id AND ar.restored_at IS NULL`;
  const visibility =
    scope === "archive"
      ? "1 = 1"
      : `(pi.active = 1 OR EXISTS (
          SELECT 1 FROM item_archive_events restored
          WHERE restored.dashboard_id = dp.dashboard_id AND restored.item_id = i.id
            AND restored.restored_at IS NOT NULL
        )) AND ar.id IS NULL AND dp.dashboard_id = ?1`;
  return `
    WITH projection_membership AS (
      SELECT DISTINCT i.*, item_number.number AS item_number,
        follow_up.source_item_id AS follow_up_reference_item_id,
        follow_up.source_item_number AS follow_up_of_item_number,
        dp.dashboard_id AS membership_dashboard_id,
        e.summary AS enrichment_summary,
        e.priority AS enrichment_priority,
        e.priority_reason AS enrichment_priority_reason,
        e.due_at AS enrichment_due_at,
        e.due_at_set AS enrichment_due_at_set,
        e.labels AS enrichment_labels,
        e.people AS enrichment_people,
        e.leadership_score AS enrichment_leadership_score,
        e.attention AS enrichment_attention,
        e.plan AS enrichment_plan,
        e.next_steps AS enrichment_next_steps,
        e.base_fingerprint AS enrichment_base_fingerprint,
        e.base_source_updated_at AS enrichment_base_source_updated_at,
        e.applied_at AS enrichment_applied_at,
        e.provenance AS enrichment_provenance,
        e.version AS enrichment_version,
        p.priority_override AS preference_priority,
        p.sequence AS preference_sequence,
        p.backlogged_at AS preference_backlogged_at,
        p.backlog_until AS preference_backlog_until,
        ar.id AS archive_id,
        ar.reason AS archive_reason,
        ar.reason_detail AS archive_reason_detail,
        ar.mode AS archive_mode,
        ar.archived_at AS archive_archived_at,
        ar.completed_at AS archive_completed_at,
        ar.outcome_at_archive AS archive_outcome,
        ar.workflow_state AS archive_workflow_state,
        ar.fingerprint_at_archive AS archive_fingerprint,
        user_workflow.target_stage AS user_workflow_stage,
        user_workflow.outcome AS user_workflow_outcome,
        user_workflow.created_at AS user_workflow_created_at,
        user_workflow.created_at_ms AS user_workflow_created_ms,
        user_workflow.task_id AS user_workflow_task_id,
        user_workflow.host_id AS user_workflow_host_id,
        user_workflow.task_title AS user_workflow_task_title,
        user_workflow.work_attempt_id AS user_workflow_work_attempt_id,
        (SELECT MAX(history.restored_at_ms) FROM item_archive_events history
          WHERE history.dashboard_id = dp.dashboard_id AND history.item_id = i.id
        ) AS last_restored_at_ms
      FROM items i
      JOIN item_numbers item_number ON item_number.item_id = i.id
      LEFT JOIN item_follow_ups follow_up ON follow_up.item_id = i.id
      ${membership}
      LEFT JOIN item_enrichments e ON e.item_id = i.id
      LEFT JOIN item_preferences p ON p.item_id = i.id AND p.dashboard_id = dp.dashboard_id
      LEFT JOIN item_workflow_events user_workflow ON user_workflow.rowid = (
        SELECT candidate.rowid FROM item_workflow_events candidate
        WHERE candidate.item_id = i.id
        ORDER BY candidate.created_at_ms DESC, candidate.rowid DESC LIMIT 1
      )
      WHERE ${visibility}
    ), projection_ranked AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY identity_key ORDER BY source_updated_ms DESC, updated_at DESC, id
      ) AS identity_rank
      FROM projection_membership
    ), projection_items AS (
      SELECT * FROM projection_ranked WHERE identity_rank = 1
    )
  `;
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

export interface DynaArchiveResult {
  readonly archiveId: string;
  readonly itemId: string;
  readonly archivedAt: string;
  readonly reason: DynaArchiveReason;
  readonly mode: "manual" | "automatic";
}

export interface DynaItemHistoryOptions {
  readonly limit?: number | undefined;
  readonly archiveCursor?: string | undefined;
  readonly orderCursor?: string | undefined;
  readonly statusCursor?: string | undefined;
  readonly annotationCursor?: string | undefined;
  readonly workCursor?: string | undefined;
}

export interface DynaItemActivityOptions {
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

type DynaSnapshotScope = "active" | "archive";
type DynaHistoryStream = "archive" | "order" | "status" | "annotation" | "work";

interface DynaHistoryCursor {
  readonly createdAtMs: number;
  readonly insertionSequence: number;
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function pageSize(value: number | undefined, maximum: number): number {
  const size = value ?? maximum;
  if (!Number.isInteger(size) || size < 1 || size > maximum) {
    throw new DynaCliStoreError(
      "invalid_input",
      `A Dyna page size must be between 1 and ${maximum}.`,
    );
  }
  return size;
}

function historyCursor(
  stream: DynaHistoryStream,
  createdAtMs: number,
  insertionSequence: number,
): string {
  if (
    !Number.isSafeInteger(createdAtMs) ||
    createdAtMs < 0 ||
    !Number.isSafeInteger(insertionSequence) ||
    insertionSequence < 1
  ) {
    throw new Error("Dyna stored history ordering data is invalid.");
  }
  return Buffer.from(JSON.stringify([1, stream, createdAtMs, insertionSequence]), "utf8").toString(
    "base64url",
  );
}

function parseHistoryCursor(
  value: string | undefined,
  expectedStream: DynaHistoryStream,
): DynaHistoryCursor | undefined {
  if (value === undefined) return undefined;
  if (
    value.length < 1 ||
    value.length > MAX_HISTORY_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new DynaCliStoreError("invalid_input", "The Dyna history cursor is invalid.");
  }
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new Error("noncanonical");
    const parsed = JSON.parse(decoded.toString("utf8")) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 4 ||
      parsed[0] !== 1 ||
      parsed[1] !== expectedStream ||
      !Number.isSafeInteger(parsed[2]) ||
      (parsed[2] as number) < 0 ||
      !Number.isSafeInteger(parsed[3]) ||
      (parsed[3] as number) < 1
    ) {
      throw new Error("shape");
    }
    return { createdAtMs: parsed[2] as number, insertionSequence: parsed[3] as number };
  } catch {
    throw new DynaCliStoreError("invalid_input", "The Dyna history cursor is invalid.");
  }
}

function matchingFragment(
  value: string,
  terms: readonly string[],
  maximumLength: number,
): string | undefined {
  const lower = value.toLocaleLowerCase();
  const matchIndexes = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
  if (matchIndexes.length === 0) return undefined;
  if (value.length <= maximumLength) return value;
  const matchIndex = Math.min(...matchIndexes);
  const prefixLength = Math.min(matchIndex, Math.floor(maximumLength / 3));
  const start = matchIndex - prefixLength;
  const leading = start > 0 ? "…" : "";
  const available = maximumLength - leading.length - 1;
  const body = value.slice(start, start + available);
  const trailing = start + body.length < value.length ? "…" : "";
  return `${leading}${body}${trailing}`.slice(0, maximumLength);
}

function matchedActivitySummary(
  update: DynaWorkUpdate,
  terms: readonly string[],
): string | undefined {
  const candidates: { value: string; prefix: string; suffix: string }[] = [
    { value: update.body, prefix: "", suffix: "" },
    { value: update.kind, prefix: "Update: ", suffix: "" },
  ];
  if (update.outcome) candidates.push({ value: update.outcome, prefix: "Outcome: ", suffix: "" });
  if (update.task) {
    candidates.push({ value: update.task.taskId, prefix: "Codex task ID: ", suffix: "" });
    candidates.push({ value: update.task.hostId, prefix: "Codex host: ", suffix: "" });
    if (update.task.title) {
      candidates.push({ value: update.task.title, prefix: "Codex task: ", suffix: "" });
    }
  }
  for (const artifact of update.artifacts) {
    candidates.push({ value: artifact.kind, prefix: "Artifact type: ", suffix: "" });
    candidates.push({ value: artifact.label, prefix: "Artifact: ", suffix: "" });
  }
  for (const artifact of update.artifacts) {
    candidates.push({
      value: artifact.url,
      prefix: `Artifact: ${artifact.label} (`,
      suffix: ")",
    });
  }

  const distinctTerms = [...new Set(terms.map((term) => term.toLocaleLowerCase()))];
  let best: { value: string; prefix: string; suffix: string; matchedTermCount: number } | undefined;
  for (const candidate of candidates) {
    const lower = candidate.value.toLocaleLowerCase();
    const matchedTermCount = distinctTerms.filter((term) => lower.includes(term)).length;
    if (matchedTermCount > (best?.matchedTermCount ?? 0)) {
      best = { ...candidate, matchedTermCount };
    }
  }
  if (!best) return undefined;

  const fragment = matchingFragment(
    best.value,
    terms,
    MAX_MATCHED_ACTIVITY_LENGTH - best.prefix.length - best.suffix.length,
  );
  return fragment ? `${best.prefix}${fragment}${best.suffix}` : undefined;
}

function activitySearchSql(alias: string): string {
  return `lower(
    ${alias}.kind || ' ' || ${alias}.body || ' ' || COALESCE(${alias}.outcome, '') || ' ' ||
    COALESCE(${alias}.task_id, '') || ' ' || COALESCE(${alias}.host_id, '') || ' ' ||
    COALESCE(${alias}.task_title, '') || ' ' || COALESCE((
      SELECT group_concat(
        COALESCE(json_extract(activity_artifact.value, '$.kind'), '') || ' ' ||
        COALESCE(json_extract(activity_artifact.value, '$.label'), '') || ' ' ||
        COALESCE(json_extract(activity_artifact.value, '$.url'), ''),
        ' '
      )
      FROM json_each(${alias}.artifacts) activity_artifact
    ), '')
  )`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function scopedUuid(scope: readonly string[]): string {
  const digest = sha256(JSON.stringify(["dyna/scoped-uuid-v1", ...scope]));
  const variant = ((Number.parseInt(digest[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function tokenHash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function hashesMatch(value: string, stored: unknown): boolean {
  if (!(stored instanceof Uint8Array)) return false;
  const candidate = tokenHash(value);
  const expected = Buffer.from(stored);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function storedTokenHashKey(stored: unknown): string | undefined {
  return stored instanceof Uint8Array ? Buffer.from(stored).toString("hex") : undefined;
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function requiredString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Dyna database column ${key} is invalid.`);
  return value;
}

function optionalString(row: SqlRow, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" ? value : undefined;
}

function followUpReferenceItemId(row: SqlRow): string | undefined {
  return (
    optionalString(row, "follow_up_reference_item_id") ??
    optionalString(row, "follow_up_of_item_id")
  );
}

function requiredNumber(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new Error(`Dyna database column ${key} is invalid.`);
  return value;
}

function requiredItemNumber(row: SqlRow, key: string): number {
  const value = requiredNumber(row, key);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SAFE_ITEM_NUMBER) {
    throw new Error(`Dyna database column ${key} is not a safe item number.`);
  }
  return value;
}

function publisherCredentialModeFromRow(row: SqlRow): DynaCredentialMode {
  if (requiredNumber(row, "local_cli_enabled") === 1) return "local_cli";
  return DynaCredentialModeSchema.parse(requiredString(row, "credential_mode"));
}

function publicSafeFailureCharacters(value: string): string {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    const unsafe =
      codePoint === undefined ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      (codePoint >= 0x2028 && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069);
    result += unsafe ? " " : character;
  }
  return result;
}

function sanitizePublicFailureMessage(value: unknown): string {
  if (typeof value !== "string") throw new Error("A Dyna failure message must be text.");
  let sanitized = publicSafeFailureCharacters(value.slice(0, MAX_FAILURE_SANITIZATION_INPUT))
    .replace(/\s+/g, " ")
    .trim();
  if (!sanitized) throw new Error("A Dyna failure message cannot be empty.");

  sanitized = sanitized
    .replace(
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----.*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/gi,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi, "$1[REDACTED]@")
    .replace(
      /\bauthorization\s*[:=]\s*(?:(?:bearer|basic)\s+)?[^\s,;]+/gi,
      "authorization=[REDACTED]",
    )
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{4,}/gi, "$1 [REDACTED]")
    .replace(
      /\b([A-Za-z0-9_-]*(?:password|passwd|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|token|authorization|private[-_]?key)[A-Za-z0-9_-]*|client[-_ ]secret|api[-_ ]key|access[-_ ]token|refresh[-_ ]token|aws[-_ ]secret[-_ ]access[-_ ]key|private[-_ ]key)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /\b(?:glpat-[A-Za-z0-9_-]{8,}|xox[a-z]-[A-Za-z0-9-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/gi,
      "[REDACTED]",
    )
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, "[REDACTED]");
  return sanitized.slice(0, MAX_PUBLIC_FAILURE_LENGTH).trimEnd();
}

function sanitizePersistedFailureMessage(value: string): string {
  try {
    return sanitizePublicFailureMessage(value);
  } catch {
    return LEGACY_UNSPECIFIED_FAILURE;
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Dyna stored data is invalid.");
  }
}

function normalizeTimestamp(value: string, rejectFuture = false): { iso: string; epoch: number } {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) throw new Error("Dyna received an invalid timestamp.");
  if (rejectFuture && epoch > Date.now() + MAX_CLOCK_SKEW_MS) {
    throw new Error("Dyna source timestamps cannot be more than five minutes in the future.");
  }
  return { iso: new Date(epoch).toISOString(), epoch };
}

function identityKey(publisherId: string, sourceRef: unknown): string {
  return sha256(JSON.stringify([publisherId, DynaSourceRefSchema.parse(sourceRef)]));
}

function normalizedPublishedItem(item: DynaPublishedItem): DynaPublishedItem {
  const parsed = DynaPublishedItemSchema.parse(item);
  return DynaPublishedItemSchema.parse({
    ...parsed,
    sourceUpdatedAt: normalizeTimestamp(parsed.sourceUpdatedAt, true).iso,
    ...(parsed.dueAt ? { dueAt: normalizeTimestamp(parsed.dueAt).iso } : {}),
  });
}

function normalizedScheduledPublishedItem(item: DynaPublishedItem): DynaPublishedItem {
  return DynaScheduledPublishedItemSchema.parse(normalizedPublishedItem(item));
}

function publishSourceSliceKey(source: string, sourceScope: string): string {
  return JSON.stringify([source, sourceScope]);
}

function comparePublishSourceSlices(
  left: Readonly<{ source: string; sourceScope: string }>,
  right: Readonly<{ source: string; sourceScope: string }>,
): number {
  const leftKey = publishSourceSliceKey(left.source, left.sourceScope);
  const rightKey = publishSourceSliceKey(right.source, right.sourceScope);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function normalizedRequiredSourceSlices(
  slices: readonly DynaRequiredSourceSlice[],
): DynaRequiredSourceSlice[] {
  return [...DynaRequiredSourceSlicesSchema.parse(slices)].sort(comparePublishSourceSlices);
}

function requiredSourceSlicesFromRow(row: SqlRow): readonly DynaRequiredSourceSlice[] | undefined {
  const stored = row["required_source_slices"];
  if (stored === null || stored === undefined) return undefined;
  if (typeof stored !== "string") throw new Error("Dyna stored publisher manifest is invalid.");
  return normalizedRequiredSourceSlices(DynaRequiredSourceSlicesSchema.parse(parseJson(stored)));
}

function publishSourceSlicesFromRow(row: SqlRow): readonly DynaPublishSourceSlice[] | undefined {
  const stored = row["latest_source_slices"];
  if (stored === null || stored === undefined) return undefined;
  if (typeof stored !== "string") throw new Error("Dyna stored publish source slices are invalid.");
  return [...DynaPublishSourceSlicesSchema.parse(parseJson(stored))].sort(
    comparePublishSourceSlices,
  );
}

export function defaultDynaDatabasePath(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment["FLOWZONE_DATA_DIR"];
  if (configured?.trim()) return resolve(configured, "dyna.sqlite3");
  if (platform() === "win32") {
    return join(environment["LOCALAPPDATA"] ?? homedir(), "Codex", "FlowZone", "dyna.sqlite3");
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "Codex", "FlowZone", "dyna.sqlite3");
  }
  return join(
    environment["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share"),
    "codex",
    "flowzone",
    "dyna.sqlite3",
  );
}

export interface DynaStoreOptions {
  readonly databasePath?: string;
  readonly clock?: () => Date;
}

export interface ClaimedDynaAction {
  readonly request: z.infer<typeof DynaActionRequestSchema>;
  readonly claimToken: string;
  readonly context: {
    readonly item?: z.infer<typeof DynaActionItemContextSchema>;
    readonly task?: DynaTaskStatus;
  };
}

interface CachedCodexSessionCandidates {
  readonly dashboardId: string;
  readonly itemId: string;
  readonly viewTokenHash: string;
  readonly expiresAtMs: number;
  readonly candidates: readonly DynaCodexSessionCandidate[];
}

interface CachedCodexSessionAttachAuthorization {
  readonly sessionListRequestId: string;
  readonly expiresAtMs: number;
}

export type DynaTaskSyncRunState =
  | "prepared"
  | "delivered"
  | "claimed"
  | "syncing"
  | "completed"
  | "partial"
  | "expired"
  | "unavailable";

export interface DynaRepositoryTaskSyncRun {
  readonly id: string;
  readonly dashboardId: string;
  readonly scope: DynaTaskSyncScope;
  readonly state: DynaTaskSyncRunState;
  readonly claimTokenHash?: string | undefined;
  readonly leaseExpiresAt?: string | undefined;
  readonly expiresAt: string;
  readonly totalTasks: number;
  readonly excessTasks: number;
  readonly processedTasks: number;
  readonly updatedItems: number;
  readonly unavailableTasks: number;
  readonly incompleteMetadataTasks: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string | undefined;
}

export interface DynaRepositoryTaskSyncCandidate {
  readonly itemId: string;
  readonly itemNumber: number;
  readonly taskTitle: string;
  readonly taskId: string;
  readonly hostId: string;
  readonly checkpointVersion: number;
  readonly cursor?: string | undefined;
  readonly lastTurnId?: string | undefined;
  readonly checkpointObservedAtMs?: number | undefined;
}

export type DynaTaskSyncTargetState = "pending" | "staged" | "unavailable" | "applied" | "skipped";

export interface DynaRepositoryTaskSyncTarget extends DynaRepositoryTaskSyncCandidate {
  readonly runId: string;
  readonly state: DynaTaskSyncTargetState;
  readonly observation?: DynaTaskSyncObservation | undefined;
  readonly unavailableReason?: string | undefined;
}

export interface DynaRepositoryTaskSyncCheckpoint {
  readonly taskId: string;
  readonly hostId: string;
  readonly version: number;
  readonly cursor?: string | undefined;
  readonly lastTurnId?: string | undefined;
  readonly statusUpdatedAt?: string | undefined;
  readonly observedAt?: string | undefined;
  readonly updatedAt?: string | undefined;
}

export interface DynaRepositoryTaskSyncReceipt {
  readonly id: string;
  readonly runId: string;
  readonly kind: "batch" | "observation" | "completion";
  readonly taskId?: string | undefined;
  readonly requestHash: string;
  readonly result?: unknown;
  readonly createdAt: string;
}

export interface DynaReadUnitOfWork {
  listDashboards(): DynaDashboard[];
  getDashboard(id: string): DynaDashboard;
  listPublishers(dashboardId?: string): DynaPublisher[];
  listProjectionItems(
    dashboardId: string,
    scope?: DynaSnapshotScope,
  ): readonly DynaRepositoryProjectionItem[];
  matchingProjectionItemIds(
    dashboardId: string,
    scope: DynaSnapshotScope,
    terms: readonly string[],
  ): ReadonlySet<string>;
  loadCardEvidence(
    itemIds: readonly string[],
    searchTerms?: readonly string[],
  ): readonly DynaRepositoryCardEvidence[];
  findDashboardState(dashboardId: string): DynaCliDashboardState | undefined;
  findItemBase(itemId: string): DynaCliItemBase | undefined;
  findTaskOwner(taskId: string): { readonly itemId: string; readonly hostId: string } | undefined;
  findLinkedTaskTitle(itemId: string, taskId: string, hostId: string): string | undefined;
  findWorkAttemptAttribution(
    itemId: string,
    workAttemptId: string,
  ): DynaCliWorkAttemptAttribution | undefined;
  currentEnrichmentVersion(itemId: string): number;
  countTaskBindingsForItem(itemId: string): number;
  findTaskAssociationReservation(requestId: string): DynaTaskAssociationReservation | undefined;
  findActiveTaskAssociationReservation(taskId: string): DynaTaskAssociationReservation | undefined;
  countActiveTaskAssociationReservationsForItem(itemId: string, excludedRequestId?: string): number;
  dashboardContainsItem(dashboardId: string, itemId: string): boolean;
  findOpenArchive(dashboardId: string, itemId: string): { readonly id: string } | undefined;
  findArchiveReceipt(
    dashboardId: string,
    requestId: string,
  ): { readonly requestHash: string; readonly result: DynaArchiveResult } | undefined;
  findRestoreReceipt(
    dashboardId: string,
    requestId: string,
  ):
    | {
        readonly requestHash: string;
        readonly itemId: string;
        readonly restoredAt: string;
      }
    | undefined;
  authorizeViewToken(viewToken: string, itemId?: string): string;
  loadItemContext(itemId: string): DynaItemContext;
  loadItemHistory(
    dashboardId: string,
    itemId: string,
    options?: DynaItemHistoryOptions,
  ): DynaItemHistory;
  loadItemActivityPage(
    dashboardId: string,
    itemId: string,
    options?: DynaItemActivityOptions,
  ): DynaWorkActivityPage;
  findWorkUpdate(id: string): DynaWorkUpdate | undefined;
  loadActionForView(
    viewToken: string,
    requestId: string,
  ): z.infer<typeof DynaActionRequestSchema> & {
    readonly candidates?: readonly DynaCodexSessionCandidate[] | undefined;
  };
  loadAction(requestId: string): z.infer<typeof DynaActionRequestSchema>;
  findAnnotation(id: string): DynaRepositoryAnnotationRecord | undefined;
  findAnnotationEvent(id: string): DynaRepositoryAnnotationEvent | undefined;
  listTaskSyncRuns(dashboardId: string, limit?: number): readonly DynaRepositoryTaskSyncRun[];
  findTaskSyncRun(runId: string): DynaRepositoryTaskSyncRun | undefined;
  listTaskSyncCandidates(
    dashboardId: string,
    scope: DynaTaskSyncScope,
    limit: number,
  ): { readonly candidates: readonly DynaRepositoryTaskSyncCandidate[]; readonly total: number };
  listTaskSyncTargets(runId: string): readonly DynaRepositoryTaskSyncTarget[];
  findTaskSyncCheckpoint(taskId: string): DynaRepositoryTaskSyncCheckpoint | undefined;
  findTaskSyncReceipt(id: string): DynaRepositoryTaskSyncReceipt | undefined;
}

export interface DynaCliReceiptRecord {
  readonly dashboardId: string;
  readonly operation: string;
  readonly itemId: string;
  readonly requestHash: string;
  readonly taskId?: string | undefined;
  readonly hostId?: string | undefined;
  readonly workAttemptId?: string | undefined;
  readonly resultTargetId?: string | undefined;
  readonly result: unknown;
}

export interface DynaTodoReceiptRecord {
  readonly requestHash: string;
  readonly itemId: string;
}

export interface DynaCliDashboardState {
  readonly archived: boolean;
  readonly revision: number;
}

export interface DynaCliItemBase {
  readonly id: string;
  readonly itemNumber: number;
  readonly fingerprint: string;
  readonly sourcePriority: DynaPriority;
  readonly sourceUpdatedAt: string;
}

export interface DynaCliPositionedItem {
  readonly id: string;
  readonly fingerprint: string;
  readonly effectivePriority: DynaPriority;
  readonly priorityPosition: number;
  readonly workflowState: DynaCard["workflowState"];
  readonly preferenceSequence?: number | undefined;
  readonly userWorkflowStage?: DynaUserWorkflowStage | undefined;
  readonly userWorkflowOutcome?: string | undefined;
  readonly userWorkflowCreatedMs?: number | undefined;
  readonly backlog?: DynaBacklogState | undefined;
}

export interface DynaRepositoryProjectionTask {
  readonly taskId: string;
  readonly hostId: string;
  readonly state: DynaTaskStatus["state"];
  readonly observedAtMs: number;
  readonly statusUpdatedAtMs: number;
  readonly statusUpdatedAt: string;
  readonly outcome?: string | undefined;
}

export interface DynaRepositoryProjectionWorkUpdate {
  readonly taskId: string;
  readonly hostId: string;
  readonly kind: DynaWorkUpdate["kind"];
  readonly body: string;
  readonly createdAtMs: number;
  readonly insertionSequence: number;
}

export interface DynaRepositoryProjectionEnrichment {
  readonly summary?: string | undefined;
  readonly priority?: DynaPriority | undefined;
  readonly priorityReason?: string | undefined;
  readonly dueAt?: string | undefined;
  readonly dueAtSet: boolean;
  readonly labels?: readonly string[] | undefined;
  readonly people?: DynaPublishedItem["people"] | undefined;
  readonly leadershipScore: number;
  readonly attention?: string | undefined;
  readonly plan?: readonly string[] | undefined;
  readonly nextSteps?: DynaPublishedItem["nextSteps"] | undefined;
  readonly baseFingerprint: string;
  readonly baseSourceUpdatedAt: string;
  readonly appliedAt: string;
  readonly provenance: string;
  readonly version: number;
}

export interface DynaRepositoryProjectionItem {
  readonly id: string;
  readonly itemNumber: number;
  readonly identityKey: string;
  readonly fingerprint: string;
  readonly base: DynaPublishedItem;
  readonly sourceLeadershipScore: number;
  readonly sourceUpdatedAtMs: number;
  readonly updatedAt: string;
  readonly followUpOfItemId?: string | undefined;
  readonly followUpOfItemNumber?: number | undefined;
  readonly enrichment?: DynaRepositoryProjectionEnrichment | undefined;
  readonly preferencePriority?: DynaPriority | undefined;
  readonly preferenceSequence?: number | undefined;
  readonly backlog?: DynaBacklogState | undefined;
  readonly userWorkflow?:
    | {
        readonly stage: z.infer<typeof DynaUserWorkflowStageSchema>;
        readonly outcome?: string | undefined;
        readonly task?: DynaWorkUpdate["task"] | undefined;
        readonly workAttemptId?: string | undefined;
        readonly createdAt: string;
        readonly createdAtMs: number;
      }
    | undefined;
  readonly archive?: z.infer<typeof DynaArchiveStateSchema> | undefined;
  readonly lastRestoredAtMs?: number | undefined;
  readonly tasks: readonly DynaRepositoryProjectionTask[];
  readonly workUpdates: readonly DynaRepositoryProjectionWorkUpdate[];
}

export interface DynaRepositoryCardEvidence {
  readonly itemId: string;
  readonly annotations: readonly DynaAnnotation[];
  readonly linkedTasks: readonly DynaTaskStatus[];
  readonly workUpdates: readonly DynaWorkUpdate[];
  readonly workUpdateCount: number;
  readonly matchedActivity?: string | undefined;
}

export interface DynaRepositoryAnnotationRecord extends DynaAnnotation {
  readonly deletedAt?: string | undefined;
}

export interface DynaRepositoryAnnotationEvent {
  readonly id: string;
  readonly annotationId: string;
  readonly itemId: string;
  readonly operation: "create" | "edit" | "delete";
  readonly requestHash: string;
  readonly resultVersion: number;
  readonly occurredAt: string;
  readonly taskId?: string | undefined;
  readonly hostId?: string | undefined;
  readonly taskTitle?: string | undefined;
  readonly workAttemptId?: string | undefined;
}

export interface DynaRepositoryTaskAttachmentBlocker {
  readonly code: "archived_item" | "completed_item" | "outside_dashboard";
  readonly message: string;
}

export type DynaTaskAssociationReservationState =
  "reserved" | "uncertain" | "consumed" | "released" | "expired";

export interface DynaTaskAssociationReservation {
  readonly requestId: string;
  readonly taskId: string;
  readonly itemId: string;
  readonly actionRequestId?: string | undefined;
  readonly state: DynaTaskAssociationReservationState;
  readonly expiresAt?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DynaCliWorkAttemptAttribution {
  readonly taskId?: string | undefined;
  readonly hostId?: string | undefined;
}

export interface DynaTaskMutationAttribution {
  readonly taskId: string;
  readonly hostId: string;
  readonly workAttemptId: string;
}

export interface DynaCliCompletionEvidence {
  readonly completedAtMs?: number | undefined;
  readonly outcome?: string | undefined;
}

export interface DynaCliEnrichmentRecord {
  readonly itemId: string;
  readonly summary?: string;
  readonly priority?: DynaPriority;
  readonly priorityReason?: string;
  readonly dueAt?: string;
  readonly dueAtSet: boolean;
  readonly labels?: readonly string[];
  readonly people?: DynaPublishedItem["people"];
  readonly leadershipScore: number;
  readonly attention?: string;
  readonly plan?: readonly string[];
  readonly nextSteps?: DynaPublishedItem["nextSteps"];
  readonly baseFingerprint: string;
  readonly baseSourceUpdatedAt: string;
  readonly appliedAt: string;
  readonly provenance: string;
}

export interface DynaCliPlacementWrite {
  readonly itemId: string;
  readonly priority: DynaPriority;
  readonly priorityOverride?: DynaPriority;
  readonly sequence: number;
  readonly action: "bump" | "lower" | "earlier" | "later" | "resequence";
}

export interface DynaCliArchiveInsert {
  readonly id: string;
  readonly dashboardId: string;
  readonly itemId: string;
  readonly reason: DynaArchiveReason;
  readonly reasonDetail?: string;
  readonly mode: "manual" | "automatic";
  readonly archivedAt: string;
  readonly fingerprint: string;
  readonly workflowState: DynaCard["workflowState"];
  readonly completedAtMs?: number;
  readonly outcome?: string;
  readonly priority: DynaPriority;
  readonly sequence?: number;
  readonly requestId?: string;
  readonly requestHash?: string;
}

export interface DynaCliManualItemInsert {
  readonly itemId: string;
  readonly publisherId: string;
  readonly published: DynaPublishedItem;
  readonly fingerprint: string;
  readonly instant: string;
  readonly followUpOfItemId?: string;
}

export interface DynaWriteUnitOfWork extends DynaReadUnitOfWork {
  appendAudit(eventKind: string, entityId: string, instant?: string): void;
  touchDashboards(dashboardIds: Iterable<string>, instant?: string): void;
  findCliReceipt(requestId: string): DynaCliReceiptRecord | undefined;
  insertCliReceipt(
    requestId: string,
    record: Omit<DynaCliReceiptRecord, "result"> & { readonly result: unknown },
    createdAt: string,
  ): void;
  findTodoReceipt(dashboardId: string, requestId: string): DynaTodoReceiptRecord | undefined;
  insertTodoReceipt(
    dashboardId: string,
    requestId: string,
    requestHash: string,
    itemId: string,
  ): void;
  insertTaskAssociationReservation(reservation: DynaTaskAssociationReservation): void;
  expireTaskAssociationReservations(expiredAt: string): number;
  transitionTaskAssociationReservation(
    requestId: string,
    state: DynaTaskAssociationReservationState,
    updatedAt: string,
  ): void;
  completionEvidence(itemId: string): DynaCliCompletionEvidence;
  findManualPublisher(dashboardId: string): string | undefined;
  countPublishers(): number;
  listDashboardIdsForItem(itemId: string): readonly string[];
  insertWorkUpdate(update: DynaWorkUpdate): void;
  replaceEnrichment(record: DynaCliEnrichmentRecord): number;
  writePlacements(
    dashboardId: string,
    writes: readonly DynaCliPlacementWrite[],
    instant: string,
  ): void;
  insertArchive(record: DynaCliArchiveInsert): void;
  restoreArchive(
    archiveId: string,
    restoredAt: string,
    request?: { readonly id: string; readonly hash: string },
  ): boolean;
  insertManualPublisher(dashboardId: string, publisherId: string, instant: string): void;
  insertManualItem(record: DynaCliManualItemInsert): void;
  insertAnnotation(annotation: DynaAnnotation): void;
  updateAnnotation(
    annotationId: string,
    expectedVersion: number,
    body: string,
    updatedAt: string,
    attribution?: DynaTaskMutationAttribution & { readonly taskTitle?: string | undefined },
  ): boolean;
  deleteAnnotation(
    annotationId: string,
    expectedVersion: number,
    deletedAt: string,
    attribution?: DynaTaskMutationAttribution & { readonly taskTitle?: string | undefined },
  ): boolean;
  insertAnnotationEvent(event: DynaRepositoryAnnotationEvent): void;
  insertUserWorkflowEvent(event: DynaUserWorkflowEvent): void;
  insertDashboard(dashboard: DynaDashboard): void;
  updateDashboardRecord(dashboard: DynaDashboard): void;
  deleteDashboardRecord(id: string): void;
  persistCreatePublisher(
    name: string,
    schedule:
      | {
          readonly id: string;
          readonly title: string;
          readonly state: "active" | "paused" | "unknown";
          readonly staleAfterMinutes?: number;
        }
      | undefined,
    requiredSourceSlices: readonly DynaRequiredSourceSlice[] | undefined,
    credentialMode: DynaCredentialMode,
  ): { readonly publisher: DynaPublisher; readonly secret?: string | undefined };
  persistRotatePublisherSecret(publisherId: string): string;
  persistEnableLocalCliPublisher(publisherId: string): void;
  persistRevokePublisher(publisherId: string, purgePublishedData: boolean): void;
  persistBindSchedule(
    dashboardId: string,
    publisherId: string,
    schedule: {
      readonly id: string;
      readonly title: string;
      readonly state: "active" | "paused" | "unknown";
      readonly staleAfterMinutes: number;
      readonly requiredSourceSlices?: readonly DynaRequiredSourceSlice[];
    },
  ): void;
  persistUnbindSchedule(dashboardId: string, publisherId: string): void;
  persistUpdateScheduleStatus(
    publisherId: string,
    schedule: {
      readonly title?: string;
      readonly state: "active" | "paused" | "unknown";
      readonly staleAfterMinutes?: number;
      readonly requiredSourceSlices?: readonly DynaRequiredSourceSlice[];
    },
  ): void;
  persistPublish(
    publisherId: string,
    secret: string | undefined,
    items: readonly DynaPublishedItem[],
    options: DynaPublishOptions,
    local: boolean,
  ): DynaPublishResult;
  persistCreateView(dashboardId: string): string;
  persistItemStatus(
    input: DynaSetItemStatusInput,
    positioned: DynaCliPositionedItem | undefined,
  ): DynaItemStatusResult;
  persistItemBacklog(
    input: DynaSetItemBacklogInput,
    positioned: DynaCliPositionedItem | undefined,
    backlog: DynaBacklogState,
  ): DynaItemBacklogResult;
  persistPrepareAction(
    viewToken: string,
    kind: DynaActionKind,
    values: {
      readonly itemId: string;
      readonly taskId?: string;
      readonly taskHostId?: string;
      readonly sessionListRequestId?: string;
      readonly expectedRevision: number;
      readonly expectedFingerprint: string;
      readonly idempotencyKey: string;
    },
    attachmentBlocker?: DynaRepositoryTaskAttachmentBlocker,
  ): DynaPersistenceOutcome<z.infer<typeof DynaActionRequestSchema>>;
  persistMarkDelivered(
    viewToken: string,
    requestId: string,
  ): z.infer<typeof DynaActionRequestSchema>;
  persistClaimAction(
    requestId: string,
    attachmentBlocker?: DynaRepositoryTaskAttachmentBlocker,
  ): DynaPersistenceOutcome<ClaimedDynaAction>;
  persistCompleteAction(
    requestId: string,
    claimToken: string,
    result:
      | {
          readonly outcome: "succeeded";
          readonly task?: DynaTaskStatus;
          readonly candidates?: readonly DynaCodexSessionCandidate[];
        }
      | {
          readonly outcome: "failed" | "needs_reconciliation";
          readonly failureMessage: string;
        },
    attachmentBlocker?: DynaRepositoryTaskAttachmentBlocker,
  ): z.infer<typeof DynaActionRequestSchema>;
  persistResolveActionReconciliation(
    requestId: string,
    resolution:
      | { readonly outcome: "task_linked"; readonly task: DynaTaskStatus }
      | { readonly outcome: "no_task_created"; readonly explanation: string },
    attachmentBlocker?: DynaRepositoryTaskAttachmentBlocker,
  ): z.infer<typeof DynaActionRequestSchema>;
  persistTaskStatus(itemId: string, status: DynaTaskStatus): void;
  persistTaskStatusForDashboard(
    dashboardId: string,
    itemId: string,
    status: DynaTaskStatus,
    attachmentBlocker?: DynaRepositoryTaskAttachmentBlocker,
    excludedReservationRequestId?: string,
  ): void;
  insertTaskSyncRun(run: DynaRepositoryTaskSyncRun): void;
  updateTaskSyncRun(run: DynaRepositoryTaskSyncRun): void;
  insertTaskSyncTargets(runId: string, targets: readonly DynaRepositoryTaskSyncCandidate[]): void;
  stageTaskSyncObservation(
    runId: string,
    taskId: string,
    observation: DynaTaskSyncObservation,
  ): boolean;
  stageTaskSyncUnavailable(runId: string, taskId: string, reason: string): boolean;
  markTaskSyncTarget(runId: string, taskId: string, state: "applied" | "skipped"): void;
  insertTaskSyncReceipt(receipt: DynaRepositoryTaskSyncReceipt): void;
  upsertTaskSyncCheckpoint(checkpoint: DynaRepositoryTaskSyncCheckpoint): void;
  persistTaskStatusForSync(itemId: string, status: DynaTaskStatus): boolean;
}

export class SqliteDynaRepository {
  readonly #database: DatabaseSync;
  readonly #clock: () => Date;
  #transactionDepth = 0;
  readonly #codexSessionCandidateLists = new Map<string, CachedCodexSessionCandidates>();
  readonly #codexSessionAttachAuthorizations = new Map<
    string,
    CachedCodexSessionAttachAuthorization
  >();

  constructor(options: DynaStoreOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
    const databasePath = options.databasePath ?? defaultDynaDatabasePath();
    if (databasePath !== ":memory:") {
      const dataDirectory = dirname(databasePath);
      mkdirSync(dataDirectory, { mode: 0o700, recursive: true });
      chmodSync(dataDirectory, 0o700);
      if (existsSync(databasePath)) {
        const status = lstatSync(databasePath);
        if (!status.isFile() || status.isSymbolicLink()) {
          throw new Error("The Dyna database path must be a regular file, not a link.");
        }
        chmodSync(databasePath, 0o600);
      }
    }
    this.#database = new DatabaseSync(databasePath, {
      allowExtension: false,
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    try {
      this.#migrateSchema();
    } catch (error: unknown) {
      this.#database.close();
      throw error;
    }
    if (databasePath !== ":memory:") {
      for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
        if (existsSync(path)) chmodSync(path, 0o600);
      }
    }
  }

  read<T>(operation: (unitOfWork: DynaReadUnitOfWork) => T): T {
    return this.#readTransaction(() => operation(this.#readUnitOfWork()));
  }

  write<T>(operation: (unitOfWork: DynaWriteUnitOfWork) => T): T {
    return this.#transaction(() =>
      operation({
        ...this.#readUnitOfWork(),
        appendAudit: (eventKind, entityId, instant) => {
          this.#audit(eventKind, entityId, instant);
        },
        touchDashboards: (dashboardIds, instant) => {
          this.#touchDashboards(dashboardIds, instant);
        },
        findCliReceipt: (requestId) => this.#findCliReceipt(requestId),
        insertCliReceipt: (requestId, record, createdAt) => {
          this.#insertCliReceipt(requestId, record, createdAt);
        },
        findTodoReceipt: (dashboardId, requestId) => this.#findTodoReceipt(dashboardId, requestId),
        insertTodoReceipt: (dashboardId, requestId, requestHash, itemId) => {
          this.#insertTodoReceipt(dashboardId, requestId, requestHash, itemId);
        },
        insertTaskAssociationReservation: (reservation) => {
          this.#insertTaskAssociationReservation(reservation);
        },
        expireTaskAssociationReservations: (expiredAt) =>
          this.#expireTaskAssociationReservations(expiredAt),
        transitionTaskAssociationReservation: (requestId, state, updatedAt) => {
          this.#transitionTaskAssociationReservation(requestId, state, updatedAt);
        },
        findOpenArchive: (dashboardId, itemId) => this.#findOpenArchive(dashboardId, itemId),
        findLinkedTaskTitle: (itemId, taskId, hostId) =>
          this.#findLinkedTaskTitle(itemId, taskId, hostId),
        findWorkAttemptAttribution: (itemId, workAttemptId) =>
          this.#findWorkAttemptAttribution(itemId, workAttemptId),
        currentEnrichmentVersion: (itemId) => this.#currentEnrichmentVersion(itemId),
        completionEvidence: (itemId) => this.#completionEvidence(itemId),
        findManualPublisher: (dashboardId) => this.#findManualPublisher(dashboardId),
        countPublishers: () => this.#countPublishers(),
        listDashboardIdsForItem: (itemId) => this.#listDashboardIdsForItem(itemId),
        insertWorkUpdate: (update) => {
          this.#insertCliWorkUpdate(update);
        },
        replaceEnrichment: (record) => this.#replaceCliEnrichment(record),
        writePlacements: (dashboardId, writes, instant) => {
          this.#writeCliPlacements(dashboardId, writes, instant);
        },
        insertArchive: (record) => {
          this.#insertCliArchive(record);
        },
        restoreArchive: (archiveId, restoredAt, request) =>
          this.#restoreCliArchive(archiveId, restoredAt, request),
        insertManualPublisher: (dashboardId, publisherId, instant) => {
          this.#insertCliManualPublisher(dashboardId, publisherId, instant);
        },
        insertManualItem: (record) => {
          this.#insertCliManualItem(record);
        },
        insertAnnotation: (annotation) => {
          this.#insertAnnotation(annotation);
        },
        updateAnnotation: (annotationId, expectedVersion, body, updatedAt, attribution) =>
          this.#updateAnnotation(annotationId, expectedVersion, body, updatedAt, attribution),
        deleteAnnotation: (annotationId, expectedVersion, deletedAt, attribution) =>
          this.#deleteAnnotation(annotationId, expectedVersion, deletedAt, attribution),
        insertAnnotationEvent: (event) => {
          this.#insertAnnotationEvent(event);
        },
        insertUserWorkflowEvent: (event) => {
          this.#insertUserWorkflowEvent(event);
        },
        insertDashboard: (dashboard) => {
          this.#insertDashboard(dashboard);
        },
        updateDashboardRecord: (dashboard) => {
          this.#updateDashboardRecord(dashboard);
        },
        deleteDashboardRecord: (id) => {
          this.#deleteDashboardRecord(id);
        },
        persistCreatePublisher: (name, schedule, requiredSourceSlices, credentialMode) =>
          this.createPublisher(name, schedule, requiredSourceSlices, credentialMode),
        persistRotatePublisherSecret: (publisherId) => this.rotatePublisherSecret(publisherId),
        persistEnableLocalCliPublisher: (publisherId) => {
          this.enableLocalCliPublisher(publisherId);
        },
        persistRevokePublisher: (publisherId, purgePublishedData) => {
          this.revokePublisher(publisherId, purgePublishedData);
        },
        persistBindSchedule: (dashboardId, publisherId, schedule) => {
          this.bindSchedule(dashboardId, publisherId, schedule);
        },
        persistUnbindSchedule: (dashboardId, publisherId) => {
          this.unbindSchedule(dashboardId, publisherId);
        },
        persistUpdateScheduleStatus: (publisherId, schedule) => {
          this.updateScheduleStatus(publisherId, schedule);
        },
        persistPublish: (publisherId, secret, items, options, local) =>
          local
            ? this.publishLocal(publisherId, items, options)
            : this.publish(publisherId, secret ?? "", items, options),
        persistCreateView: (dashboardId) => this.createView(dashboardId),
        persistItemStatus: (input, positioned) => this.setItemStatus(input, positioned),
        persistItemBacklog: (input, positioned, backlog) =>
          this.setItemBacklog(input, positioned, backlog),
        persistPrepareAction: (viewToken, kind, values, attachmentBlocker) => {
          try {
            return {
              ok: true as const,
              value: this.prepareAction(viewToken, kind, values, attachmentBlocker),
            };
          } catch (error: unknown) {
            if (error instanceof DynaCommittedMutationError) {
              return { ok: false as const, error };
            }
            throw error;
          }
        },
        persistMarkDelivered: (viewToken, requestId) => this.markDelivered(viewToken, requestId),
        persistClaimAction: (requestId, attachmentBlocker) => {
          try {
            return {
              ok: true as const,
              value: this.claimAction(requestId, attachmentBlocker),
            };
          } catch (error: unknown) {
            if (error instanceof DynaCommittedMutationError) {
              return { ok: false as const, error };
            }
            throw error;
          }
        },
        persistCompleteAction: (requestId, claimToken, result, attachmentBlocker) =>
          this.completeAction(requestId, claimToken, result, attachmentBlocker),
        persistResolveActionReconciliation: (requestId, resolution, attachmentBlocker) =>
          this.resolveActionReconciliation(requestId, resolution, attachmentBlocker),
        persistTaskStatus: (itemId, status) => {
          this.upsertTaskStatus(itemId, status);
        },
        persistTaskStatusForDashboard: (
          dashboardId,
          itemId,
          status,
          attachmentBlocker,
          excludedReservationRequestId,
        ) => {
          this.upsertTaskStatusForDashboard(
            dashboardId,
            itemId,
            status,
            attachmentBlocker,
            excludedReservationRequestId,
          );
        },
        insertTaskSyncRun: (run) => {
          this.#insertTaskSyncRun(run);
        },
        updateTaskSyncRun: (run) => {
          this.#updateTaskSyncRun(run);
        },
        insertTaskSyncTargets: (runId, targets) => {
          this.#insertTaskSyncTargets(runId, targets);
        },
        stageTaskSyncObservation: (runId, taskId, observation) =>
          this.#stageTaskSyncObservation(runId, taskId, observation),
        stageTaskSyncUnavailable: (runId, taskId, reason) =>
          this.#stageTaskSyncUnavailable(runId, taskId, reason),
        markTaskSyncTarget: (runId, taskId, state) => {
          this.#markTaskSyncTarget(runId, taskId, state);
        },
        insertTaskSyncReceipt: (receipt) => {
          this.#insertTaskSyncReceipt(receipt);
        },
        upsertTaskSyncCheckpoint: (checkpoint) => {
          this.#upsertTaskSyncCheckpoint(checkpoint);
        },
        persistTaskStatusForSync: (itemId, status) =>
          this.#upsertTaskStatus(itemId, status, undefined, false),
      }),
    );
  }

  #readUnitOfWork(): DynaReadUnitOfWork {
    return {
      listDashboards: () => this.listDashboards(),
      getDashboard: (id) => this.getDashboard(id),
      listPublishers: (dashboardId) => this.listPublishers(dashboardId),
      listProjectionItems: (dashboardId, scope) => this.#listProjectionItems(dashboardId, scope),
      matchingProjectionItemIds: (dashboardId, scope, terms) =>
        this.#matchingProjectionItemIds(dashboardId, scope, terms),
      loadCardEvidence: (itemIds, searchTerms) => this.#loadCardEvidence(itemIds, searchTerms),
      findDashboardState: (dashboardId) => this.#findDashboardState(dashboardId),
      findItemBase: (itemId) => this.#findCliItemBase(itemId),
      findTaskOwner: (taskId) => this.#findTaskOwner(taskId),
      findLinkedTaskTitle: (itemId, taskId, hostId) =>
        this.#findLinkedTaskTitle(itemId, taskId, hostId),
      findWorkAttemptAttribution: (itemId, workAttemptId) =>
        this.#findWorkAttemptAttribution(itemId, workAttemptId),
      currentEnrichmentVersion: (itemId) => this.#currentEnrichmentVersion(itemId),
      countTaskBindingsForItem: (itemId) => this.#countTaskBindingsForItem(itemId),
      findTaskAssociationReservation: (requestId) =>
        this.#findTaskAssociationReservation(requestId),
      findActiveTaskAssociationReservation: (taskId) =>
        this.#findActiveTaskAssociationReservation(taskId),
      countActiveTaskAssociationReservationsForItem: (itemId, excludedRequestId) =>
        this.#countActiveTaskAssociationReservationsForItem(itemId, excludedRequestId),
      dashboardContainsItem: (dashboardId, itemId) =>
        this.#dashboardContainsItem(dashboardId, itemId),
      findOpenArchive: (dashboardId, itemId) => this.#findOpenArchive(dashboardId, itemId),
      findArchiveReceipt: (dashboardId, requestId) =>
        this.#findArchiveReceipt(dashboardId, requestId),
      findRestoreReceipt: (dashboardId, requestId) =>
        this.#findRestoreReceipt(dashboardId, requestId),
      authorizeViewToken: (viewToken, itemId) => this.authorizeView(viewToken, itemId),
      loadItemContext: (itemId) => this.itemContext(itemId),
      loadItemHistory: (dashboardId, itemId, options) =>
        this.itemHistory(dashboardId, itemId, options),
      loadItemActivityPage: (dashboardId, itemId, options) =>
        this.itemActivityPage(dashboardId, itemId, options),
      findWorkUpdate: (id) => this.#findWorkUpdate(id),
      loadActionForView: (viewToken, requestId) => this.actionStatusForView(viewToken, requestId),
      loadAction: (requestId) => this.actionStatus(requestId),
      findAnnotation: (id) => this.#findAnnotation(id),
      findAnnotationEvent: (id) => this.#findAnnotationEvent(id),
      listTaskSyncRuns: (dashboardId, limit) => this.#listTaskSyncRuns(dashboardId, limit),
      findTaskSyncRun: (runId) => this.#findTaskSyncRun(runId),
      listTaskSyncCandidates: (dashboardId, scope, limit) =>
        this.#listTaskSyncCandidates(dashboardId, scope, limit),
      listTaskSyncTargets: (runId) => this.#listTaskSyncTargets(runId),
      findTaskSyncCheckpoint: (taskId) => this.#findTaskSyncCheckpoint(taskId),
      findTaskSyncReceipt: (id) => this.#findTaskSyncReceipt(id),
    };
  }

  #findCliReceipt(requestId: string): DynaCliReceiptRecord | undefined {
    const row = this.#one(
      this.#database.prepare(
        `SELECT dashboard_id, operation, item_id, request_hash, result_json,
           task_id, host_id, work_attempt_id, result_target_id
         FROM cli_requests WHERE request_id = ?`,
      ),
      requestId,
    );
    if (!row) return undefined;
    const taskId = optionalString(row, "task_id");
    const hostId = optionalString(row, "host_id");
    const workAttemptId = optionalString(row, "work_attempt_id");
    const resultTargetId = optionalString(row, "result_target_id");
    return {
      dashboardId: requiredString(row, "dashboard_id"),
      operation: requiredString(row, "operation"),
      itemId: requiredString(row, "item_id"),
      requestHash: requiredString(row, "request_hash"),
      ...(taskId ? { taskId } : {}),
      ...(hostId ? { hostId } : {}),
      ...(workAttemptId ? { workAttemptId } : {}),
      ...(resultTargetId ? { resultTargetId } : {}),
      result: parseJson(requiredString(row, "result_json")),
    };
  }

  #insertCliReceipt(
    requestId: string,
    record: Omit<DynaCliReceiptRecord, "result"> & { readonly result: unknown },
    createdAt: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO cli_requests (
           dashboard_id, request_id, operation, item_id, request_hash, result_json, created_at,
           task_id, host_id, work_attempt_id, result_target_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.dashboardId,
        requestId,
        record.operation,
        record.itemId,
        record.requestHash,
        JSON.stringify(record.result),
        createdAt,
        record.taskId ?? null,
        record.hostId ?? null,
        record.workAttemptId ?? null,
        record.resultTargetId ?? null,
      );
  }

  #findTodoReceipt(dashboardId: string, requestId: string): DynaTodoReceiptRecord | undefined {
    const row = this.#one(
      this.#database.prepare(
        "SELECT request_hash, item_id FROM todo_requests WHERE dashboard_id = ? AND client_request_id = ?",
      ),
      dashboardId,
      requestId,
    );
    return row
      ? {
          requestHash: requiredString(row, "request_hash"),
          itemId: requiredString(row, "item_id"),
        }
      : undefined;
  }

  #insertTodoReceipt(
    dashboardId: string,
    requestId: string,
    requestHash: string,
    itemId: string,
  ): void {
    this.#database
      .prepare(
        "INSERT INTO todo_requests (dashboard_id, client_request_id, request_hash, item_id) VALUES (?, ?, ?, ?)",
      )
      .run(dashboardId, requestId, requestHash, itemId);
  }

  #findDashboardState(dashboardId: string): DynaCliDashboardState | undefined {
    const row = this.#one(
      this.#database.prepare("SELECT archived, revision FROM dashboards WHERE id = ?"),
      dashboardId,
    );
    return row
      ? {
          archived: requiredNumber(row, "archived") === 1,
          revision: requiredNumber(row, "revision"),
        }
      : undefined;
  }

  #findCliItemBase(itemId: string): DynaCliItemBase | undefined {
    const row = this.#one(
      this.#database.prepare(
        `SELECT item.id, item_number.number AS item_number, item.fingerprint,
           item.priority, item.source_updated_at
         FROM items item
         JOIN item_numbers item_number ON item_number.item_id = item.id
         WHERE item.id = ?`,
      ),
      itemId,
    );
    return row
      ? {
          id: requiredString(row, "id"),
          itemNumber: requiredItemNumber(row, "item_number"),
          fingerprint: requiredString(row, "fingerprint"),
          sourcePriority: DynaPrioritySchema.parse(requiredString(row, "priority")),
          sourceUpdatedAt: requiredString(row, "source_updated_at"),
        }
      : undefined;
  }

  #findTaskOwner(taskId: string): { readonly itemId: string; readonly hostId: string } | undefined {
    const row = this.#one(
      this.#database.prepare("SELECT item_id, host_id FROM task_bindings WHERE task_id = ?"),
      taskId,
    );
    return row
      ? { itemId: requiredString(row, "item_id"), hostId: requiredString(row, "host_id") }
      : undefined;
  }

  #countTaskBindingsForItem(itemId: string): number {
    const row = this.#one(
      this.#database.prepare("SELECT COUNT(*) AS total FROM task_bindings WHERE item_id = ?"),
      itemId,
    );
    if (!row) throw new Error("Dyna could not count linked Codex tasks.");
    return requiredNumber(row, "total");
  }

  #taskAssociationReservationFromRow(row: SqlRow): DynaTaskAssociationReservation {
    const state = requiredString(row, "state");
    if (
      state !== "reserved" &&
      state !== "uncertain" &&
      state !== "consumed" &&
      state !== "released" &&
      state !== "expired"
    ) {
      throw new Error("Dyna task-association reservation state is invalid.");
    }
    const actionRequestId = optionalString(row, "action_request_id");
    const expiresAt = optionalString(row, "expires_at");
    return {
      requestId: requiredString(row, "request_id"),
      taskId: requiredString(row, "task_id"),
      itemId: requiredString(row, "item_id"),
      ...(actionRequestId ? { actionRequestId } : {}),
      state,
      ...(expiresAt ? { expiresAt } : {}),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at"),
    };
  }

  #findTaskAssociationReservation(requestId: string): DynaTaskAssociationReservation | undefined {
    const row = this.#one(
      this.#database.prepare(
        `SELECT request_id, task_id, item_id, action_request_id, state,
           expires_at, created_at, updated_at
         FROM task_association_reservations WHERE request_id = ?`,
      ),
      requestId,
    );
    return row ? this.#taskAssociationReservationFromRow(row) : undefined;
  }

  #findActiveTaskAssociationReservation(
    taskId: string,
  ): DynaTaskAssociationReservation | undefined {
    const row = this.#one(
      this.#database.prepare(
        `SELECT request_id, task_id, item_id, action_request_id, state,
           expires_at, created_at, updated_at
         FROM task_association_reservations
         WHERE task_id = ? AND state IN ('reserved', 'uncertain')`,
      ),
      taskId,
    );
    return row ? this.#taskAssociationReservationFromRow(row) : undefined;
  }

  #countActiveTaskAssociationReservationsForItem(
    itemId: string,
    excludedRequestId?: string,
  ): number {
    const row = this.#one(
      this.#database.prepare(
        `SELECT COUNT(*) AS total FROM task_association_reservations
         WHERE item_id = ? AND state IN ('reserved', 'uncertain')
           AND (? IS NULL OR request_id <> ?)`,
      ),
      itemId,
      excludedRequestId ?? null,
      excludedRequestId ?? null,
    );
    if (!row) throw new Error("Dyna could not count task-association reservations.");
    return requiredNumber(row, "total");
  }

  #insertTaskAssociationReservation(reservation: DynaTaskAssociationReservation): void {
    this.#database
      .prepare(
        `INSERT INTO task_association_reservations (
           request_id, task_id, item_id, action_request_id, state,
           expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        reservation.requestId,
        reservation.taskId,
        reservation.itemId,
        reservation.actionRequestId ?? null,
        reservation.state,
        reservation.expiresAt ?? null,
        reservation.createdAt,
        reservation.updatedAt,
      );
  }

  #expireTaskAssociationReservations(expiredAt: string): number {
    return Number(
      this.#database
        .prepare(
          `UPDATE task_association_reservations
         SET state = 'expired', updated_at = ?
         WHERE state = 'reserved' AND expires_at IS NOT NULL AND expires_at <= ?`,
        )
        .run(expiredAt, expiredAt).changes,
    );
  }

  #transitionTaskAssociationReservation(
    requestId: string,
    state: DynaTaskAssociationReservationState,
    updatedAt: string,
  ): void {
    const changed = this.#database
      .prepare(
        "UPDATE task_association_reservations SET state = ?, updated_at = ? WHERE request_id = ?",
      )
      .run(state, updatedAt, requestId).changes;
    if (changed !== 1) throw new Error("Dyna task-association reservation was not found.");
  }

  #findOpenArchive(dashboardId: string, itemId: string): { readonly id: string } | undefined {
    const row = this.#one(
      this.#database.prepare(
        "SELECT id FROM item_archive_events WHERE dashboard_id = ? AND item_id = ? AND restored_at IS NULL",
      ),
      dashboardId,
      itemId,
    );
    return row ? { id: requiredString(row, "id") } : undefined;
  }

  #findArchiveReceipt(
    dashboardId: string,
    requestId: string,
  ): { readonly requestHash: string; readonly result: DynaArchiveResult } | undefined {
    const row = this.#one(
      this.#database.prepare(
        "SELECT * FROM item_archive_events WHERE dashboard_id = ? AND client_request_id = ?",
      ),
      dashboardId,
      requestId,
    );
    if (!row) return undefined;
    return {
      requestHash: requiredString(row, "request_hash"),
      result: this.#archiveResultFromRow(row),
    };
  }

  #findRestoreReceipt(
    dashboardId: string,
    requestId: string,
  ):
    | {
        readonly requestHash: string;
        readonly itemId: string;
        readonly restoredAt: string;
      }
    | undefined {
    const row = this.#one(
      this.#database.prepare(
        "SELECT item_id, restored_at, restore_request_hash FROM item_archive_events WHERE dashboard_id = ? AND restore_request_id = ?",
      ),
      dashboardId,
      requestId,
    );
    if (!row) return undefined;
    return {
      requestHash: requiredString(row, "restore_request_hash"),
      itemId: requiredString(row, "item_id"),
      restoredAt: requiredString(row, "restored_at"),
    };
  }

  #findLinkedTaskTitle(itemId: string, taskId: string, hostId: string): string | undefined {
    const row = this.#one(
      this.#database.prepare(
        "SELECT title FROM task_bindings WHERE item_id = ? AND task_id = ? AND host_id = ?",
      ),
      itemId,
      taskId,
      hostId,
    );
    return row ? requiredString(row, "title") : undefined;
  }

  #findWorkAttemptAttribution(
    itemId: string,
    workAttemptId: string,
  ): DynaCliWorkAttemptAttribution | undefined {
    const row = this.#one(
      this.#database.prepare(
        `SELECT task_id, host_id FROM (
           SELECT task_id, host_id, created_at AS occurred_at, rowid AS insertion_sequence
           FROM work_updates
           WHERE item_id = ? AND work_attempt_id = ? AND task_id IS NOT NULL
           UNION ALL
           SELECT task_id, host_id, created_at AS occurred_at, rowid AS insertion_sequence
           FROM cli_requests
           WHERE item_id = ? AND work_attempt_id = ? AND task_id IS NOT NULL
         ) ORDER BY occurred_at, insertion_sequence LIMIT 1`,
      ),
      itemId,
      workAttemptId,
      itemId,
      workAttemptId,
    );
    if (!row) return undefined;
    const taskId = optionalString(row, "task_id");
    const hostId = optionalString(row, "host_id");
    return {
      ...(taskId ? { taskId } : {}),
      ...(hostId ? { hostId } : {}),
    };
  }

  #currentEnrichmentVersion(itemId: string): number {
    const row = this.#one(
      this.#database.prepare("SELECT version FROM item_enrichments WHERE item_id = ?"),
      itemId,
    );
    return row ? requiredNumber(row, "version") : 0;
  }

  #completionEvidence(itemId: string): DynaCliCompletionEvidence {
    const completed = this.#one(
      this.#database.prepare(
        "SELECT MAX(status_updated_ms) AS completed_at_ms FROM task_bindings WHERE item_id = ? AND state = 'succeeded'",
      ),
      itemId,
    );
    const outcome = this.#one(
      this.#database.prepare(
        `SELECT outcome FROM task_bindings
         WHERE item_id = ? AND state = 'succeeded' AND outcome IS NOT NULL
         ORDER BY status_updated_ms DESC, task_id, host_id LIMIT 1`,
      ),
      itemId,
    );
    const outcomeValue = outcome ? optionalString(outcome, "outcome") : undefined;
    return {
      ...(typeof completed?.["completed_at_ms"] === "number"
        ? { completedAtMs: requiredNumber(completed, "completed_at_ms") }
        : {}),
      ...(outcomeValue ? { outcome: outcomeValue } : {}),
    };
  }

  #findManualPublisher(dashboardId: string): string | undefined {
    const row = this.#one(
      this.#database.prepare(
        "SELECT publisher_id FROM dashboard_manual_publishers WHERE dashboard_id = ?",
      ),
      dashboardId,
    );
    return row ? requiredString(row, "publisher_id") : undefined;
  }

  #countPublishers(): number {
    const row = this.#one(this.#database.prepare("SELECT COUNT(*) AS total FROM publishers"));
    return row ? requiredNumber(row, "total") : 0;
  }

  #listDashboardIdsForItem(itemId: string): readonly string[] {
    return (
      this.#database
        .prepare(
          `SELECT DISTINCT dp.dashboard_id FROM dashboard_publishers dp
           JOIN publisher_items pi ON pi.publisher_id = dp.publisher_id
           WHERE pi.item_id = ? AND (
             pi.active = 1 OR EXISTS (
               SELECT 1 FROM item_archive_events history
               WHERE history.dashboard_id = dp.dashboard_id AND history.item_id = pi.item_id
             )
           )`,
        )
        .all(itemId) as SqlRow[]
    ).map((row) => requiredString(row, "dashboard_id"));
  }

  #insertCliWorkUpdate(update: DynaWorkUpdate): void {
    this.#database
      .prepare(
        `INSERT INTO work_updates (
           id, item_id, origin_dashboard_id, work_attempt_id, kind, body, outcome,
           artifacts, task_id, host_id, task_title, supersedes_work_update_id,
           created_at, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        update.id,
        update.itemId,
        update.originDashboardId,
        update.workAttemptId,
        update.kind,
        update.body,
        update.outcome ?? null,
        JSON.stringify(update.artifacts),
        update.task?.taskId ?? null,
        update.task?.hostId ?? null,
        update.task?.title ?? null,
        update.supersedesWorkUpdateId ?? null,
        update.createdAt,
        Date.parse(update.createdAt),
      );
  }

  #annotationFromRow(row: SqlRow): DynaRepositoryAnnotationRecord {
    const deletedAt = optionalString(row, "deleted_at");
    const taskId = optionalString(row, "task_id");
    const hostId = optionalString(row, "host_id");
    const taskTitle = optionalString(row, "task_title");
    const workAttemptId = optionalString(row, "work_attempt_id");
    const annotation = {
      id: requiredString(row, "id"),
      itemId: requiredString(row, "item_id"),
      body: requiredString(row, "body"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at"),
      version: requiredNumber(row, "version"),
      ...(taskId && hostId
        ? { task: { taskId, hostId, ...(taskTitle ? { title: taskTitle } : {}) } }
        : {}),
      ...(workAttemptId ? { workAttemptId } : {}),
    };
    if (!deletedAt) return DynaAnnotationSchema.parse(annotation);
    return { ...annotation, deletedAt };
  }

  #findAnnotation(id: string): DynaRepositoryAnnotationRecord | undefined {
    const row = this.#one(this.#database.prepare("SELECT * FROM annotations WHERE id = ?"), id);
    return row ? this.#annotationFromRow(row) : undefined;
  }

  #findAnnotationEvent(id: string): DynaRepositoryAnnotationEvent | undefined {
    const row = this.#one(
      this.#database.prepare("SELECT * FROM annotation_events WHERE id = ?"),
      id,
    );
    if (!row) return undefined;
    const taskId = optionalString(row, "task_id");
    const hostId = optionalString(row, "host_id");
    const taskTitle = optionalString(row, "task_title");
    const workAttemptId = optionalString(row, "work_attempt_id");
    return {
      id: requiredString(row, "id"),
      annotationId: requiredString(row, "annotation_id"),
      itemId: requiredString(row, "item_id"),
      operation: requiredString(row, "operation") as "create" | "edit" | "delete",
      requestHash: requiredString(row, "request_hash"),
      resultVersion: requiredNumber(row, "result_version"),
      occurredAt: requiredString(row, "occurred_at"),
      ...(taskId ? { taskId } : {}),
      ...(hostId ? { hostId } : {}),
      ...(taskTitle ? { taskTitle } : {}),
      ...(workAttemptId ? { workAttemptId } : {}),
    };
  }

  #insertAnnotation(annotation: DynaAnnotation): void {
    this.#database
      .prepare(
        `INSERT INTO annotations (
           id, item_id, body, created_at, updated_at, version, deleted_at,
           task_id, host_id, task_title, work_attempt_id
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(
        annotation.id,
        annotation.itemId,
        annotation.body,
        annotation.createdAt,
        annotation.updatedAt,
        annotation.version,
        annotation.task?.taskId ?? null,
        annotation.task?.hostId ?? null,
        annotation.task?.title ?? null,
        annotation.workAttemptId ?? null,
      );
  }

  #updateAnnotation(
    annotationId: string,
    expectedVersion: number,
    body: string,
    updatedAt: string,
    attribution?: DynaTaskMutationAttribution & { readonly taskTitle?: string | undefined },
  ): boolean {
    return (
      this.#database
        .prepare(
          `UPDATE annotations SET body = ?, updated_at = ?, version = version + 1,
             task_id = ?, host_id = ?, task_title = ?, work_attempt_id = ?
           WHERE id = ? AND version = ? AND deleted_at IS NULL`,
        )
        .run(
          body,
          updatedAt,
          attribution?.taskId ?? null,
          attribution?.hostId ?? null,
          attribution?.taskTitle ?? null,
          attribution?.workAttemptId ?? null,
          annotationId,
          expectedVersion,
        ).changes === 1
    );
  }

  #deleteAnnotation(
    annotationId: string,
    expectedVersion: number,
    deletedAt: string,
    attribution?: DynaTaskMutationAttribution & { readonly taskTitle?: string | undefined },
  ): boolean {
    return (
      this.#database
        .prepare(
          `UPDATE annotations
           SET body = '', updated_at = ?, deleted_at = ?, version = version + 1,
             task_id = ?, host_id = ?, task_title = ?, work_attempt_id = ?
           WHERE id = ? AND version = ? AND deleted_at IS NULL`,
        )
        .run(
          deletedAt,
          deletedAt,
          attribution?.taskId ?? null,
          attribution?.hostId ?? null,
          attribution?.taskTitle ?? null,
          attribution?.workAttemptId ?? null,
          annotationId,
          expectedVersion,
        ).changes === 1
    );
  }

  #insertAnnotationEvent(event: DynaRepositoryAnnotationEvent): void {
    this.#database
      .prepare(
        `INSERT INTO annotation_events (
           id, annotation_id, item_id, operation, request_hash,
           result_version, occurred_at, occurred_at_ms,
           task_id, host_id, task_title, work_attempt_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.annotationId,
        event.itemId,
        event.operation,
        event.requestHash,
        event.resultVersion,
        event.occurredAt,
        Date.parse(event.occurredAt),
        event.taskId ?? null,
        event.hostId ?? null,
        event.taskTitle ?? null,
        event.workAttemptId ?? null,
      );
  }

  #insertUserWorkflowEvent(event: DynaUserWorkflowEvent): void {
    this.#database
      .prepare(
        `INSERT INTO item_workflow_events (
           id, item_id, origin_dashboard_id, target_stage, outcome,
           created_at, created_at_ms, task_id, host_id, task_title, work_attempt_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.itemId,
        event.originDashboardId,
        event.targetStage,
        event.outcome ?? null,
        event.createdAt,
        Date.parse(event.createdAt),
        event.task?.taskId ?? null,
        event.task?.hostId ?? null,
        event.task?.title ?? null,
        event.workAttemptId ?? null,
      );
  }

  #replaceCliEnrichment(record: DynaCliEnrichmentRecord): number {
    this.#database
      .prepare(
        `INSERT INTO item_enrichments (
           item_id, summary, priority, priority_reason, due_at, due_at_set, labels, people,
           leadership_score, attention, plan, next_steps, base_fingerprint,
           base_source_updated_at, applied_at, provenance, version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(item_id) DO UPDATE SET summary = excluded.summary,
           priority = excluded.priority, priority_reason = excluded.priority_reason,
           due_at = excluded.due_at, due_at_set = excluded.due_at_set,
           labels = excluded.labels, people = excluded.people,
           leadership_score = excluded.leadership_score,
           attention = excluded.attention, plan = excluded.plan,
           next_steps = excluded.next_steps,
           base_fingerprint = excluded.base_fingerprint,
           base_source_updated_at = excluded.base_source_updated_at,
           applied_at = excluded.applied_at, provenance = excluded.provenance,
           version = item_enrichments.version + 1`,
      )
      .run(
        record.itemId,
        record.summary ?? null,
        record.priority ?? null,
        record.priorityReason ?? null,
        record.dueAt ?? null,
        record.dueAtSet ? 1 : 0,
        record.labels === undefined ? null : JSON.stringify(record.labels),
        record.people === undefined ? null : JSON.stringify(record.people),
        record.leadershipScore,
        record.attention ?? null,
        record.plan === undefined ? null : JSON.stringify(record.plan),
        record.nextSteps === undefined ? null : JSON.stringify(record.nextSteps),
        record.baseFingerprint,
        record.baseSourceUpdatedAt,
        record.appliedAt,
        record.provenance,
      );
    return this.#currentEnrichmentVersion(record.itemId);
  }

  #writeCliPlacements(
    dashboardId: string,
    writes: readonly DynaCliPlacementWrite[],
    instant: string,
  ): void {
    const setOverride = this.#database.prepare(
      `INSERT INTO item_preferences (
         dashboard_id, item_id, priority_override, sequence, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(dashboard_id, item_id) DO UPDATE SET
         priority_override = excluded.priority_override,
         sequence = excluded.sequence, updated_at = excluded.updated_at`,
    );
    const setSequence = this.#database.prepare(
      `INSERT INTO item_preferences (dashboard_id, item_id, sequence, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(dashboard_id, item_id) DO UPDATE SET
         sequence = excluded.sequence, updated_at = excluded.updated_at`,
    );
    const addEvent = this.#database.prepare(
      `INSERT INTO item_preference_events (
         id, dashboard_id, item_id, action, priority, sequence, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const write of writes) {
      if (write.priorityOverride) {
        setOverride.run(dashboardId, write.itemId, write.priorityOverride, write.sequence, instant);
      } else {
        setSequence.run(dashboardId, write.itemId, write.sequence, instant);
      }
      addEvent.run(
        randomUUID(),
        dashboardId,
        write.itemId,
        write.action,
        write.priority,
        write.sequence,
        instant,
      );
    }
  }

  #insertCliArchive(record: DynaCliArchiveInsert): void {
    this.#database
      .prepare(
        `INSERT INTO item_archive_events (
           id, dashboard_id, item_id, reason, reason_detail, mode,
           archived_at, archived_at_ms, fingerprint_at_archive, workflow_state,
           completed_at, completed_at_ms, outcome_at_archive,
           priority_at_archive, sequence_at_archive, client_request_id, request_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.dashboardId,
        record.itemId,
        record.reason,
        record.reasonDetail ?? null,
        record.mode,
        record.archivedAt,
        Date.parse(record.archivedAt),
        record.fingerprint,
        record.workflowState,
        record.completedAtMs === undefined ? null : new Date(record.completedAtMs).toISOString(),
        record.completedAtMs ?? null,
        record.outcome ?? null,
        record.priority,
        record.sequence ?? null,
        record.requestId ?? null,
        record.requestHash ?? null,
      );
  }

  #restoreCliArchive(
    archiveId: string,
    restoredAt: string,
    request?: { readonly id: string; readonly hash: string },
  ): boolean {
    return (
      this.#database
        .prepare(
          `UPDATE item_archive_events
           SET restored_at = ?, restored_at_ms = ?, restore_request_id = ?, restore_request_hash = ?
           WHERE id = ? AND restored_at IS NULL`,
        )
        .run(
          restoredAt,
          Date.parse(restoredAt),
          request?.id ?? null,
          request?.hash ?? null,
          archiveId,
        ).changes === 1
    );
  }

  #insertCliManualPublisher(dashboardId: string, publisherId: string, instant: string): void {
    this.#database
      .prepare(
        `INSERT INTO publishers (
           id, name, token_hash, schedule_state, stale_after_minutes, credential_mode,
           last_run_status, created_at
         ) VALUES (?, ?, ?, 'unknown', 43200, 'disabled', 'never', ?)`,
      )
      .run(publisherId, "Dyna to-dos", tokenHash(token()), instant);
    this.#database
      .prepare("INSERT INTO dashboard_publishers (dashboard_id, publisher_id) VALUES (?, ?)")
      .run(dashboardId, publisherId);
    this.#database
      .prepare("INSERT INTO dashboard_manual_publishers (dashboard_id, publisher_id) VALUES (?, ?)")
      .run(dashboardId, publisherId);
  }

  #insertCliManualItem(record: DynaCliManualItemInsert): void {
    const { itemId, publisherId, published, fingerprint, instant, followUpOfItemId } = record;
    this.#database
      .prepare(
        `INSERT INTO items (
           id, publisher_id, external_id, identity_key, source, source_ref, source_scope, title,
           summary, priority, priority_reason, source_updated_at, source_updated_ms, due_at,
           labels, people, leadership_score, attention, plan, next_steps, follow_up_of_item_id,
           fingerprint, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        itemId,
        publisherId,
        published.externalId,
        identityKey(publisherId, published.sourceRef),
        published.sourceRef.source,
        JSON.stringify(published.sourceRef),
        published.sourceScope,
        published.title,
        published.summary,
        published.priority,
        published.priorityReason,
        published.sourceUpdatedAt,
        Date.parse(published.sourceUpdatedAt),
        JSON.stringify(published.labels),
        JSON.stringify(published.people),
        published.attention ?? null,
        JSON.stringify(published.plan),
        JSON.stringify(published.nextSteps),
        followUpOfItemId ?? null,
        fingerprint,
        instant,
      );
    if (followUpOfItemId) this.#insertFollowUpReference(itemId, followUpOfItemId);
    this.#database
      .prepare(
        `INSERT INTO publisher_items (
           publisher_id, external_id, item_id, active, last_seen_run_id
         ) VALUES (?, ?, ?, 1, ?)`,
      )
      .run(publisherId, published.externalId, itemId, `manual:${published.externalId}`);
  }

  #insertFollowUpReference(itemId: string, sourceItemId: string): void {
    const inserted = this.#database
      .prepare(
        `INSERT INTO item_follow_ups (item_id, source_item_id, source_item_number)
         SELECT ?, item_number.item_id, item_number.number
         FROM item_numbers item_number WHERE item_number.item_id = ?`,
      )
      .run(itemId, sourceItemId).changes;
    if (inserted !== 1) throw new Error("The Dyna follow-up source has no item number.");
  }

  close(): void {
    this.#database.close();
  }

  backup(destinationPath: string): string {
    this.#assertItemNumberIntegrity();
    const requestedPath = resolve(destinationPath);
    const requestedDirectory = dirname(requestedPath);
    mkdirSync(requestedDirectory, { mode: 0o700, recursive: true });
    const directoryStatus = lstatSync(requestedDirectory);
    if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
      throw new Error("The Dyna backup directory must be a private regular directory.");
    }
    if ((directoryStatus.mode & 0o777) !== 0o700) {
      throw new Error("The Dyna backup directory must have 0700 permissions.");
    }

    const canonicalDirectory = realpathSync(requestedDirectory);
    const backupPath = join(canonicalDirectory, basename(requestedPath));
    if (lstatIfPresent(backupPath)) {
      throw new Error("The Dyna backup destination already exists.");
    }

    const stagingPath = join(canonicalDirectory, `.${basename(requestedPath)}.${randomUUID()}.tmp`);
    try {
      this.#database.prepare("VACUUM INTO ?").run(stagingPath);
      const stagingStatus = lstatSync(stagingPath);
      if (!stagingStatus.isFile() || stagingStatus.isSymbolicLink()) {
        throw new Error("Dyna could not create a safe backup file.");
      }
      chmodSync(stagingPath, 0o600);

      const verifier = new DatabaseSync(stagingPath, {
        allowExtension: false,
        enableForeignKeyConstraints: true,
        readOnly: true,
        timeout: 5_000,
      });
      try {
        const versionRow = this.#one(verifier.prepare("PRAGMA user_version"));
        const integrityRow = this.#one(verifier.prepare("PRAGMA integrity_check"));
        const foreignKeyViolations = verifier.prepare("PRAGMA foreign_key_check").all();
        if (
          !versionRow ||
          requiredNumber(versionRow, "user_version") !== DYNA_SCHEMA_VERSION ||
          !integrityRow ||
          requiredString(integrityRow, "integrity_check") !== "ok" ||
          foreignKeyViolations.length > 0
        ) {
          throw new Error("Dyna could not verify the backup database.");
        }
        this.#assertItemNumberIntegrity(verifier);
      } finally {
        verifier.close();
      }

      // Publishing with a hard link is atomic and cannot overwrite a concurrently
      // created destination. The staging file lives in the same private directory.
      linkSync(stagingPath, backupPath);
      unlinkSync(stagingPath);
      return backupPath;
    } catch (error: unknown) {
      if (lstatIfPresent(stagingPath)) unlinkSync(stagingPath);
      throw error;
    }
  }

  #createSchema(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS dashboards (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
        done_retention_hours INTEGER NOT NULL DEFAULT 24,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS publishers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash BLOB NOT NULL,
        schedule_id TEXT, schedule_title TEXT, schedule_state TEXT NOT NULL DEFAULT 'unknown',
        stale_after_minutes INTEGER NOT NULL DEFAULT 1440,
        credential_mode TEXT NOT NULL DEFAULT 'disabled'
          CHECK (credential_mode IN ('disabled', 'local_preview')),
        local_cli_enabled INTEGER NOT NULL DEFAULT 0 CHECK (local_cli_enabled IN (0, 1)),
        required_source_slices TEXT,
        last_run_status TEXT NOT NULL DEFAULT 'never', last_run_at TEXT, last_run_completed_ms INTEGER,
        last_run_error TEXT, revoked_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dashboard_publishers (
        dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
        publisher_id TEXT NOT NULL REFERENCES publishers(id) ON DELETE CASCADE,
        PRIMARY KEY (dashboard_id, publisher_id)
      );
      CREATE TABLE IF NOT EXISTS dashboard_manual_publishers (
        dashboard_id TEXT PRIMARY KEY REFERENCES dashboards(id) ON DELETE CASCADE,
        publisher_id TEXT NOT NULL UNIQUE REFERENCES publishers(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY, publisher_id TEXT NOT NULL REFERENCES publishers(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL, identity_key TEXT, source TEXT NOT NULL, source_ref TEXT NOT NULL,
        source_scope TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
        priority TEXT NOT NULL, priority_reason TEXT NOT NULL, source_updated_at TEXT NOT NULL,
        source_updated_ms INTEGER, due_at TEXT, labels TEXT NOT NULL, people TEXT NOT NULL DEFAULT '[]',
        leadership_score INTEGER NOT NULL DEFAULT 0,
        attention TEXT, plan TEXT NOT NULL DEFAULT '[]', next_steps TEXT NOT NULL DEFAULT '[]',
        follow_up_of_item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
        fingerprint TEXT NOT NULL,
        updated_at TEXT NOT NULL, UNIQUE (publisher_id, external_id)
      );
      CREATE TABLE IF NOT EXISTS item_numbers (
        number INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT NOT NULL UNIQUE,
        CHECK (number > 0 AND number <= 9007199254740991)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dyna_item_numbers_identity
        ON item_numbers(number, item_id);
      CREATE TRIGGER IF NOT EXISTS trg_dyna_item_number_allocate
        AFTER INSERT ON items
        BEGIN
          INSERT INTO item_numbers (item_id) VALUES (NEW.id);
        END;
      CREATE TRIGGER IF NOT EXISTS trg_dyna_item_number_immutable_update
        BEFORE UPDATE ON item_numbers
        BEGIN
          SELECT RAISE(ABORT, 'Dyna item numbers are immutable');
        END;
      CREATE TRIGGER IF NOT EXISTS trg_dyna_item_number_immutable_delete
        BEFORE DELETE ON item_numbers
        BEGIN
          SELECT RAISE(ABORT, 'Dyna item numbers are never recycled');
        END;
      CREATE TABLE IF NOT EXISTS item_follow_ups (
        item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
        source_item_id TEXT NOT NULL,
        source_item_number INTEGER NOT NULL,
        FOREIGN KEY (source_item_number, source_item_id)
          REFERENCES item_numbers(number, item_id) ON DELETE RESTRICT,
        CHECK (source_item_number > 0 AND source_item_number <= 9007199254740991)
      );
      CREATE TABLE IF NOT EXISTS publisher_items (
        publisher_id TEXT NOT NULL REFERENCES publishers(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        active INTEGER NOT NULL DEFAULT 1, last_seen_run_id TEXT NOT NULL,
        PRIMARY KEY (publisher_id, external_id)
      );
      CREATE TABLE IF NOT EXISTS publisher_runs (
        publisher_id TEXT NOT NULL REFERENCES publishers(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, item_count INTEGER NOT NULL,
        failure_message TEXT, source_completed_at TEXT, source_completed_ms INTEGER,
        source_slices TEXT,
        request_hash TEXT, promoted INTEGER NOT NULL DEFAULT 1, completed_at TEXT NOT NULL,
        PRIMARY KEY (publisher_id, run_id)
      );
      CREATE TABLE IF NOT EXISTS item_enrichments (
        item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
        summary TEXT, priority TEXT, priority_reason TEXT, due_at TEXT, due_at_set INTEGER NOT NULL,
        labels TEXT, people TEXT, leadership_score INTEGER NOT NULL DEFAULT 0,
        attention TEXT, plan TEXT, next_steps TEXT,
        base_fingerprint TEXT NOT NULL, base_source_updated_at TEXT NOT NULL,
        applied_at TEXT NOT NULL, provenance TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS item_preferences (
        dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        priority_override TEXT, sequence INTEGER,
        backlogged_at TEXT, backlog_until TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY (dashboard_id, item_id)
      );
      CREATE TABLE IF NOT EXISTS item_preference_events (
        id TEXT PRIMARY KEY,
        dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK (action IN ('bump', 'lower', 'earlier', 'later', 'resequence')),
        priority TEXT NOT NULL CHECK (priority IN ('critical', 'high', 'normal', 'low')),
        sequence INTEGER, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS item_workflow_events (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        origin_dashboard_id TEXT NOT NULL,
        target_stage TEXT NOT NULL CHECK (target_stage IN ('todo', 'needs_you', 'done')),
        outcome TEXT,
        created_at TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        task_id TEXT,
        host_id TEXT,
        task_title TEXT,
        work_attempt_id TEXT,
        CHECK ((task_id IS NULL) = (host_id IS NULL)),
        CHECK ((task_id IS NULL) = (work_attempt_id IS NULL)),
        CHECK (
          (target_stage = 'done' AND outcome IS NOT NULL AND length(trim(outcome)) > 0) OR
          (target_stage <> 'done' AND outcome IS NULL)
        )
      );
      CREATE TABLE IF NOT EXISTS item_archive_events (
        id TEXT PRIMARY KEY,
        dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        reason TEXT NOT NULL CHECK (reason IN (
          'completed', 'invalid', 'duplicate', 'no_action_needed', 'superseded', 'other'
        )),
        reason_detail TEXT,
        mode TEXT NOT NULL CHECK (mode IN ('manual', 'automatic')),
        archived_at TEXT NOT NULL, archived_at_ms INTEGER NOT NULL,
        fingerprint_at_archive TEXT NOT NULL,
        workflow_state TEXT NOT NULL CHECK (workflow_state IN (
          'todo', 'executing', 'paused', 'attention', 'completed'
        )),
        completed_at TEXT, completed_at_ms INTEGER,
        outcome_at_archive TEXT,
        priority_at_archive TEXT NOT NULL CHECK (
          priority_at_archive IN ('critical', 'high', 'normal', 'low')
        ),
        sequence_at_archive INTEGER,
        client_request_id TEXT, request_hash TEXT,
        restored_at TEXT, restored_at_ms INTEGER,
        restore_request_id TEXT, restore_request_hash TEXT
      );
      CREATE TABLE IF NOT EXISTS todo_requests (
        dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
        client_request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        PRIMARY KEY (dashboard_id, client_request_id)
      );
      CREATE TABLE IF NOT EXISTS annotations (
        id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1), deleted_at TEXT,
        task_id TEXT, host_id TEXT, task_title TEXT, work_attempt_id TEXT,
        CHECK ((task_id IS NULL) = (host_id IS NULL)),
        CHECK ((task_id IS NULL) = (work_attempt_id IS NULL))
      );
      CREATE TABLE IF NOT EXISTS annotation_events (
        id TEXT PRIMARY KEY, annotation_id TEXT NOT NULL, item_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('create', 'edit', 'delete')),
        request_hash TEXT NOT NULL,
        result_version INTEGER NOT NULL CHECK (result_version >= 1),
        occurred_at TEXT NOT NULL, occurred_at_ms INTEGER NOT NULL,
        task_id TEXT, host_id TEXT, task_title TEXT, work_attempt_id TEXT,
        CHECK ((task_id IS NULL) = (host_id IS NULL)),
        CHECK ((task_id IS NULL) = (work_attempt_id IS NULL))
      );
      CREATE TABLE IF NOT EXISTS work_updates (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        origin_dashboard_id TEXT NOT NULL,
        work_attempt_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'note', 'progress', 'decision', 'needs_input', 'blocked',
          'completion_reported', 'handoff'
        )),
        body TEXT NOT NULL,
        outcome TEXT,
        artifacts TEXT NOT NULL DEFAULT '[]',
        task_id TEXT,
        host_id TEXT,
        task_title TEXT,
        supersedes_work_update_id TEXT REFERENCES work_updates(id),
        created_at TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        CHECK ((task_id IS NULL) = (host_id IS NULL))
      );
      CREATE TABLE IF NOT EXISTS cli_requests (
        request_id TEXT NOT NULL PRIMARY KEY,
        dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
        operation TEXT NOT NULL,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        task_id TEXT,
        host_id TEXT,
        work_attempt_id TEXT,
        result_target_id TEXT,
        CHECK ((task_id IS NULL) = (host_id IS NULL)),
        CHECK ((task_id IS NULL) = (work_attempt_id IS NULL))
      );
      CREATE TABLE IF NOT EXISTS task_bindings (
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL, host_id TEXT NOT NULL, project_id TEXT,
        title TEXT NOT NULL, state TEXT NOT NULL, status_updated_at TEXT NOT NULL,
        status_updated_ms INTEGER NOT NULL, observed_at TEXT NOT NULL, observed_ms INTEGER NOT NULL,
        outcome TEXT,
        PRIMARY KEY (item_id, task_id, host_id)
      );
      CREATE TABLE IF NOT EXISTS task_sync_checkpoints (
        task_id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
        cursor TEXT,
        last_turn_id TEXT,
        status_updated_at TEXT,
        observed_at TEXT,
        observed_at_ms INTEGER,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_sync_runs (
        id TEXT PRIMARY KEY,
        dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('dashboard', 'task')),
        scope_item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
        scope_task_id TEXT,
        scope_host_id TEXT,
        state TEXT NOT NULL CHECK (state IN (
          'prepared', 'delivered', 'claimed', 'syncing',
          'completed', 'partial', 'expired', 'unavailable'
        )),
        claim_token_hash TEXT,
        lease_expires_at TEXT,
        expires_at TEXT NOT NULL,
        total_tasks INTEGER NOT NULL CHECK (total_tasks >= 0 AND total_tasks <= 200),
        excess_tasks INTEGER NOT NULL DEFAULT 0 CHECK (excess_tasks >= 0),
        processed_tasks INTEGER NOT NULL DEFAULT 0 CHECK (processed_tasks >= 0),
        updated_items INTEGER NOT NULL DEFAULT 0 CHECK (updated_items >= 0),
        unavailable_tasks INTEGER NOT NULL DEFAULT 0 CHECK (unavailable_tasks >= 0),
        incomplete_metadata_tasks INTEGER NOT NULL DEFAULT 0
          CHECK (incomplete_metadata_tasks >= 0 AND incomplete_metadata_tasks <= 200),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        CHECK (
          (scope_kind = 'dashboard' AND scope_item_id IS NULL
            AND scope_task_id IS NULL AND scope_host_id IS NULL) OR
          (scope_kind = 'task' AND scope_item_id IS NOT NULL
            AND scope_task_id IS NOT NULL AND scope_host_id IS NOT NULL)
        )
      );
      CREATE TABLE IF NOT EXISTS task_sync_targets (
        run_id TEXT NOT NULL REFERENCES task_sync_runs(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        item_number INTEGER NOT NULL,
        item_title TEXT NOT NULL,
        task_id TEXT NOT NULL,
        host_id TEXT NOT NULL,
        checkpoint_version INTEGER NOT NULL CHECK (checkpoint_version >= 0),
        checkpoint_cursor TEXT,
        checkpoint_last_turn_id TEXT,
        checkpoint_observed_at_ms INTEGER,
        state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN (
          'pending', 'staged', 'unavailable', 'applied', 'skipped'
        )),
        observation_json TEXT,
        unavailable_reason TEXT,
        PRIMARY KEY (run_id, task_id)
      );
      CREATE TABLE IF NOT EXISTS task_sync_receipts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES task_sync_runs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('batch', 'observation', 'completion')),
        task_id TEXT,
        request_hash TEXT NOT NULL,
        result_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS view_sessions (
        token_hash BLOB PRIMARY KEY, dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS action_requests (
        id TEXT PRIMARY KEY, view_token_hash BLOB NOT NULL,
        dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
        item_fingerprint TEXT, dashboard_revision INTEGER, task_id TEXT, host_id TEXT,
        idempotency_key TEXT, state TEXT NOT NULL, claim_token_hash BLOB, claim_expires_at TEXT,
        result_task_id TEXT, failure_message TEXT, uncertain_effect INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_association_reservations (
        request_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        action_request_id TEXT UNIQUE REFERENCES action_requests(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN (
          'reserved', 'uncertain', 'consumed', 'released', 'expired'
        )),
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY, event_kind TEXT NOT NULL, entity_id TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dyna_open_archive
        ON item_archive_events(dashboard_id, item_id) WHERE restored_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dyna_archive_request
        ON item_archive_events(dashboard_id, client_request_id)
        WHERE client_request_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dyna_restore_request
        ON item_archive_events(dashboard_id, restore_request_id)
        WHERE restore_request_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_dyna_archive_dashboard_time
        ON item_archive_events(dashboard_id, restored_at, archived_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_dyna_archive_item_history
        ON item_archive_events(dashboard_id, item_id, archived_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_dyna_preference_history
        ON item_preference_events(dashboard_id, item_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_dyna_workflow_history
        ON item_workflow_events(item_id, created_at_ms DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_dyna_work_updates_item_time
        ON work_updates(item_id, created_at_ms DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_dyna_work_updates_attempt
        ON work_updates(item_id, work_attempt_id, created_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_dyna_work_updates_task_state
        ON work_updates(item_id, task_id, host_id, created_at_ms DESC)
        WHERE task_id IS NOT NULL AND kind IN (
          'progress', 'needs_input', 'blocked', 'completion_reported', 'handoff'
        );
      CREATE INDEX IF NOT EXISTS idx_dyna_work_updates_supersedes
        ON work_updates(supersedes_work_update_id)
        WHERE supersedes_work_update_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_dyna_cli_requests_work_attempt
        ON cli_requests(item_id, work_attempt_id, created_at)
        WHERE work_attempt_id IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS trg_dyna_cli_requests_attribution_insert
        BEFORE INSERT ON cli_requests
        WHEN ((NEW.task_id IS NULL) <> (NEW.host_id IS NULL)) OR
             ((NEW.task_id IS NULL) <> (NEW.work_attempt_id IS NULL))
        BEGIN
          SELECT RAISE(ABORT, 'Dyna CLI receipt attribution is incomplete');
        END;
      CREATE TRIGGER IF NOT EXISTS trg_dyna_cli_requests_immutable_update
        BEFORE UPDATE ON cli_requests
        BEGIN
          SELECT RAISE(ABORT, 'Dyna CLI receipts are immutable');
        END;
      CREATE TRIGGER IF NOT EXISTS trg_dyna_cli_requests_immutable_delete
        BEFORE DELETE ON cli_requests
        BEGIN
          SELECT RAISE(ABORT, 'Dyna CLI receipts are append-only');
        END;
      CREATE INDEX IF NOT EXISTS idx_dyna_annotation_events_item_time
        ON annotation_events(item_id, occurred_at_ms DESC, id DESC);
      CREATE TRIGGER IF NOT EXISTS trg_dyna_annotation_events_immutable_update
        BEFORE UPDATE ON annotation_events
        BEGIN
          SELECT RAISE(ABORT, 'Dyna annotation events are immutable');
        END;
      CREATE TRIGGER IF NOT EXISTS trg_dyna_annotation_events_immutable_delete
        BEFORE DELETE ON annotation_events
        BEGIN
          SELECT RAISE(ABORT, 'Dyna annotation events are append-only');
        END;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dyna_active_task_reservation
        ON task_association_reservations(task_id)
        WHERE state IN ('reserved', 'uncertain');
      CREATE INDEX IF NOT EXISTS idx_dyna_task_reservation_expiry
        ON task_association_reservations(state, expires_at)
        WHERE state = 'reserved' AND expires_at IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dyna_active_task_sync_run
        ON task_sync_runs(dashboard_id)
        WHERE state IN ('prepared', 'delivered', 'claimed', 'syncing');
      CREATE INDEX IF NOT EXISTS idx_dyna_task_sync_runs_dashboard_time
        ON task_sync_runs(dashboard_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_dyna_task_sync_targets_state
        ON task_sync_targets(run_id, state, task_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dyna_task_sync_observation_receipt
        ON task_sync_receipts(task_id, request_hash)
        WHERE kind = 'observation' AND task_id IS NOT NULL;
    `);
    this.#createActionRequestIndexesWhenSupported();
    this.#createAnnotationIndexWhenSupported();
  }

  #createAnnotationIndexWhenSupported(): void {
    const columns = new Set(
      (this.#database.prepare("PRAGMA table_info(annotations)").all() as SqlRow[]).map((row) =>
        requiredString(row, "name"),
      ),
    );
    if (!columns.has("deleted_at")) return;
    this.#database.exec(
      `CREATE INDEX IF NOT EXISTS idx_dyna_annotations_item_created
       ON annotations(item_id, created_at DESC) WHERE deleted_at IS NULL`,
    );
  }

  #createActionRequestIndexesWhenSupported(): void {
    const columns = new Set(
      (this.#database.prepare("PRAGMA table_info(action_requests)").all() as SqlRow[]).map((row) =>
        requiredString(row, "name"),
      ),
    );
    if (
      !["dashboard_id", "idempotency_key", "item_id", "kind", "state", "claim_expires_at"].every(
        (column) => columns.has(column),
      )
    ) {
      return;
    }
    this.#database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dyna_action_idempotency
        ON action_requests(dashboard_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_dyna_actions_item_state
        ON action_requests(item_id, kind, state, claim_expires_at);
    `);
  }

  #rebuildActionRequestsV6(): void {
    const temporaryTable = this.#one(
      this.#database.prepare(
        "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'action_requests_v6_migration'",
      ),
    );
    if (temporaryTable) {
      throw new Error("Dyna found an incomplete action-request schema migration.");
    }
    this.#database.exec(`
      CREATE TABLE action_requests_v6_migration (
        id TEXT PRIMARY KEY, view_token_hash BLOB NOT NULL,
        dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
        item_fingerprint TEXT, dashboard_revision INTEGER, task_id TEXT, host_id TEXT,
        idempotency_key TEXT, state TEXT NOT NULL, claim_token_hash BLOB, claim_expires_at TEXT,
        result_task_id TEXT, failure_message TEXT, uncertain_effect INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO action_requests_v6_migration (
        id, view_token_hash, dashboard_id, kind, item_id, item_fingerprint,
        dashboard_revision, task_id, host_id, idempotency_key, state,
        claim_token_hash, claim_expires_at, result_task_id, failure_message,
        uncertain_effect, expires_at, created_at, updated_at
      )
      SELECT id, view_token_hash, dashboard_id, kind, item_id, item_fingerprint,
        dashboard_revision, task_id, host_id, idempotency_key, state,
        claim_token_hash, claim_expires_at, result_task_id, failure_message,
        uncertain_effect, expires_at, created_at, updated_at
      FROM action_requests;
      DROP TABLE action_requests;
      ALTER TABLE action_requests_v6_migration RENAME TO action_requests;
    `);
  }

  #actionRequestsUseV6Constraints(): boolean {
    const dashboardColumn = (
      this.#database.prepare("PRAGMA table_info(action_requests)").all() as SqlRow[]
    ).find((column) => optionalString(column, "name") === "dashboard_id");
    if (!dashboardColumn || requiredNumber(dashboardColumn, "notnull") !== 1) return false;
    return (
      this.#database.prepare("PRAGMA foreign_key_list(action_requests)").all() as SqlRow[]
    ).some(
      (foreignKey) =>
        optionalString(foreignKey, "from") === "dashboard_id" &&
        optionalString(foreignKey, "table") === "dashboards" &&
        optionalString(foreignKey, "on_delete") === "CASCADE",
    );
  }

  #schemaObjectExists(type: "index" | "table" | "trigger", name: string): boolean {
    return Boolean(
      this.#one(
        this.#database.prepare(
          "SELECT 1 AS present FROM sqlite_schema WHERE type = ? AND name = ?",
        ),
        type,
        name,
      ),
    );
  }

  #schemaObjectSql(type: "index" | "table" | "trigger", name: string): string | undefined {
    const row = this.#one(
      this.#database.prepare("SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?"),
      type,
      name,
    );
    return row ? optionalString(row, "sql") : undefined;
  }

  #normalizedSchemaSql(value: string): string {
    return value.replace(/\s+/gu, "").replace(/;$/u, "").toLowerCase();
  }

  #assertItemNumberTableSchema(): void {
    const sql = this.#schemaObjectSql("table", "item_numbers");
    if (!sql) {
      throw new Error(
        "The Dyna item-number ledger is missing; reopening it could renumber existing items.",
      );
    }
    const columns = this.#database.prepare("PRAGMA table_info(item_numbers)").all() as SqlRow[];
    const number = columns.find((column) => optionalString(column, "name") === "number");
    const itemId = columns.find((column) => optionalString(column, "name") === "item_id");
    const normalized = this.#normalizedSchemaSql(sql);
    if (
      columns.length !== 2 ||
      !number ||
      optionalString(number, "type")?.toUpperCase() !== "INTEGER" ||
      requiredNumber(number, "pk") !== 1 ||
      !itemId ||
      optionalString(itemId, "type")?.toUpperCase() !== "TEXT" ||
      requiredNumber(itemId, "notnull") !== 1 ||
      !normalized.includes("numberintegerprimarykeyautoincrement") ||
      !normalized.includes("item_idtextnotnullunique") ||
      !normalized.includes("check(number>0andnumber<=9007199254740991)")
    ) {
      throw new Error("The Dyna item-number ledger schema is invalid.");
    }
  }

  #itemNumberTriggersCurrent(): boolean {
    const expected = new Map<string, string>([
      [
        "trg_dyna_item_number_allocate",
        "CREATE TRIGGER trg_dyna_item_number_allocate AFTER INSERT ON items BEGIN INSERT INTO item_numbers (item_id) VALUES (NEW.id); END",
      ],
      [
        "trg_dyna_item_number_immutable_update",
        "CREATE TRIGGER trg_dyna_item_number_immutable_update BEFORE UPDATE ON item_numbers BEGIN SELECT RAISE(ABORT, 'Dyna item numbers are immutable'); END",
      ],
      [
        "trg_dyna_item_number_immutable_delete",
        "CREATE TRIGGER trg_dyna_item_number_immutable_delete BEFORE DELETE ON item_numbers BEGIN SELECT RAISE(ABORT, 'Dyna item numbers are never recycled'); END",
      ],
    ]);
    let complete = true;
    for (const [name, definition] of expected) {
      const actual = this.#schemaObjectSql("trigger", name);
      if (!actual) {
        complete = false;
        continue;
      }
      if (this.#normalizedSchemaSql(actual) !== this.#normalizedSchemaSql(definition)) {
        throw new Error(`The Dyna item-number trigger ${name} is invalid.`);
      }
    }
    return complete;
  }

  #namedIndexMatches(
    table: string,
    name: string,
    columns: readonly string[],
    unique: boolean,
  ): boolean {
    const index = (this.#database.prepare(`PRAGMA index_list(${table})`).all() as SqlRow[]).find(
      (candidate) => optionalString(candidate, "name") === name,
    );
    if (!index) return false;
    const actualColumns = (
      this.#database
        .prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
        .all(name) as SqlRow[]
    ).map((column) => requiredString(column, "name"));
    if (
      (requiredNumber(index, "unique") === 1) !== unique ||
      actualColumns.length !== columns.length ||
      actualColumns.some((column, position) => column !== columns[position])
    ) {
      throw new Error(`The Dyna database index ${name} is invalid.`);
    }
    return true;
  }

  #followUpReferenceSchemaCurrent(): boolean {
    const sql = this.#schemaObjectSql("table", "item_follow_ups");
    if (!sql) return false;
    const normalized = this.#normalizedSchemaSql(sql);
    if (
      !normalized.includes("item_idtextprimarykeyreferencesitems(id)ondeletecascade") ||
      !normalized.includes("source_item_idtextnotnull") ||
      !normalized.includes("source_item_numberintegernotnull") ||
      !normalized.includes(
        "foreignkey(source_item_number,source_item_id)referencesitem_numbers(number,item_id)ondeleterestrict",
      )
    ) {
      throw new Error("The Dyna follow-up reference schema is invalid.");
    }
    return true;
  }

  #taskAssociationReservationSchemaCurrent(): boolean {
    const sql = this.#schemaObjectSql("table", "task_association_reservations");
    if (!sql) return false;
    const normalized = this.#normalizedSchemaSql(sql);
    if (
      !normalized.includes("request_idtextprimarykey") ||
      !normalized.includes("task_idtextnotnull") ||
      !normalized.includes("item_idtextnotnullreferencesitems(id)ondeletecascade") ||
      !normalized.includes(
        "action_request_idtextuniquereferencesaction_requests(id)ondeletecascade",
      ) ||
      !normalized.includes(
        "check(statein('reserved','uncertain','consumed','released','expired'))",
      ) ||
      !normalized.includes("expires_attext") ||
      !normalized.includes("created_attextnotnull") ||
      !normalized.includes("updated_attextnotnull")
    ) {
      throw new Error("The Dyna task-association reservation schema is invalid.");
    }
    const expectedIndexes = new Map<string, string>([
      [
        "idx_dyna_active_task_reservation",
        "CREATE UNIQUE INDEX idx_dyna_active_task_reservation ON task_association_reservations(task_id) WHERE state IN ('reserved', 'uncertain')",
      ],
      [
        "idx_dyna_task_reservation_expiry",
        "CREATE INDEX idx_dyna_task_reservation_expiry ON task_association_reservations(state, expires_at) WHERE state = 'reserved' AND expires_at IS NOT NULL",
      ],
    ]);
    let complete = true;
    for (const [name, definition] of expectedIndexes) {
      const actual = this.#schemaObjectSql("index", name);
      if (!actual) {
        complete = false;
        continue;
      }
      if (this.#normalizedSchemaSql(actual) !== this.#normalizedSchemaSql(definition)) {
        throw new Error(`The Dyna task-association reservation index ${name} is invalid.`);
      }
    }
    return complete;
  }

  #assertTaskSyncSchemaCurrent(): void {
    const expectedTables = new Map<string, string>([
      [
        "task_sync_checkpoints",
        `CREATE TABLE task_sync_checkpoints (
          task_id TEXT PRIMARY KEY,
          host_id TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
          cursor TEXT,
          last_turn_id TEXT,
          status_updated_at TEXT,
          observed_at TEXT,
          observed_at_ms INTEGER,
          updated_at TEXT NOT NULL
        )`,
      ],
      [
        "task_sync_runs",
        `CREATE TABLE task_sync_runs (
          id TEXT PRIMARY KEY,
          dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
          scope_kind TEXT NOT NULL CHECK (scope_kind IN ('dashboard', 'task')),
          scope_item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
          scope_task_id TEXT,
          scope_host_id TEXT,
          state TEXT NOT NULL CHECK (state IN (
            'prepared', 'delivered', 'claimed', 'syncing',
            'completed', 'partial', 'expired', 'unavailable'
          )),
          claim_token_hash TEXT,
          lease_expires_at TEXT,
          expires_at TEXT NOT NULL,
          total_tasks INTEGER NOT NULL CHECK (total_tasks >= 0 AND total_tasks <= 200),
          excess_tasks INTEGER NOT NULL DEFAULT 0 CHECK (excess_tasks >= 0),
          processed_tasks INTEGER NOT NULL DEFAULT 0 CHECK (processed_tasks >= 0),
          updated_items INTEGER NOT NULL DEFAULT 0 CHECK (updated_items >= 0),
          unavailable_tasks INTEGER NOT NULL DEFAULT 0 CHECK (unavailable_tasks >= 0),
          incomplete_metadata_tasks INTEGER NOT NULL DEFAULT 0
            CHECK (incomplete_metadata_tasks >= 0 AND incomplete_metadata_tasks <= 200),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          CHECK (
            (scope_kind = 'dashboard' AND scope_item_id IS NULL
              AND scope_task_id IS NULL AND scope_host_id IS NULL) OR
            (scope_kind = 'task' AND scope_item_id IS NOT NULL
              AND scope_task_id IS NOT NULL AND scope_host_id IS NOT NULL)
          )
        )`,
      ],
      [
        "task_sync_targets",
        `CREATE TABLE task_sync_targets (
          run_id TEXT NOT NULL REFERENCES task_sync_runs(id) ON DELETE CASCADE,
          item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          item_number INTEGER NOT NULL,
          item_title TEXT NOT NULL,
          task_id TEXT NOT NULL,
          host_id TEXT NOT NULL,
          checkpoint_version INTEGER NOT NULL CHECK (checkpoint_version >= 0),
          checkpoint_cursor TEXT,
          checkpoint_last_turn_id TEXT,
          checkpoint_observed_at_ms INTEGER,
          state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN (
            'pending', 'staged', 'unavailable', 'applied', 'skipped'
          )),
          observation_json TEXT,
          unavailable_reason TEXT,
          PRIMARY KEY (run_id, task_id)
        )`,
      ],
      [
        "task_sync_receipts",
        `CREATE TABLE task_sync_receipts (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES task_sync_runs(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('batch', 'observation', 'completion')),
          task_id TEXT,
          request_hash TEXT NOT NULL,
          result_json TEXT,
          created_at TEXT NOT NULL
        )`,
      ],
    ]);
    for (const [table, expected] of expectedTables) {
      const actual = this.#schemaObjectSql("table", table);
      if (!actual) {
        throw new Error(
          `The Dyna task-synchronization ledger ${table} is missing and cannot be reconstructed safely.`,
        );
      }
      if (this.#normalizedSchemaSql(actual) !== this.#normalizedSchemaSql(expected)) {
        throw new Error(`The Dyna task-synchronization ledger ${table} is invalid.`);
      }
    }
    const expectedIndexes = new Map<string, string>([
      [
        "idx_dyna_active_task_sync_run",
        "CREATE UNIQUE INDEX idx_dyna_active_task_sync_run ON task_sync_runs(dashboard_id) WHERE state IN ('prepared', 'delivered', 'claimed', 'syncing')",
      ],
      [
        "idx_dyna_task_sync_runs_dashboard_time",
        "CREATE INDEX idx_dyna_task_sync_runs_dashboard_time ON task_sync_runs(dashboard_id, created_at DESC)",
      ],
      [
        "idx_dyna_task_sync_targets_state",
        "CREATE INDEX idx_dyna_task_sync_targets_state ON task_sync_targets(run_id, state, task_id)",
      ],
      [
        "idx_dyna_task_sync_observation_receipt",
        "CREATE UNIQUE INDEX idx_dyna_task_sync_observation_receipt ON task_sync_receipts(task_id, request_hash) WHERE kind = 'observation' AND task_id IS NOT NULL",
      ],
    ]);
    for (const [name, expected] of expectedIndexes) {
      const actual = this.#schemaObjectSql("index", name);
      if (!actual || this.#normalizedSchemaSql(actual) !== this.#normalizedSchemaSql(expected)) {
        throw new Error(`The Dyna task-synchronization ledger index ${name} is invalid.`);
      }
    }
  }

  #assertAnnotationSchemaCurrent(): void {
    const expectedTables = new Map<string, readonly string[]>([
      [
        "annotations",
        [
          "id",
          "item_id",
          "body",
          "created_at",
          "updated_at",
          "version",
          "deleted_at",
          "task_id",
          "host_id",
          "task_title",
          "work_attempt_id",
        ],
      ],
      [
        "annotation_events",
        [
          "id",
          "annotation_id",
          "item_id",
          "operation",
          "request_hash",
          "result_version",
          "occurred_at",
          "occurred_at_ms",
          "task_id",
          "host_id",
          "task_title",
          "work_attempt_id",
        ],
      ],
    ]);
    for (const [name, expected] of expectedTables) {
      const actual = new Set(
        (this.#database.prepare(`PRAGMA table_info(${name})`).all() as SqlRow[]).map((row) =>
          requiredString(row, "name"),
        ),
      );
      if (!expected.every((column) => actual.has(column))) {
        throw new Error(`The Dyna annotation ledger ${name} is invalid.`);
      }
    }
    const expectedObjects = new Map<string, ["index" | "trigger", string]>([
      [
        "idx_dyna_annotations_item_created",
        [
          "index",
          "CREATE INDEX idx_dyna_annotations_item_created ON annotations(item_id, created_at DESC) WHERE deleted_at IS NULL",
        ],
      ],
      [
        "idx_dyna_annotation_events_item_time",
        [
          "index",
          "CREATE INDEX idx_dyna_annotation_events_item_time ON annotation_events(item_id, occurred_at_ms DESC, id DESC)",
        ],
      ],
      [
        "trg_dyna_annotation_events_immutable_update",
        [
          "trigger",
          "CREATE TRIGGER trg_dyna_annotation_events_immutable_update BEFORE UPDATE ON annotation_events BEGIN SELECT RAISE(ABORT, 'Dyna annotation events are immutable'); END",
        ],
      ],
      [
        "trg_dyna_annotation_events_immutable_delete",
        [
          "trigger",
          "CREATE TRIGGER trg_dyna_annotation_events_immutable_delete BEFORE DELETE ON annotation_events BEGIN SELECT RAISE(ABORT, 'Dyna annotation events are append-only'); END",
        ],
      ],
    ]);
    for (const [name, [type, expected]] of expectedObjects) {
      const actual = this.#schemaObjectSql(type, name);
      if (!actual || this.#normalizedSchemaSql(actual) !== this.#normalizedSchemaSql(expected)) {
        throw new Error(`The Dyna annotation ledger object ${name} is invalid.`);
      }
    }
  }

  #migrateAnnotationsV10(): void {
    const columns = new Set(
      (this.#database.prepare("PRAGMA table_info(annotations)").all() as SqlRow[]).map((row) =>
        requiredString(row, "name"),
      ),
    );
    const alreadyCurrent = ["updated_at", "version", "deleted_at"].every((column) =>
      columns.has(column),
    );
    if (!alreadyCurrent) {
      this.#database.exec(`
        DROP INDEX IF EXISTS idx_dyna_annotations_item_created;
        ALTER TABLE annotations RENAME TO annotations_v9_migration;
        CREATE TABLE annotations (
          id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1), deleted_at TEXT
        );
        INSERT INTO annotations (
          id, item_id, body, created_at, updated_at, version, deleted_at
        )
        SELECT id, item_id, body, created_at, created_at, 1, NULL
        FROM annotations_v9_migration;
        DROP TABLE annotations_v9_migration;
      `);
    }
    this.#createSchema();
    const annotations = this.#database
      .prepare("SELECT id, item_id, body, created_at FROM annotations ORDER BY created_at, id")
      .all() as SqlRow[];
    const insert = this.#database.prepare(
      `INSERT OR IGNORE INTO annotation_events (
         id, annotation_id, item_id, operation, request_hash,
         result_version, occurred_at, occurred_at_ms
       ) VALUES (?, ?, ?, 'create', ?, 1, ?, ?)`,
    );
    for (const annotation of annotations) {
      const annotationId = requiredString(annotation, "id");
      const itemId = requiredString(annotation, "item_id");
      const body = requiredString(annotation, "body");
      const occurredAt = requiredString(annotation, "created_at");
      insert.run(
        scopedUuid(["annotation-create-request", annotationId]),
        annotationId,
        itemId,
        sha256(canonicalJson({ operation: "create", annotationId, body })),
        occurredAt,
        Date.parse(occurredAt),
      );
    }
  }

  #migrateFullControlV11(): void {
    const addColumns = (table: string, columns: Readonly<Record<string, string>>): void => {
      const existing = new Set(
        (this.#database.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[]).map((row) =>
          requiredString(row, "name"),
        ),
      );
      for (const [name, declaration] of Object.entries(columns)) {
        if (!existing.has(name)) {
          this.#database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration};`);
        }
      }
    };
    addColumns("cli_requests", {
      task_id: "TEXT",
      host_id: "TEXT",
      work_attempt_id: "TEXT",
      result_target_id: "TEXT",
    });
    addColumns("work_updates", {
      supersedes_work_update_id: "TEXT REFERENCES work_updates(id)",
    });
    addColumns("annotations", {
      task_id: "TEXT",
      host_id: "TEXT",
      task_title: "TEXT",
      work_attempt_id: "TEXT",
    });
    addColumns("annotation_events", {
      task_id: "TEXT",
      host_id: "TEXT",
      task_title: "TEXT",
      work_attempt_id: "TEXT",
    });
    addColumns("item_workflow_events", {
      task_id: "TEXT",
      host_id: "TEXT",
      task_title: "TEXT",
      work_attempt_id: "TEXT",
    });
    this.#database.exec(`
      CREATE INDEX IF NOT EXISTS idx_dyna_cli_requests_work_attempt
        ON cli_requests(item_id, work_attempt_id, created_at)
        WHERE work_attempt_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_dyna_work_updates_supersedes
        ON work_updates(supersedes_work_update_id)
        WHERE supersedes_work_update_id IS NOT NULL;
    `);
  }

  #assertFullControlSchemaCurrent(): void {
    const requiredColumns = new Map<string, readonly string[]>([
      ["cli_requests", ["task_id", "host_id", "work_attempt_id", "result_target_id"]],
      ["work_updates", ["supersedes_work_update_id"]],
      ["annotations", ["task_id", "host_id", "task_title", "work_attempt_id"]],
      ["annotation_events", ["task_id", "host_id", "task_title", "work_attempt_id"]],
      ["item_workflow_events", ["task_id", "host_id", "task_title", "work_attempt_id"]],
    ]);
    for (const [table, columns] of requiredColumns) {
      const actual = new Set(
        (this.#database.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[]).map((row) =>
          requiredString(row, "name"),
        ),
      );
      if (!columns.every((column) => actual.has(column))) {
        throw new Error(`The Dyna full-control ledger ${table} is invalid.`);
      }
    }
    if (
      !this.#schemaObjectExists("index", "idx_dyna_cli_requests_work_attempt") ||
      !this.#schemaObjectExists("index", "idx_dyna_work_updates_supersedes")
    ) {
      throw new Error("The Dyna full-control ledger indexes are incomplete.");
    }
    const expectedTriggers = new Map<string, string>([
      [
        "trg_dyna_cli_requests_attribution_insert",
        `CREATE TRIGGER trg_dyna_cli_requests_attribution_insert
          BEFORE INSERT ON cli_requests
          WHEN ((NEW.task_id IS NULL) <> (NEW.host_id IS NULL)) OR
               ((NEW.task_id IS NULL) <> (NEW.work_attempt_id IS NULL))
          BEGIN
            SELECT RAISE(ABORT, 'Dyna CLI receipt attribution is incomplete');
          END`,
      ],
      [
        "trg_dyna_cli_requests_immutable_update",
        `CREATE TRIGGER trg_dyna_cli_requests_immutable_update
          BEFORE UPDATE ON cli_requests
          BEGIN
            SELECT RAISE(ABORT, 'Dyna CLI receipts are immutable');
          END`,
      ],
      [
        "trg_dyna_cli_requests_immutable_delete",
        `CREATE TRIGGER trg_dyna_cli_requests_immutable_delete
          BEFORE DELETE ON cli_requests
          BEGIN
            SELECT RAISE(ABORT, 'Dyna CLI receipts are append-only');
          END`,
      ],
    ]);
    for (const [name, expected] of expectedTriggers) {
      const actual = this.#schemaObjectSql("trigger", name);
      if (!actual || this.#normalizedSchemaSql(actual) !== this.#normalizedSchemaSql(expected)) {
        throw new Error(`The Dyna full-control ledger trigger ${name} is invalid.`);
      }
    }
  }

  #migrateBacklogV12(): void {
    const columns = new Set(
      (this.#database.prepare("PRAGMA table_info(item_preferences)").all() as SqlRow[]).map((row) =>
        requiredString(row, "name"),
      ),
    );
    if (!columns.has("backlogged_at")) {
      this.#database.exec("ALTER TABLE item_preferences ADD COLUMN backlogged_at TEXT;");
    }
    if (!columns.has("backlog_until")) {
      this.#database.exec("ALTER TABLE item_preferences ADD COLUMN backlog_until TEXT;");
    }
  }

  #assertBacklogSchemaCurrent(): void {
    const columns = new Set(
      (this.#database.prepare("PRAGMA table_info(item_preferences)").all() as SqlRow[]).map((row) =>
        requiredString(row, "name"),
      ),
    );
    if (!columns.has("backlogged_at") || !columns.has("backlog_until")) {
      throw new Error("The Dyna backlog preference schema is incomplete.");
    }
  }

  #backfillItemNumbers(): void {
    const insert = this.#database.prepare("INSERT INTO item_numbers (item_id) VALUES (?)");
    const rows = this.#database
      .prepare(
        `SELECT item.id FROM items item
         LEFT JOIN item_numbers item_number ON item_number.item_id = item.id
         WHERE item_number.item_id IS NULL
         ORDER BY item.rowid, item.id`,
      )
      .all() as SqlRow[];
    for (const row of rows) insert.run(requiredString(row, "id"));
  }

  #backfillFollowUpReferences(): void {
    this.#database
      .prepare(
        `INSERT INTO item_follow_ups (item_id, source_item_id, source_item_number)
         SELECT item.id, item.follow_up_of_item_id, source_number.number
         FROM items item
         JOIN item_numbers source_number ON source_number.item_id = item.follow_up_of_item_id
         WHERE item.follow_up_of_item_id IS NOT NULL
         ON CONFLICT(item_id) DO NOTHING`,
      )
      .run();
  }

  #prepareTaskBindingsForTaskIdentity(): void {
    const conflictingOwner = this.#one(
      this.#database.prepare(
        `SELECT task_id FROM task_bindings
         GROUP BY task_id HAVING COUNT(DISTINCT item_id) > 1 LIMIT 1`,
      ),
    );
    if (conflictingOwner) {
      throw new Error(
        "The Dyna database links one Codex task to multiple items; reconcile those task bindings before upgrading.",
      );
    }
    const duplicates = this.#database
      .prepare("SELECT task_id FROM task_bindings GROUP BY task_id HAVING COUNT(*) > 1")
      .all() as SqlRow[];
    const newestRouting = this.#database.prepare(
      `SELECT * FROM task_bindings WHERE task_id = ?
       ORDER BY observed_ms DESC, status_updated_ms DESC, rowid DESC LIMIT 1`,
    );
    const newestLifecycle = this.#database.prepare(
      `SELECT * FROM task_bindings WHERE task_id = ?
       ORDER BY CASE WHEN state = 'succeeded' THEN 0 ELSE 1 END,
         status_updated_ms DESC, observed_ms DESC, rowid DESC LIMIT 1`,
    );
    const remove = this.#database.prepare("DELETE FROM task_bindings WHERE task_id = ?");
    const insert = this.#database.prepare(
      `INSERT INTO task_bindings (
         item_id, task_id, host_id, project_id, title, state,
         status_updated_at, status_updated_ms, observed_at, observed_ms, outcome
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const duplicate of duplicates) {
      const taskId = requiredString(duplicate, "task_id");
      const routing = this.#one(newestRouting, taskId);
      const lifecycle = this.#one(newestLifecycle, taskId);
      if (!routing || !lifecycle) throw new Error("Dyna could not merge duplicate task bindings.");
      remove.run(taskId);
      insert.run(
        requiredString(lifecycle, "item_id"),
        taskId,
        requiredString(routing, "host_id"),
        optionalString(routing, "project_id") ?? null,
        requiredString(lifecycle, "title"),
        requiredString(lifecycle, "state"),
        requiredString(lifecycle, "status_updated_at"),
        requiredNumber(lifecycle, "status_updated_ms"),
        requiredString(routing, "observed_at"),
        requiredNumber(routing, "observed_ms"),
        optionalString(lifecycle, "outcome") ?? null,
      );
    }
  }

  #createTaskBindingIdentityIndex(): void {
    this.#database.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_dyna_task_bindings_task ON task_bindings(task_id)",
    );
  }

  #backfillTaskSyncCheckpoints(): void {
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO task_sync_checkpoints (
           task_id, host_id, version, cursor, last_turn_id,
           status_updated_at, observed_at, observed_at_ms, updated_at
         )
         SELECT task_id, host_id, 0, NULL, NULL, status_updated_at,
           observed_at, observed_ms, observed_at
         FROM task_bindings`,
      )
      .run();
  }

  #assertItemNumberIntegrity(database: DatabaseSync = this.#database): void {
    const invalidNumber = this.#one(
      database.prepare(
        `SELECT number FROM item_numbers
         WHERE number < 1 OR number > 9007199254740991 LIMIT 1`,
      ),
    );
    const missingNumber = this.#one(
      database.prepare(
        `SELECT item.id FROM items item
         LEFT JOIN item_numbers item_number ON item_number.item_id = item.id
         WHERE item_number.item_id IS NULL LIMIT 1`,
      ),
    );
    const sequence = this.#one(
      database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'item_numbers'"),
    );
    const maximum = this.#one(database.prepare("SELECT MAX(number) AS maximum FROM item_numbers"));
    const maximumNumber = maximum?.["maximum"];
    if (invalidNumber || missingNumber) {
      throw new Error("The Dyna item-number ledger is incomplete or invalid.");
    }
    if (
      typeof maximumNumber === "number" &&
      (maximumNumber > MAX_SAFE_ITEM_NUMBER ||
        !sequence ||
        requiredItemNumber(sequence, "seq") < maximumNumber)
    ) {
      throw new Error("The Dyna item-number sequence is incomplete or invalid.");
    }
    if (
      database
        .prepare(
          "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'item_follow_ups'",
        )
        .get()
    ) {
      const invalidFollowUp = this.#one(
        database.prepare(
          `SELECT follow_up.item_id FROM item_follow_ups follow_up
           LEFT JOIN item_numbers source_number
             ON source_number.number = follow_up.source_item_number
            AND source_number.item_id = follow_up.source_item_id
           WHERE source_number.item_id IS NULL LIMIT 1`,
        ),
      );
      const missingFollowUp = this.#one(
        database.prepare(
          `SELECT item.id FROM items item
           LEFT JOIN item_follow_ups follow_up ON follow_up.item_id = item.id
           WHERE item.follow_up_of_item_id IS NOT NULL
             AND (follow_up.item_id IS NULL OR follow_up.source_item_id <> item.follow_up_of_item_id)
           LIMIT 1`,
        ),
      );
      if (invalidFollowUp || missingFollowUp) {
        throw new Error("The Dyna follow-up reference ledger is incomplete or invalid.");
      }
    }
  }

  #migrateSchema(): void {
    const versionRow = this.#one(this.#database.prepare("PRAGMA user_version"));
    if (!versionRow) throw new Error("Dyna could not read its database schema version.");
    const startingVersion = requiredNumber(versionRow, "user_version");
    if (startingVersion > DYNA_SCHEMA_VERSION) {
      throw new Error(
        "The Dyna database was created by a newer FlowZone version and cannot be opened safely.",
      );
    }
    this.#database.exec("PRAGMA journal_mode = WAL;");
    if (startingVersion === DYNA_SCHEMA_VERSION) {
      this.#assertItemNumberTableSchema();
      // Existing v9 mappings are durable identifiers, not derived cache data. Validate
      // them before repairing any supplemental schema so a damaged ledger never gets
      // silently backfilled with different numbers.
      this.#assertItemNumberIntegrity();
      this.#assertTaskSyncSchemaCurrent();
      this.#assertAnnotationSchemaCurrent();
      this.#assertFullControlSchemaCurrent();
      this.#assertBacklogSchemaCurrent();
      const actionSchemaCurrent = this.#actionRequestsUseV6Constraints();
      const taskIdentityIndexCurrent = this.#namedIndexMatches(
        "task_bindings",
        "idx_dyna_task_bindings_task",
        ["task_id"],
        true,
      );
      const itemNumberIdentityIndexCurrent = this.#namedIndexMatches(
        "item_numbers",
        "idx_dyna_item_numbers_identity",
        ["number", "item_id"],
        true,
      );
      const itemNumberTriggersCurrent = this.#itemNumberTriggersCurrent();
      const followUpReferenceSchemaCurrent = this.#followUpReferenceSchemaCurrent();
      const reservationTablePresent = this.#schemaObjectExists(
        "table",
        "task_association_reservations",
      );
      const taskAssociationReservationSchemaCurrent = reservationTablePresent
        ? this.#taskAssociationReservationSchemaCurrent()
        : false;
      const supplementalIndexesPresent =
        this.#schemaObjectExists("index", "idx_dyna_archive_item_history") &&
        this.#schemaObjectExists("index", "idx_dyna_workflow_history") &&
        this.#schemaObjectExists("index", "idx_dyna_work_updates_task_state") &&
        this.#schemaObjectExists("index", "idx_dyna_action_idempotency") &&
        this.#schemaObjectExists("index", "idx_dyna_actions_item_state") &&
        taskIdentityIndexCurrent &&
        itemNumberIdentityIndexCurrent;
      if (
        actionSchemaCurrent &&
        supplementalIndexesPresent &&
        itemNumberTriggersCurrent &&
        followUpReferenceSchemaCurrent &&
        taskAssociationReservationSchemaCurrent
      ) {
        return;
      }
      this.#transaction(() => {
        if (!actionSchemaCurrent) {
          this.#database
            .prepare(
              `UPDATE action_requests SET dashboard_id = (
                 SELECT sessions.dashboard_id FROM view_sessions sessions
                 WHERE sessions.token_hash = action_requests.view_token_hash
               ) WHERE dashboard_id IS NULL`,
            )
            .run();
          this.#rebuildActionRequestsV6();
        }
        if (!taskIdentityIndexCurrent) this.#prepareTaskBindingsForTaskIdentity();
        this.#createSchema();
        this.#backfillFollowUpReferences();
        this.#createTaskBindingIdentityIndex();
        this.#assertItemNumberTableSchema();
        if (!this.#itemNumberTriggersCurrent()) {
          throw new Error("Dyna could not restore its item-number triggers.");
        }
        if (
          !this.#namedIndexMatches(
            "item_numbers",
            "idx_dyna_item_numbers_identity",
            ["number", "item_id"],
            true,
          )
        ) {
          throw new Error("Dyna could not restore its item-number identity index.");
        }
        if (
          !this.#namedIndexMatches(
            "task_bindings",
            "idx_dyna_task_bindings_task",
            ["task_id"],
            true,
          )
        ) {
          throw new Error("Dyna could not restore its task identity index.");
        }
        if (!this.#followUpReferenceSchemaCurrent()) {
          throw new Error("Dyna could not restore its follow-up reference schema.");
        }
        if (!this.#taskAssociationReservationSchemaCurrent()) {
          throw new Error("Dyna could not restore its task-association reservation schema.");
        }
        this.#assertDatabaseIntegrity();
        this.#assertItemNumberIntegrity();
      });
      return;
    }
    if (startingVersion === 10) {
      this.#transaction(() => {
        this.#migrateFullControlV11();
        this.#migrateBacklogV12();
        this.#createSchema();
        this.#assertAnnotationSchemaCurrent();
        this.#assertFullControlSchemaCurrent();
        this.#assertBacklogSchemaCurrent();
        this.#assertDatabaseIntegrity();
        this.#assertItemNumberIntegrity();
        this.#database.exec("PRAGMA user_version = 12;");
      });
      return;
    }
    if (startingVersion === 11) {
      this.#transaction(() => {
        this.#migrateBacklogV12();
        this.#createSchema();
        this.#assertBacklogSchemaCurrent();
        this.#assertDatabaseIntegrity();
        this.#assertItemNumberIntegrity();
        this.#database.exec("PRAGMA user_version = 12;");
      });
      return;
    }
    if (startingVersion === 1) {
      this.#transaction(() => {
        const publisherColumns = new Set(
          (this.#database.prepare("PRAGMA table_info(publishers)").all() as SqlRow[]).map((row) =>
            requiredString(row, "name"),
          ),
        );
        if (!publisherColumns.has("required_source_slices")) {
          this.#database.exec("ALTER TABLE publishers ADD COLUMN required_source_slices TEXT");
        }
        this.#assertDatabaseIntegrity();
        this.#database.exec("PRAGMA user_version = 2;");
      });
    } else if (startingVersion === 0) {
      this.#transaction(() => {
        this.#createSchema();
        this.#migrateUnversionedSchema();
        this.#sanitizeLegacyFailureMessages();
        this.#database
          .prepare(
            "UPDATE publishers SET schedule_id = NULL WHERE schedule_id IS NOT NULL AND trim(schedule_id) = ''",
          )
          .run();
        const duplicateSchedule = this.#one(
          this.#database.prepare(
            `SELECT schedule_id FROM publishers
             WHERE schedule_id IS NOT NULL
             GROUP BY schedule_id HAVING COUNT(*) > 1 LIMIT 1`,
          ),
        );
        if (duplicateSchedule) {
          throw new Error(
            "The unversioned Dyna database contains duplicate native schedule identifiers; reconcile them before upgrading.",
          );
        }
        const oversizedDashboard = this.#one(
          this.#database.prepare(
            `SELECT dp.dashboard_id FROM dashboard_publishers dp
             JOIN publishers p ON p.id = dp.publisher_id
             WHERE p.schedule_id IS NOT NULL
             GROUP BY dp.dashboard_id HAVING COUNT(*) > ? LIMIT 1`,
          ),
          MAX_SCHEDULES_PER_DASHBOARD,
        );
        if (oversizedDashboard) {
          throw new Error(
            "The unversioned Dyna database has more than 50 schedules on one dashboard; reduce its bindings before upgrading.",
          );
        }
        this.#database.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_dyna_publishers_schedule
            ON publishers(schedule_id) WHERE schedule_id IS NOT NULL;
          CREATE TRIGGER IF NOT EXISTS trg_dyna_schedule_id_immutable
            BEFORE UPDATE OF schedule_id ON publishers
            WHEN OLD.schedule_id IS NOT NULL AND
              (NEW.schedule_id IS NULL OR NEW.schedule_id <> OLD.schedule_id)
            BEGIN
              SELECT RAISE(ABORT, 'Dyna native schedule identifiers are immutable');
            END;
          CREATE INDEX IF NOT EXISTS idx_dyna_dashboard_publishers_publisher
            ON dashboard_publishers(publisher_id, dashboard_id);
          CREATE INDEX IF NOT EXISTS idx_dyna_publisher_items_item
            ON publisher_items(item_id, active, publisher_id);
          CREATE INDEX IF NOT EXISTS idx_dyna_annotations_item_created
            ON annotations(item_id, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_dyna_actions_item_state
            ON action_requests(item_id, kind, state, claim_expires_at);
        `);
        this.#assertDatabaseIntegrity();
        this.#database.exec("PRAGMA user_version = 2;");
      });
    } else if (
      startingVersion !== 2 &&
      startingVersion !== 3 &&
      startingVersion !== 4 &&
      startingVersion !== 5 &&
      startingVersion !== 6 &&
      startingVersion !== 7 &&
      startingVersion !== 8 &&
      startingVersion !== 9
    ) {
      throw new Error("The Dyna database schema version is unsupported.");
    }

    const versionTwoRow = this.#one(this.#database.prepare("PRAGMA user_version"));
    if (!versionTwoRow) {
      throw new Error("Dyna could not complete its database schema migration.");
    }
    if (requiredNumber(versionTwoRow, "user_version") === 2)
      this.#transaction(() => {
        const publisherColumns = new Set(
          (this.#database.prepare("PRAGMA table_info(publishers)").all() as SqlRow[]).map((row) =>
            requiredString(row, "name"),
          ),
        );
        if (!publisherColumns.has("credential_mode")) {
          this.#database.exec(
            "ALTER TABLE publishers ADD COLUMN credential_mode TEXT NOT NULL DEFAULT 'disabled' CHECK (credential_mode IN ('disabled', 'local_preview'))",
          );
        }
        const publisherRunColumns = new Set(
          (this.#database.prepare("PRAGMA table_info(publisher_runs)").all() as SqlRow[]).map(
            (row) => requiredString(row, "name"),
          ),
        );
        if (!publisherRunColumns.has("source_slices")) {
          this.#database.exec("ALTER TABLE publisher_runs ADD COLUMN source_slices TEXT");
        }
        this.#database
          .prepare(
            `UPDATE publishers
           SET credential_mode = 'disabled', schedule_state = 'unknown', token_hash = randomblob(32)
           WHERE NOT EXISTS (
             SELECT 1 FROM dashboard_manual_publishers mp WHERE mp.publisher_id = publishers.id
           )`,
          )
          .run();
        this.#database
          .prepare(
            `UPDATE publishers SET credential_mode = 'disabled'
           WHERE id IN (SELECT publisher_id FROM dashboard_manual_publishers)`,
          )
          .run();
        this.#database
          .prepare(
            `UPDATE item_enrichments SET priority = NULL, priority_reason = NULL
           WHERE priority = 'critical' AND EXISTS (
             SELECT 1 FROM items WHERE items.id = item_enrichments.item_id
               AND items.priority <> 'critical'
           )`,
          )
          .run();
        this.#assertDatabaseIntegrity();
        this.#database.exec("PRAGMA user_version = 3;");
      });
    const versionThreeRow = this.#one(this.#database.prepare("PRAGMA user_version"));
    if (!versionThreeRow) {
      throw new Error("Dyna could not complete its database schema migration.");
    }
    if (requiredNumber(versionThreeRow, "user_version") === 3)
      this.#transaction(() => {
        const publisherColumns = new Set(
          (this.#database.prepare("PRAGMA table_info(publishers)").all() as SqlRow[]).map((row) =>
            requiredString(row, "name"),
          ),
        );
        if (!publisherColumns.has("local_cli_enabled")) {
          this.#database.exec(
            "ALTER TABLE publishers ADD COLUMN local_cli_enabled INTEGER NOT NULL DEFAULT 0 CHECK (local_cli_enabled IN (0, 1))",
          );
        }
        this.#assertDatabaseIntegrity();
        this.#database.exec("PRAGMA user_version = 4;");
      });
    const versionFourRow = this.#one(this.#database.prepare("PRAGMA user_version"));
    if (!versionFourRow) {
      throw new Error("Dyna could not complete its database schema migration.");
    }
    const versionFour = requiredNumber(versionFourRow, "user_version");
    if (versionFour === 4) {
      this.#transaction(() => {
        const dashboardColumns = new Set(
          (this.#database.prepare("PRAGMA table_info(dashboards)").all() as SqlRow[]).map((row) =>
            requiredString(row, "name"),
          ),
        );
        if (!dashboardColumns.has("done_retention_hours")) {
          this.#database.exec(
            "ALTER TABLE dashboards ADD COLUMN done_retention_hours INTEGER NOT NULL DEFAULT 24",
          );
        }
        this.#createSchema();
        this.#assertDatabaseIntegrity();
        this.#database.exec("PRAGMA user_version = 5;");
      });
    } else if (
      versionFour !== 5 &&
      versionFour !== 6 &&
      versionFour !== 7 &&
      versionFour !== 8 &&
      versionFour !== 9
    ) {
      throw new Error("Dyna could not complete its database schema migration.");
    }
    const versionFiveRow = this.#one(this.#database.prepare("PRAGMA user_version"));
    if (!versionFiveRow) {
      throw new Error("Dyna could not complete its database schema migration.");
    }
    const versionFive = requiredNumber(versionFiveRow, "user_version");
    if (versionFive === 5) {
      this.#transaction(() => {
        this.#database
          .prepare(
            `UPDATE action_requests SET dashboard_id = (
               SELECT sessions.dashboard_id FROM view_sessions sessions
               WHERE sessions.token_hash = action_requests.view_token_hash
             ) WHERE dashboard_id IS NULL`,
          )
          .run();
        this.#rebuildActionRequestsV6();
        this.#createSchema();
        this.#assertDatabaseIntegrity();
        this.#database.exec("PRAGMA user_version = 6;");
      });
    } else if (versionFive !== 6 && versionFive !== 7 && versionFive !== 8 && versionFive !== 9) {
      throw new Error("Dyna could not complete its database schema migration.");
    }
    const versionSixRow = this.#one(this.#database.prepare("PRAGMA user_version"));
    if (!versionSixRow) {
      throw new Error("Dyna could not complete its database schema migration.");
    }
    const versionSix = requiredNumber(versionSixRow, "user_version");
    if (versionSix === 6) {
      this.#transaction(() => {
        this.#createSchema();
        this.#assertDatabaseIntegrity();
        this.#database.exec("PRAGMA user_version = 7;");
      });
    } else if (versionSix !== 7 && versionSix !== 8 && versionSix !== 9) {
      throw new Error("Dyna could not complete its database schema migration.");
    }
    const versionSevenRow = this.#one(this.#database.prepare("PRAGMA user_version"));
    if (!versionSevenRow) {
      throw new Error("Dyna could not complete its database schema migration.");
    }
    if (requiredNumber(versionSevenRow, "user_version") === 7) {
      this.#transaction(() => {
        this.#prepareTaskBindingsForTaskIdentity();
        this.#createSchema();
        this.#backfillItemNumbers();
        this.#backfillFollowUpReferences();
        this.#createTaskBindingIdentityIndex();
        this.#assertItemNumberTableSchema();
        if (!this.#itemNumberTriggersCurrent()) {
          throw new Error("Dyna could not create its item-number triggers.");
        }
        if (
          !this.#namedIndexMatches(
            "item_numbers",
            "idx_dyna_item_numbers_identity",
            ["number", "item_id"],
            true,
          )
        ) {
          throw new Error("Dyna could not create its item-number identity index.");
        }
        if (!this.#followUpReferenceSchemaCurrent()) {
          throw new Error("Dyna could not create its follow-up reference schema.");
        }
        if (!this.#taskAssociationReservationSchemaCurrent()) {
          throw new Error("Dyna could not create its task-association reservation schema.");
        }
        this.#assertDatabaseIntegrity();
        this.#assertItemNumberIntegrity();
        this.#database.exec("PRAGMA user_version = 8;");
      });
    } else if (
      requiredNumber(versionSevenRow, "user_version") !== 8 &&
      requiredNumber(versionSevenRow, "user_version") !== 9
    ) {
      throw new Error("Dyna could not complete its database schema migration.");
    }
    const versionEightRow = this.#one(this.#database.prepare("PRAGMA user_version"));
    if (!versionEightRow) {
      throw new Error("Dyna could not complete its database schema migration.");
    }
    const versionEight = requiredNumber(versionEightRow, "user_version");
    if (versionEight === 8) {
      this.#transaction(() => {
        this.#createSchema();
        this.#backfillTaskSyncCheckpoints();
        this.#assertTaskSyncSchemaCurrent();
        this.#assertDatabaseIntegrity();
        this.#assertItemNumberIntegrity();
        this.#database.exec("PRAGMA user_version = 9;");
      });
    } else if (versionEight !== 9) {
      throw new Error("Dyna could not complete its database schema migration.");
    }
    const versionNineRow = this.#one(this.#database.prepare("PRAGMA user_version"));
    if (!versionNineRow || requiredNumber(versionNineRow, "user_version") !== 9) {
      throw new Error("Dyna could not complete its database schema migration.");
    }
    this.#transaction(() => {
      this.#migrateAnnotationsV10();
      this.#assertDatabaseIntegrity();
      this.#assertItemNumberIntegrity();
      this.#database.exec("PRAGMA user_version = 10;");
    });
    const versionTenRow = this.#one(this.#database.prepare("PRAGMA user_version"));
    if (!versionTenRow || requiredNumber(versionTenRow, "user_version") !== 10) {
      throw new Error("Dyna could not complete its database schema migration.");
    }
    this.#transaction(() => {
      this.#migrateFullControlV11();
      this.#createSchema();
      this.#assertAnnotationSchemaCurrent();
      this.#assertFullControlSchemaCurrent();
      this.#assertDatabaseIntegrity();
      this.#assertItemNumberIntegrity();
      this.#database.exec("PRAGMA user_version = 11;");
    });
    const versionElevenRow = this.#one(this.#database.prepare("PRAGMA user_version"));
    if (!versionElevenRow || requiredNumber(versionElevenRow, "user_version") !== 11) {
      throw new Error("Dyna could not complete its database schema migration.");
    }
    this.#transaction(() => {
      this.#migrateBacklogV12();
      this.#createSchema();
      this.#assertBacklogSchemaCurrent();
      this.#assertDatabaseIntegrity();
      this.#assertItemNumberIntegrity();
      this.#database.exec("PRAGMA user_version = 12;");
    });
    const migratedVersion = this.#one(this.#database.prepare("PRAGMA user_version"));
    if (!migratedVersion || requiredNumber(migratedVersion, "user_version") !== 12) {
      throw new Error("Dyna could not complete its database schema migration.");
    }
  }

  #migrateUnversionedSchema(): void {
    const additions: Readonly<Record<string, Readonly<Record<string, string>>>> = {
      dashboards: {
        done_retention_hours: "INTEGER NOT NULL DEFAULT 24",
      },
      publishers: {
        schedule_id: "TEXT",
        schedule_title: "TEXT",
        schedule_state: "TEXT NOT NULL DEFAULT 'unknown'",
        stale_after_minutes: "INTEGER NOT NULL DEFAULT 1440",
        credential_mode:
          "TEXT NOT NULL DEFAULT 'disabled' CHECK (credential_mode IN ('disabled', 'local_preview'))",
        local_cli_enabled: "INTEGER NOT NULL DEFAULT 0 CHECK (local_cli_enabled IN (0, 1))",
        required_source_slices: "TEXT",
        last_run_status: "TEXT NOT NULL DEFAULT 'never'",
        last_run_at: "TEXT",
        last_run_completed_ms: "INTEGER",
        last_run_error: "TEXT",
        revoked_at: "TEXT",
      },
      publisher_runs: {
        source_completed_at: "TEXT",
        source_completed_ms: "INTEGER",
        source_slices: "TEXT",
        request_hash: "TEXT",
        promoted: "INTEGER NOT NULL DEFAULT 1",
      },
      items: {
        identity_key: "TEXT",
        source_updated_ms: "INTEGER",
        people: "TEXT NOT NULL DEFAULT '[]'",
        attention: "TEXT",
        plan: "TEXT NOT NULL DEFAULT '[]'",
        next_steps: "TEXT NOT NULL DEFAULT '[]'",
        leadership_score: "INTEGER NOT NULL DEFAULT 0",
        follow_up_of_item_id: "TEXT REFERENCES items(id) ON DELETE SET NULL",
      },
      item_enrichments: {
        people: "TEXT",
        attention: "TEXT",
        plan: "TEXT",
        next_steps: "TEXT",
        leadership_score: "INTEGER NOT NULL DEFAULT 0",
        version: "INTEGER NOT NULL DEFAULT 1",
      },
      task_bindings: { outcome: "TEXT" },
      action_requests: {
        dashboard_id: "TEXT",
        item_fingerprint: "TEXT",
        dashboard_revision: "INTEGER",
        host_id: "TEXT",
        idempotency_key: "TEXT",
        claim_expires_at: "TEXT",
        uncertain_effect: "INTEGER NOT NULL DEFAULT 0",
      },
    };
    for (const [table, columns] of Object.entries(additions)) {
      const existing = new Set(
        (this.#database.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[]).map((row) =>
          requiredString(row, "name"),
        ),
      );
      for (const [column, definition] of Object.entries(columns)) {
        if (!existing.has(column)) {
          this.#database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
      }
    }
    const preferenceColumns = new Set(
      (this.#database.prepare("PRAGMA table_info(item_preferences)").all() as SqlRow[]).map((row) =>
        requiredString(row, "name"),
      ),
    );
    if (!preferenceColumns.has("dashboard_id")) {
      this.#database.exec(`
          ALTER TABLE item_preferences RENAME TO item_preferences_legacy;
          CREATE TABLE item_preferences (
            dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
            item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
            priority_override TEXT, sequence INTEGER,
            backlogged_at TEXT, backlog_until TEXT, updated_at TEXT NOT NULL,
            PRIMARY KEY (dashboard_id, item_id)
          );
          INSERT INTO item_preferences (
            dashboard_id, item_id, priority_override, sequence, updated_at
          )
          SELECT DISTINCT dp.dashboard_id, legacy.item_id, legacy.priority_override,
            legacy.sequence, legacy.updated_at
          FROM item_preferences_legacy legacy
          JOIN publisher_items pi ON pi.item_id = legacy.item_id AND pi.active = 1
          JOIN dashboard_publishers dp ON dp.publisher_id = pi.publisher_id;
          DROP TABLE item_preferences_legacy;
        `);
    }
    const legacyRuns = this.#database
      .prepare(
        "SELECT publisher_id, run_id, completed_at FROM publisher_runs WHERE source_completed_ms IS NULL",
      )
      .all() as SqlRow[];
    const updateRun = this.#database.prepare(
      "UPDATE publisher_runs SET source_completed_at = ?, source_completed_ms = ? WHERE publisher_id = ? AND run_id = ?",
    );
    for (const row of legacyRuns) {
      const completed = normalizeTimestamp(requiredString(row, "completed_at"));
      updateRun.run(
        completed.iso,
        completed.epoch,
        requiredString(row, "publisher_id"),
        requiredString(row, "run_id"),
      );
    }
    const legacyPublishers = this.#database
      .prepare(
        "SELECT id, last_run_at FROM publishers WHERE last_run_at IS NOT NULL AND last_run_completed_ms IS NULL",
      )
      .all() as SqlRow[];
    const updatePublisher = this.#database.prepare(
      "UPDATE publishers SET last_run_completed_ms = ? WHERE id = ?",
    );
    for (const row of legacyPublishers) {
      updatePublisher.run(
        normalizeTimestamp(requiredString(row, "last_run_at")).epoch,
        requiredString(row, "id"),
      );
    }
    const rows = this.#database
      .prepare("SELECT id, publisher_id, external_id, source_ref, source_updated_at FROM items")
      .all() as SqlRow[];
    const update = this.#database.prepare(
      "UPDATE items SET identity_key = ?, source_updated_ms = ? WHERE id = ?",
    );
    const membership = this.#database.prepare(
      "INSERT OR IGNORE INTO publisher_items (publisher_id, external_id, item_id, active, last_seen_run_id) VALUES (?, ?, ?, 1, 'legacy')",
    );
    for (const row of rows) {
      update.run(
        identityKey(
          requiredString(row, "publisher_id"),
          parseJson(requiredString(row, "source_ref")),
        ),
        normalizeTimestamp(requiredString(row, "source_updated_at")).epoch,
        requiredString(row, "id"),
      );
      membership.run(
        requiredString(row, "publisher_id"),
        requiredString(row, "external_id"),
        requiredString(row, "id"),
      );
    }
    this.#database.exec(`
        UPDATE publisher_items
        SET active = 0
        WHERE EXISTS (
          SELECT 1 FROM items
          WHERE items.id = publisher_items.item_id
            AND items.publisher_id <> publisher_items.publisher_id
        )
    `);
    this.#database
      .prepare(
        "UPDATE task_bindings SET outcome = ? WHERE state = 'succeeded' AND (outcome IS NULL OR trim(outcome) = '')",
      )
      .run(LEGACY_COMPLETION_OUTCOME);
    this.#database.exec(
      "CREATE INDEX IF NOT EXISTS idx_dyna_items_identity ON items(identity_key); CREATE UNIQUE INDEX IF NOT EXISTS idx_dyna_action_idempotency ON action_requests(dashboard_id, idempotency_key) WHERE idempotency_key IS NOT NULL;",
    );
  }

  #sanitizeLegacyFailureMessages(): void {
    const publisherRows = this.#database
      .prepare("SELECT id, last_run_error FROM publishers WHERE last_run_error IS NOT NULL")
      .all() as SqlRow[];
    const updatePublisher = this.#database.prepare(
      "UPDATE publishers SET last_run_error = ? WHERE id = ?",
    );
    for (const row of publisherRows) {
      updatePublisher.run(
        sanitizePersistedFailureMessage(requiredString(row, "last_run_error")),
        requiredString(row, "id"),
      );
    }

    const runRows = this.#database
      .prepare(
        "SELECT publisher_id, run_id, failure_message FROM publisher_runs WHERE failure_message IS NOT NULL",
      )
      .all() as SqlRow[];
    const updateRun = this.#database.prepare(
      "UPDATE publisher_runs SET failure_message = ? WHERE publisher_id = ? AND run_id = ?",
    );
    for (const row of runRows) {
      updateRun.run(
        sanitizePersistedFailureMessage(requiredString(row, "failure_message")),
        requiredString(row, "publisher_id"),
        requiredString(row, "run_id"),
      );
    }

    const actionRows = this.#database
      .prepare("SELECT id, failure_message FROM action_requests WHERE failure_message IS NOT NULL")
      .all() as SqlRow[];
    const updateAction = this.#database.prepare(
      "UPDATE action_requests SET failure_message = ? WHERE id = ?",
    );
    for (const row of actionRows) {
      updateAction.run(
        sanitizePersistedFailureMessage(requiredString(row, "failure_message")),
        requiredString(row, "id"),
      );
    }
  }

  #assertDatabaseIntegrity(): void {
    const integrityRows = this.#database.prepare("PRAGMA integrity_check").all() as SqlRow[];
    const foreignKeyRows = this.#database.prepare("PRAGMA foreign_key_check").all();
    if (
      integrityRows.length !== 1 ||
      !integrityRows[0] ||
      requiredString(integrityRows[0], "integrity_check") !== "ok"
    ) {
      throw new Error(
        "The legacy Dyna database failed its integrity check; migration was rolled back.",
      );
    }
    if (foreignKeyRows.length > 0) {
      throw new Error(
        "The legacy Dyna database contains invalid relationships; migration was rolled back.",
      );
    }
  }

  #transaction<T>(operation: () => T): T {
    if (this.#transactionDepth > 0) return operation();
    this.#database.exec("BEGIN IMMEDIATE");
    this.#transactionDepth += 1;
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK");
      throw error;
    } finally {
      this.#transactionDepth -= 1;
    }
  }

  #readTransaction<T>(operation: () => T): T {
    if (this.#transactionDepth > 0) return operation();
    this.#database.exec("BEGIN");
    this.#transactionDepth += 1;
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK");
      throw error;
    } finally {
      this.#transactionDepth -= 1;
    }
  }

  #one(statement: StatementSync, ...values: SQLInputValue[]): SqlRow | undefined {
    return statement.get(...values);
  }

  #now(): string {
    return this.#clock().toISOString();
  }

  #nowMs(): number {
    return this.#clock().getTime();
  }

  #audit(eventKind: string, entityId: string, instant?: string): void {
    const occurredAt = instant ?? this.#now();
    this.#database
      .prepare(
        "INSERT INTO audit_events (id, event_kind, entity_id, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(randomUUID(), eventKind, entityId, occurredAt);
  }

  #cliMutation<T extends { readonly deduplicated: boolean }>(
    dashboardId: string,
    itemId: string,
    requestId: string,
    operation: string,
    request: unknown,
    mutate: () => T,
  ): T {
    const requestHash = sha256(canonicalJson([operation, dashboardId, itemId, request]));
    return this.#transaction(() => {
      const existing = this.#one(
        this.#database.prepare(
          "SELECT dashboard_id, operation, item_id, request_hash, result_json FROM cli_requests WHERE request_id = ?",
        ),
        requestId,
      );
      if (existing) {
        if (
          requiredString(existing, "dashboard_id") !== dashboardId ||
          requiredString(existing, "operation") !== operation ||
          requiredString(existing, "item_id") !== itemId ||
          requiredString(existing, "request_hash") !== requestHash
        ) {
          throw new DynaCliStoreError(
            "request_conflict",
            "This Dyna request ID was already used for different input.",
          );
        }
        return { ...(parseJson(requiredString(existing, "result_json")) as T), deduplicated: true };
      }
      const dashboard = this.#one(
        this.#database.prepare("SELECT archived FROM dashboards WHERE id = ?"),
        dashboardId,
      );
      if (!dashboard) throw new DynaCliStoreError("not_found", "Dyna dashboard was not found.");
      if (requiredNumber(dashboard, "archived") === 1) {
        throw new DynaCliStoreError("not_found", "Dyna dashboard is archived.");
      }
      const item = this.#one(
        this.#database.prepare("SELECT 1 AS present FROM items WHERE id = ?"),
        itemId,
      );
      if (!item) throw new DynaCliStoreError("not_found", "Dyna item was not found.");
      if (!this.#dashboardContainsItem(dashboardId, itemId)) {
        throw new DynaCliStoreError(
          "outside_dashboard",
          "The Dyna item is outside the requested dashboard.",
        );
      }
      const result = mutate();
      this.#database
        .prepare(
          `INSERT INTO cli_requests (
             dashboard_id, request_id, operation, item_id, request_hash, result_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          dashboardId,
          requestId,
          operation,
          itemId,
          requestHash,
          JSON.stringify(result),
          this.#now(),
        );
      return result;
    });
  }

  #assertDashboardCapacity(): void {
    const row = this.#one(this.#database.prepare("SELECT COUNT(*) AS total FROM dashboards"));
    if (!row) throw new Error("Dyna could not count dashboards.");
    if (requiredNumber(row, "total") >= MAX_DASHBOARDS) {
      throw new Error("Dyna cannot create more than 100 dashboards.");
    }
  }

  #assertPublisherCapacity(): void {
    const row = this.#one(this.#database.prepare("SELECT COUNT(*) AS total FROM publishers"));
    if (!row) throw new Error("Dyna could not count publishers.");
    if (requiredNumber(row, "total") >= MAX_PUBLISHERS) {
      throw new Error("Dyna cannot create more than 100 publishers.");
    }
  }

  #assertManifestCoversActiveSlices(
    publisherId: string,
    requiredSourceSlices: readonly DynaRequiredSourceSlice[],
  ): void {
    const requiredKeys = new Set(
      requiredSourceSlices.map((slice) => publishSourceSliceKey(slice.source, slice.sourceScope)),
    );
    const activeSlices = this.#database
      .prepare(
        `SELECT DISTINCT i.source, i.source_scope FROM publisher_items pi
         JOIN items i ON i.id = pi.item_id
         WHERE pi.publisher_id = ? AND pi.active = 1`,
      )
      .all(publisherId) as SqlRow[];
    if (
      activeSlices.some(
        (row) =>
          !requiredKeys.has(
            publishSourceSliceKey(
              requiredString(row, "source"),
              requiredString(row, "source_scope"),
            ),
          ),
      )
    ) {
      throw new Error(
        "A Dyna publisher manifest must include every source slice with active records.",
      );
    }
  }

  createDashboard(name: string, description: string, doneRetentionHours = 24): DynaDashboard {
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
    return this.#transaction(() => {
      this.#assertDashboardCapacity();
      this.#insertDashboard(dashboard);
      return dashboard;
    });
  }

  #insertDashboard(dashboard: DynaDashboard): void {
    this.#database
      .prepare(
        "INSERT INTO dashboards (id, name, description, archived, revision, done_retention_hours, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
      )
      .run(
        dashboard.id,
        dashboard.name,
        dashboard.description,
        dashboard.archived ? 1 : 0,
        dashboard.doneRetentionHours,
        dashboard.createdAt,
        dashboard.updatedAt,
      );
  }

  updateDashboard(
    id: string,
    values: {
      readonly name?: string;
      readonly description?: string;
      readonly archived?: boolean;
      readonly doneRetentionHours?: number;
    },
  ): DynaDashboard {
    const current = this.getDashboard(id);
    const updated = DynaDashboardSchema.parse({ ...current, ...values, updatedAt: this.#now() });
    this.#updateDashboardRecord(updated);
    return updated;
  }

  #updateDashboardRecord(updated: DynaDashboard): void {
    this.#database
      .prepare(
        "UPDATE dashboards SET name = ?, description = ?, archived = ?, done_retention_hours = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
      )
      .run(
        updated.name,
        updated.description,
        updated.archived ? 1 : 0,
        updated.doneRetentionHours,
        updated.updatedAt,
        updated.id,
      );
  }

  purgeDashboard(id: string, confirmation: string): void {
    if (confirmation !== id) throw new Error("Dashboard purge confirmation did not match.");
    this.#transaction(() => {
      this.getDashboard(id);
      this.#deleteDashboardRecord(id);
      this.#audit("dashboard.purged", id);
    });
  }

  #deleteDashboardRecord(id: string): void {
    const manual = this.#one(
      this.#database.prepare(
        "SELECT publisher_id FROM dashboard_manual_publishers WHERE dashboard_id = ?",
      ),
      id,
    );
    this.#database.prepare("DELETE FROM dashboards WHERE id = ?").run(id);
    if (manual) {
      this.#database
        .prepare("DELETE FROM publishers WHERE id = ?")
        .run(requiredString(manual, "publisher_id"));
    }
  }

  listDashboards(): DynaDashboard[] {
    return (
      this.#database
        .prepare(
          "SELECT id, name, description, archived, done_retention_hours, created_at, updated_at FROM dashboards ORDER BY archived, updated_at DESC",
        )
        .all() as SqlRow[]
    ).map((row) => this.#dashboardFromRow(row));
  }

  getDashboard(id: string): DynaDashboard {
    const row = this.#one(
      this.#database.prepare(
        "SELECT id, name, description, archived, done_retention_hours, created_at, updated_at FROM dashboards WHERE id = ?",
      ),
      id,
    );
    if (!row) throw new Error("Dyna dashboard was not found.");
    return this.#dashboardFromRow(row);
  }

  #dashboardFromRow(row: SqlRow): DynaDashboard {
    return DynaDashboardSchema.parse({
      id: requiredString(row, "id"),
      name: requiredString(row, "name"),
      description: requiredString(row, "description"),
      archived: requiredNumber(row, "archived") === 1,
      doneRetentionHours: requiredNumber(row, "done_retention_hours"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at"),
    });
  }

  createPublisher(
    name: string,
    schedule?: {
      readonly id: string;
      readonly title: string;
      readonly state: "active" | "paused" | "unknown";
      readonly staleAfterMinutes?: number;
    },
    requiredSourceSlices?: readonly DynaRequiredSourceSlice[],
    credentialMode: DynaCredentialMode = "disabled",
  ): { readonly publisher: DynaPublisher; readonly secret?: string } {
    const normalizedCredentialMode = DynaCredentialModeSchema.parse(credentialMode);
    if (normalizedCredentialMode === "disabled" && schedule?.state === "active") {
      throw new Error("A disabled Dyna publisher cannot use an active schedule.");
    }
    const secret = token();
    const normalizedRequiredSlices = requiredSourceSlices
      ? normalizedRequiredSourceSlices(requiredSourceSlices)
      : undefined;
    if (normalizedCredentialMode === "local_cli" && !normalizedRequiredSlices) {
      throw new Error("A local CLI Dyna publisher requires an immutable source manifest.");
    }
    const publisher = DynaPublisherSchema.parse({
      id: randomUUID(),
      name,
      ...(schedule ? { scheduleId: schedule.id, scheduleTitle: schedule.title } : {}),
      scheduleState: schedule?.state ?? "unknown",
      staleAfterMinutes: schedule?.staleAfterMinutes ?? 1_440,
      credentialMode: normalizedCredentialMode,
      ...(normalizedRequiredSlices ? { requiredSourceSlices: normalizedRequiredSlices } : {}),
      lastRunStatus: "never",
      createdAt: this.#now(),
    });
    return this.#transaction(() => {
      this.#assertPublisherCapacity();
      this.#database
        .prepare(
          `
          INSERT INTO publishers (
            id, name, token_hash, schedule_id, schedule_title, schedule_state,
            stale_after_minutes, credential_mode, local_cli_enabled,
            required_source_slices, last_run_status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'never', ?)
        `,
        )
        .run(
          publisher.id,
          publisher.name,
          tokenHash(secret),
          publisher.scheduleId ?? null,
          publisher.scheduleTitle ?? null,
          publisher.scheduleState,
          publisher.staleAfterMinutes,
          normalizedCredentialMode === "local_cli" ? "disabled" : normalizedCredentialMode,
          normalizedCredentialMode === "local_cli" ? 1 : 0,
          publisher.requiredSourceSlices ? JSON.stringify(publisher.requiredSourceSlices) : null,
          publisher.createdAt,
        );
      return publisher.credentialMode === "local_preview" ? { publisher, secret } : { publisher };
    });
  }

  rotatePublisherSecret(publisherId: string): string {
    const secret = token();
    this.#transaction(() => {
      const publisher = this.#one(
        this.#database.prepare(
          "SELECT credential_mode, local_cli_enabled, revoked_at FROM publishers WHERE id = ?",
        ),
        publisherId,
      );
      if (!publisher || optionalString(publisher, "revoked_at")) {
        throw new Error("Active Dyna publisher was not found.");
      }
      if (
        requiredString(publisher, "credential_mode") !== "local_preview" ||
        requiredNumber(publisher, "local_cli_enabled") === 1
      ) {
        throw new Error("Only a local-preview Dyna publisher can rotate credentials.");
      }
      const changed = this.#database
        .prepare("UPDATE publishers SET token_hash = ? WHERE id = ? AND revoked_at IS NULL")
        .run(tokenHash(secret), publisherId).changes;
      if (changed !== 1) throw new Error("Active Dyna publisher was not found.");
      this.#audit("publisher.rotated", publisherId);
    });
    return secret;
  }

  enableLocalCliPublisher(publisherId: string): void {
    this.#transaction(() => {
      const publisher = this.#one(
        this.#database.prepare(
          "SELECT credential_mode, local_cli_enabled, required_source_slices, revoked_at FROM publishers WHERE id = ?",
        ),
        publisherId,
      );
      if (!publisher || optionalString(publisher, "revoked_at")) {
        throw new Error("Active Dyna publisher was not found.");
      }
      if (requiredNumber(publisher, "local_cli_enabled") === 1) return;
      if (requiredString(publisher, "credential_mode") !== "disabled") {
        throw new Error("Only a disabled Dyna publisher can enable local CLI publication.");
      }
      if (!requiredSourceSlicesFromRow(publisher)) {
        throw new Error("A local CLI Dyna publisher requires an immutable source manifest.");
      }
      const changed = this.#database
        .prepare(
          "UPDATE publishers SET local_cli_enabled = 1, token_hash = randomblob(32) WHERE id = ? AND credential_mode = 'disabled' AND local_cli_enabled = 0 AND revoked_at IS NULL",
        )
        .run(publisherId).changes;
      if (changed !== 1) throw new Error("Active disabled Dyna publisher was not found.");
      this.#touchDashboardsForPublisher(publisherId);
      this.#audit("publisher.local_cli_enabled", publisherId);
    });
  }

  revokePublisher(publisherId: string, purgePublishedData: boolean): void {
    this.#transaction(() => {
      const dashboardIds = (
        this.#database
          .prepare("SELECT dashboard_id FROM dashboard_publishers WHERE publisher_id = ?")
          .all(publisherId) as SqlRow[]
      ).map((row) => requiredString(row, "dashboard_id"));
      const publisher = this.#one(
        this.#database.prepare("SELECT id FROM publishers WHERE id = ?"),
        publisherId,
      );
      if (!publisher) throw new Error("Dyna publisher was not found.");
      if (purgePublishedData) {
        this.#database.prepare("DELETE FROM publishers WHERE id = ?").run(publisherId);
      } else {
        this.#database
          .prepare(
            "UPDATE publishers SET revoked_at = COALESCE(revoked_at, ?), schedule_state = 'unknown', local_cli_enabled = 0, token_hash = randomblob(32) WHERE id = ?",
          )
          .run(this.#now(), publisherId);
      }
      this.#touchDashboards(dashboardIds);
      this.#audit(purgePublishedData ? "publisher.purged" : "publisher.revoked", publisherId);
    });
  }

  bindSchedule(
    dashboardId: string,
    publisherId: string,
    schedule: {
      readonly id: string;
      readonly title: string;
      readonly state: "active" | "paused" | "unknown";
      readonly staleAfterMinutes: number;
      readonly requiredSourceSlices?: readonly DynaRequiredSourceSlice[];
    },
  ): void {
    const scheduleId = schedule.id.trim();
    const scheduleTitle = schedule.title.trim();
    if (!scheduleId || scheduleId.length > 256) {
      throw new Error("A valid Dyna schedule identifier is required.");
    }
    if (!scheduleTitle || scheduleTitle.length > 200) {
      throw new Error("A valid Dyna schedule title is required.");
    }
    if (
      !Number.isInteger(schedule.staleAfterMinutes) ||
      schedule.staleAfterMinutes < 5 ||
      schedule.staleAfterMinutes > 43_200
    ) {
      throw new Error("Dyna schedule freshness must be between 5 and 43200 minutes.");
    }
    this.getDashboard(dashboardId);
    const instant = this.#now();
    this.#transaction(() => {
      const publisher = this.#one(
        this.#database.prepare(
          "SELECT schedule_id, credential_mode, local_cli_enabled, required_source_slices, revoked_at FROM publishers WHERE id = ?",
        ),
        publisherId,
      );
      if (!publisher) throw new Error("Dyna publisher was not found.");
      if (optionalString(publisher, "revoked_at")) {
        throw new Error("A revoked Dyna publisher cannot be bound to a schedule.");
      }
      if (schedule.state === "active" && publisherCredentialModeFromRow(publisher) === "disabled") {
        throw new Error("A disabled Dyna publisher cannot use an active schedule.");
      }
      const currentScheduleId = optionalString(publisher, "schedule_id");
      if (currentScheduleId && currentScheduleId !== scheduleId) {
        throw new Error("A Dyna publisher's native schedule identifier is immutable.");
      }
      const collision = this.#one(
        this.#database.prepare(
          "SELECT id FROM publishers WHERE schedule_id = ? AND id <> ? LIMIT 1",
        ),
        scheduleId,
        publisherId,
      );
      if (collision) throw new Error("This native schedule identifier is already registered.");
      const currentRequiredSlices = requiredSourceSlicesFromRow(publisher);
      const requestedRequiredSlices = schedule.requiredSourceSlices
        ? normalizedRequiredSourceSlices(schedule.requiredSourceSlices)
        : undefined;
      if (
        currentRequiredSlices &&
        requestedRequiredSlices &&
        JSON.stringify(currentRequiredSlices) !== JSON.stringify(requestedRequiredSlices)
      ) {
        throw new Error(
          "A Dyna publisher's required source manifest is immutable once registered.",
        );
      }
      if (!currentRequiredSlices && requestedRequiredSlices) {
        this.#assertManifestCoversActiveSlices(publisherId, requestedRequiredSlices);
      }
      const requiredSlices = currentRequiredSlices ?? requestedRequiredSlices;
      const requiredSlicesJson = requiredSlices ? JSON.stringify(requiredSlices) : null;

      const dashboardIds = new Set(
        (
          this.#database
            .prepare("SELECT dashboard_id FROM dashboard_publishers WHERE publisher_id = ?")
            .all(publisherId) as SqlRow[]
        ).map((row) => requiredString(row, "dashboard_id")),
      );
      dashboardIds.add(dashboardId);
      const scheduledPublisherCount = this.#database.prepare(
        `SELECT COUNT(*) AS total FROM dashboard_publishers dp
         JOIN publishers p ON p.id = dp.publisher_id
         WHERE dp.dashboard_id = ? AND p.schedule_id IS NOT NULL AND p.id <> ?`,
      );
      for (const boundDashboardId of dashboardIds) {
        const countRow = this.#one(scheduledPublisherCount, boundDashboardId, publisherId);
        if (!countRow) throw new Error("Dyna could not count schedule bindings.");
        if (requiredNumber(countRow, "total") >= MAX_SCHEDULES_PER_DASHBOARD) {
          throw new Error("A Dyna dashboard cannot bind more than 50 schedules.");
        }
      }

      const updated = this.#database
        .prepare(
          `UPDATE publishers SET schedule_id = ?, schedule_title = ?, schedule_state = ?, stale_after_minutes = ?, required_source_slices = ?
           WHERE id = ? AND (
             COALESCE(schedule_id, '') != ? OR COALESCE(schedule_title, '') != ? OR
             schedule_state != ? OR stale_after_minutes != ? OR
             COALESCE(required_source_slices, '') != COALESCE(?, '')
           )`,
        )
        .run(
          scheduleId,
          scheduleTitle,
          schedule.state,
          schedule.staleAfterMinutes,
          requiredSlicesJson,
          publisherId,
          scheduleId,
          scheduleTitle,
          schedule.state,
          schedule.staleAfterMinutes,
          requiredSlicesJson,
        ).changes;
      const bound = this.#database
        .prepare(
          "INSERT OR IGNORE INTO dashboard_publishers (dashboard_id, publisher_id) VALUES (?, ?)",
        )
        .run(dashboardId, publisherId).changes;
      if (updated === 1) this.#touchDashboardsForPublisher(publisherId, instant);
      else if (bound === 1) this.#touchDashboards([dashboardId], instant);
      this.#audit("schedule.bound", publisherId, instant);
    });
  }

  unbindSchedule(dashboardId: string, publisherId: string): void {
    this.#transaction(() => {
      this.getDashboard(dashboardId);
      const changed = this.#database
        .prepare("DELETE FROM dashboard_publishers WHERE dashboard_id = ? AND publisher_id = ?")
        .run(dashboardId, publisherId).changes;
      if (changed === 1) {
        this.#touchDashboards([dashboardId]);
        this.#audit("schedule.unbound", publisherId);
      }
    });
  }

  updateScheduleStatus(
    publisherId: string,
    schedule: {
      readonly title?: string;
      readonly state: "active" | "paused" | "unknown";
      readonly staleAfterMinutes?: number;
      readonly requiredSourceSlices?: readonly DynaRequiredSourceSlice[];
    },
  ): void {
    this.#transaction(() => {
      const row = this.#one(
        this.#database.prepare(
          "SELECT schedule_title, schedule_state, stale_after_minutes, credential_mode, local_cli_enabled, required_source_slices, revoked_at FROM publishers WHERE id = ?",
        ),
        publisherId,
      );
      if (!row) throw new Error("Dyna publisher was not found.");
      if (optionalString(row, "revoked_at")) {
        throw new Error("A revoked Dyna publisher's schedule status cannot be updated.");
      }
      if (schedule.state === "active" && publisherCredentialModeFromRow(row) === "disabled") {
        throw new Error("A disabled Dyna publisher cannot use an active schedule.");
      }
      const title = schedule.title ?? optionalString(row, "schedule_title");
      const staleAfterMinutes =
        schedule.staleAfterMinutes ?? requiredNumber(row, "stale_after_minutes");
      const currentRequiredSlices = requiredSourceSlicesFromRow(row);
      const requestedRequiredSlices = schedule.requiredSourceSlices
        ? normalizedRequiredSourceSlices(schedule.requiredSourceSlices)
        : undefined;
      if (
        currentRequiredSlices &&
        requestedRequiredSlices &&
        JSON.stringify(currentRequiredSlices) !== JSON.stringify(requestedRequiredSlices)
      ) {
        throw new Error(
          "A Dyna publisher's required source manifest is immutable once registered.",
        );
      }
      if (!currentRequiredSlices && requestedRequiredSlices) {
        this.#assertManifestCoversActiveSlices(publisherId, requestedRequiredSlices);
      }
      const requiredSlices = currentRequiredSlices ?? requestedRequiredSlices;
      const requiredSlicesJson = requiredSlices ? JSON.stringify(requiredSlices) : null;
      const changed = this.#database
        .prepare(
          "UPDATE publishers SET schedule_title = ?, schedule_state = ?, stale_after_minutes = ?, required_source_slices = ? WHERE id = ? AND (COALESCE(schedule_title, '') != COALESCE(?, '') OR schedule_state != ? OR stale_after_minutes != ? OR COALESCE(required_source_slices, '') != COALESCE(?, ''))",
        )
        .run(
          title ?? null,
          schedule.state,
          staleAfterMinutes,
          requiredSlicesJson,
          publisherId,
          title ?? null,
          schedule.state,
          staleAfterMinutes,
          requiredSlicesJson,
        ).changes;
      if (changed === 1) this.#touchDashboardsForPublisher(publisherId);
    });
  }

  listPublishers(dashboardId?: string): DynaPublisher[] {
    const rows = dashboardId
      ? (this.#database
          .prepare(
            `
            SELECT p.*, (
              SELECT pr.source_slices FROM publisher_runs pr
              WHERE pr.publisher_id = p.id AND pr.promoted = 1
              ORDER BY pr.source_completed_ms DESC, pr.completed_at DESC LIMIT 1
            ) AS latest_source_slices FROM publishers p
            JOIN dashboard_publishers dp ON dp.publisher_id = p.id
            LEFT JOIN dashboard_manual_publishers mp ON mp.publisher_id = p.id
            WHERE dp.dashboard_id = ? AND mp.publisher_id IS NULL ORDER BY p.name, p.id
          `,
          )
          .all(dashboardId) as SqlRow[])
      : (this.#database
          .prepare(
            `SELECT p.*, (
               SELECT pr.source_slices FROM publisher_runs pr
               WHERE pr.publisher_id = p.id AND pr.promoted = 1
               ORDER BY pr.source_completed_ms DESC, pr.completed_at DESC LIMIT 1
             ) AS latest_source_slices FROM publishers p
             LEFT JOIN dashboard_manual_publishers mp ON mp.publisher_id = p.id
             WHERE mp.publisher_id IS NULL ORDER BY p.name, p.id`,
          )
          .all() as SqlRow[]);
    return rows.map((row) => this.#publisherFromRow(row));
  }

  #publisherFromRow(row: SqlRow): DynaPublisher {
    const lastRunError = optionalString(row, "last_run_error");
    const requiredSourceSlices = requiredSourceSlicesFromRow(row);
    const lastRunAt = optionalString(row, "last_run_at");
    const revokedAt = optionalString(row, "revoked_at");
    const staleAfterMinutes = requiredNumber(row, "stale_after_minutes");
    const publishSourceSlices = publishSourceSlicesFromRow(row);
    const successfulSliceFreshness =
      lastRunAt && !revokedAt
        ? (() => {
            const age = Math.max(0, this.#nowMs() - Date.parse(lastRunAt));
            const staleAfter = staleAfterMinutes * 60_000;
            return age > staleAfter ? "stale" : age > staleAfter * 0.75 ? "aging" : "fresh";
          })()
        : "stale";
    return DynaPublisherSchema.parse({
      id: requiredString(row, "id"),
      name: requiredString(row, "name"),
      ...(optionalString(row, "schedule_id")
        ? { scheduleId: optionalString(row, "schedule_id") }
        : {}),
      ...(optionalString(row, "schedule_title")
        ? { scheduleTitle: optionalString(row, "schedule_title") }
        : {}),
      scheduleState: requiredString(row, "schedule_state"),
      staleAfterMinutes,
      credentialMode: publisherCredentialModeFromRow(row),
      ...(requiredSourceSlices ? { requiredSourceSlices } : {}),
      lastRunStatus: requiredString(row, "last_run_status"),
      ...(lastRunAt ? { lastRunAt } : {}),
      ...(lastRunError ? { lastRunError: sanitizePersistedFailureMessage(lastRunError) } : {}),
      ...(publishSourceSlices
        ? {
            lastSourceSlices: publishSourceSlices.map((slice) => ({
              ...slice,
              freshness: slice.status === "failed" ? "stale" : successfulSliceFreshness,
            })),
          }
        : {}),
      ...(revokedAt ? { revokedAt } : {}),
      createdAt: requiredString(row, "created_at"),
    });
  }

  publish(
    publisherId: string,
    secret: string,
    items: readonly DynaPublishedItem[],
    options: DynaPublishOptions,
  ): DynaPublishResult {
    return this.#publishAuthorized(publisherId, secret, items, options);
  }

  publishLocal(
    publisherId: string,
    items: readonly DynaPublishedItem[],
    options: DynaPublishOptions,
  ): DynaPublishResult {
    return this.#publishAuthorized(publisherId, undefined, items, options);
  }

  #publishAuthorized(
    publisherId: string,
    secret: string | undefined,
    items: readonly DynaPublishedItem[],
    options: DynaPublishOptions,
  ): DynaPublishResult {
    const failureMessage =
      options.failureMessage === undefined
        ? undefined
        : sanitizePublicFailureMessage(options.failureMessage);
    const parsedItems = items.map(normalizedScheduledPublishedItem);
    const sourceSlices = options.sourceSlices
      ? [...DynaPublishSourceSlicesSchema.parse(options.sourceSlices)].sort(
          comparePublishSourceSlices,
        )
      : undefined;
    const sourceSlicesJson = sourceSlices ? JSON.stringify(sourceSlices) : null;
    if (options.status === "failed" && (parsedItems.length > 0 || !failureMessage)) {
      throw new Error("A failed Dyna run requires an error and cannot publish a partial snapshot.");
    }
    if (options.status === "succeeded" && failureMessage) {
      throw new Error("A successful Dyna run cannot include an error.");
    }
    if (options.status === "partial" && !failureMessage) {
      throw new Error("A partial Dyna run requires a bounded error.");
    }
    if (
      options.status === "partial" &&
      !sourceSlices &&
      (options.mode !== "upsert" || parsedItems.length === 0)
    ) {
      throw new Error(
        "A partial Dyna run requires upsert mode, at least one item, and a bounded error.",
      );
    }
    if (sourceSlices) {
      if (options.mode !== "replace") {
        throw new Error("A source-sliced Dyna run requires replace mode.");
      }
      const succeededSlices = new Set(
        sourceSlices
          .filter((slice) => slice.status === "succeeded")
          .map((slice) => publishSourceSliceKey(slice.source, slice.sourceScope)),
      );
      const failedSliceCount = sourceSlices.length - succeededSlices.size;
      const derivedStatus =
        succeededSlices.size === 0 ? "failed" : failedSliceCount === 0 ? "succeeded" : "partial";
      if (options.status !== derivedStatus) {
        throw new Error(
          `A source-sliced Dyna run with these slice results must have status ${derivedStatus}.`,
        );
      }
      for (const item of parsedItems) {
        const key = publishSourceSliceKey(item.sourceRef.source, item.sourceScope);
        if (!succeededSlices.has(key)) {
          throw new Error(
            "A source-sliced Dyna run can publish items only for a declared successful slice.",
          );
        }
      }
    }
    const sourceCompletion = normalizeTimestamp(options.sourceCompletedAt, true);
    const requestHash = sha256(
      JSON.stringify({
        runId: options.runId,
        sourceCompletedAt: sourceCompletion.iso,
        mode: options.mode,
        status: options.status,
        failureMessage: failureMessage ?? null,
        sourceSlices: sourceSlices ?? null,
        items: parsedItems,
      }),
    );
    const instant = this.#now();
    return this.#transaction(() => {
      const publisher = this.#one(
        this.#database.prepare(
          "SELECT token_hash, credential_mode, local_cli_enabled, required_source_slices, revoked_at FROM publishers WHERE id = ?",
        ),
        publisherId,
      );
      const credentialMatches = publisher
        ? secret === undefined
          ? requiredNumber(publisher, "local_cli_enabled") === 1
          : requiredString(publisher, "credential_mode") === "local_preview" &&
            requiredNumber(publisher, "local_cli_enabled") === 0 &&
            hashesMatch(secret, publisher["token_hash"])
        : false;
      if (!publisher || optionalString(publisher, "revoked_at") || !credentialMatches) {
        throw new Error("Dyna publisher credentials are invalid.");
      }
      const requiredSourceSlices = requiredSourceSlicesFromRow(publisher);
      if (secret === undefined && !requiredSourceSlices) {
        throw new Error("A local CLI Dyna publisher requires an immutable source manifest.");
      }
      if (requiredSourceSlices) {
        if (!sourceSlices) {
          throw new Error(
            "A Dyna run must declare every source slice required by its publisher manifest.",
          );
        }
        const declaredSliceKeys = new Set(
          sourceSlices.map((slice) => publishSourceSliceKey(slice.source, slice.sourceScope)),
        );
        if (
          declaredSliceKeys.size !== requiredSourceSlices.length ||
          requiredSourceSlices.some(
            (slice) =>
              !declaredSliceKeys.has(publishSourceSliceKey(slice.source, slice.sourceScope)),
          )
        ) {
          throw new Error(
            "A Dyna run's source slices must exactly match its publisher manifest, including failed slices.",
          );
        }
      }
      const previous = this.#one(
        this.#database.prepare(
          "SELECT status, item_count, promoted, request_hash FROM publisher_runs WHERE publisher_id = ? AND run_id = ?",
        ),
        publisherId,
        options.runId,
      );
      if (previous) {
        if (optionalString(previous, "request_hash") !== requestHash) {
          throw new Error("Dyna rejected a run ID reused with different publication data.");
        }
        return {
          accepted: requiredNumber(previous, "item_count"),
          deduplicated: true,
          superseded: requiredNumber(previous, "promoted") !== 1,
          status: requiredString(previous, "status") as "succeeded" | "partial" | "failed",
        };
      }

      const currentPublisher = this.#one(
        this.#database.prepare("SELECT last_run_completed_ms FROM publishers WHERE id = ?"),
        publisherId,
      );
      if (!currentPublisher) throw new Error("Dyna publisher was not found.");
      const lastCompletion = currentPublisher["last_run_completed_ms"];
      if (typeof lastCompletion === "number" && sourceCompletion.epoch <= lastCompletion) {
        this.#database
          .prepare(
            `
            INSERT INTO publisher_runs (
              publisher_id, run_id, mode, status, item_count, failure_message,
              source_completed_at, source_completed_ms, source_slices, request_hash,
              promoted, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
          `,
          )
          .run(
            publisherId,
            options.runId,
            options.mode,
            options.status,
            parsedItems.length,
            failureMessage ?? null,
            sourceCompletion.iso,
            sourceCompletion.epoch,
            sourceSlicesJson,
            requestHash,
            instant,
          );
        this.#audit("publisher.run.superseded", publisherId, instant);
        return {
          accepted: parsedItems.length,
          deduplicated: false,
          superseded: true,
          status: options.status,
        };
      }

      const affectedDashboards = new Set(
        (
          this.#database
            .prepare("SELECT dashboard_id FROM dashboard_publishers WHERE publisher_id = ?")
            .all(publisherId) as SqlRow[]
        ).map((row) => requiredString(row, "dashboard_id")),
      );
      if (options.status !== "failed") {
        if (options.mode === "replace") {
          if (sourceSlices) {
            const deactivateSlice = this.#database.prepare(`
              UPDATE publisher_items SET active = 0
              WHERE publisher_id = ? AND EXISTS (
                SELECT 1 FROM items
                WHERE items.id = publisher_items.item_id
                  AND items.source = ? AND items.source_scope = ?
              )
            `);
            for (const slice of sourceSlices) {
              if (slice.status === "succeeded") {
                deactivateSlice.run(publisherId, slice.source, slice.sourceScope);
              }
            }
          } else {
            this.#database
              .prepare("UPDATE publisher_items SET active = 0 WHERE publisher_id = ?")
              .run(publisherId);
          }
        }
        const insertItem = this.#database.prepare(`
          INSERT INTO items (
            id, publisher_id, external_id, identity_key, source, source_ref, source_scope, title,
            summary, priority, priority_reason, source_updated_at, source_updated_ms, due_at,
            labels, people, leadership_score, attention, plan, next_steps, follow_up_of_item_id,
            fingerprint, updated_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            NULL, ?, ?
          )
        `);
        const updateItem = this.#database.prepare(`
          UPDATE items SET source = ?, source_ref = ?, source_scope = ?, title = ?, summary = ?,
            priority = ?, priority_reason = ?, source_updated_at = ?, source_updated_ms = ?,
            due_at = ?, labels = ?, people = ?, leadership_score = ?, attention = ?, plan = ?, next_steps = ?,
            fingerprint = ?, updated_at = ? WHERE id = ?
        `);
        const upsertMembership = this.#database.prepare(`
          INSERT INTO publisher_items (publisher_id, external_id, item_id, active, last_seen_run_id)
          VALUES (?, ?, ?, 1, ?)
          ON CONFLICT(publisher_id, external_id) DO UPDATE SET
            item_id = excluded.item_id, active = 1, last_seen_run_id = excluded.last_seen_run_id
        `);
        for (const item of parsedItems) {
          const canonical = JSON.stringify(item);
          const fingerprint = sha256(canonical);
          const identity = identityKey(publisherId, item.sourceRef);
          const sourceMs = normalizeTimestamp(item.sourceUpdatedAt).epoch;
          let existing = this.#one(
            this.#database.prepare(
              "SELECT * FROM items WHERE identity_key = ? ORDER BY source_updated_ms DESC LIMIT 1",
            ),
            identity,
          );
          if (
            sourceSlices &&
            existing &&
            (requiredString(existing, "source") !== item.sourceRef.source ||
              requiredString(existing, "source_scope") !== item.sourceScope)
          ) {
            throw new Error(
              "A source-sliced Dyna run cannot move an existing source reference between slices.",
            );
          }
          if (sourceSlices) {
            const existingMembership = this.#one(
              this.#database.prepare(`
                SELECT i.source, i.source_scope FROM publisher_items pi
                JOIN items i ON i.id = pi.item_id
                WHERE pi.publisher_id = ? AND pi.external_id = ?
              `),
              publisherId,
              item.externalId,
            );
            if (
              existingMembership &&
              (requiredString(existingMembership, "source") !== item.sourceRef.source ||
                requiredString(existingMembership, "source_scope") !== item.sourceScope)
            ) {
              throw new Error(
                "A source-sliced Dyna run cannot move an external ID between source slices.",
              );
            }
          }
          if (!existing) {
            const id = randomUUID();
            insertItem.run(
              id,
              publisherId,
              item.externalId,
              identity,
              item.sourceRef.source,
              JSON.stringify(item.sourceRef),
              item.sourceScope,
              item.title,
              item.summary,
              item.priority,
              item.priorityReason,
              item.sourceUpdatedAt,
              sourceMs,
              item.dueAt ?? null,
              JSON.stringify(item.labels),
              JSON.stringify(item.people),
              dynaLeadershipScore(item.people),
              item.attention ?? null,
              JSON.stringify(item.plan),
              JSON.stringify(item.nextSteps),
              fingerprint,
              instant,
            );
            existing = this.#one(this.#database.prepare("SELECT * FROM items WHERE id = ?"), id);
          } else {
            const existingMs = requiredNumber(existing, "source_updated_ms");
            const existingFingerprint = requiredString(existing, "fingerprint");
            if (sourceMs === existingMs && fingerprint !== existingFingerprint) {
              throw new Error(
                "Dyna rejected conflicting source data with the same update timestamp.",
              );
            }
            if (sourceMs > existingMs) {
              updateItem.run(
                item.sourceRef.source,
                JSON.stringify(item.sourceRef),
                item.sourceScope,
                item.title,
                item.summary,
                item.priority,
                item.priorityReason,
                item.sourceUpdatedAt,
                sourceMs,
                item.dueAt ?? null,
                JSON.stringify(item.labels),
                JSON.stringify(item.people),
                dynaLeadershipScore(item.people),
                item.attention ?? null,
                JSON.stringify(item.plan),
                JSON.stringify(item.nextSteps),
                fingerprint,
                instant,
                requiredString(existing, "id"),
              );
            }
          }
          if (!existing) throw new Error("Dyna could not persist a source item.");
          const itemId = requiredString(existing, "id");
          upsertMembership.run(publisherId, item.externalId, itemId, options.runId);
          for (const row of this.#database
            .prepare(
              `
              SELECT DISTINCT dp.dashboard_id FROM dashboard_publishers dp
              JOIN publisher_items pi ON pi.publisher_id = dp.publisher_id
              WHERE pi.item_id = ? AND pi.active = 1
            `,
            )
            .all(itemId) as SqlRow[]) {
            affectedDashboards.add(requiredString(row, "dashboard_id"));
          }
        }
      }

      this.#database
        .prepare(
          `
          INSERT INTO publisher_runs (
            publisher_id, run_id, mode, status, item_count, failure_message,
            source_completed_at, source_completed_ms, source_slices, request_hash,
            promoted, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        `,
        )
        .run(
          publisherId,
          options.runId,
          options.mode,
          options.status,
          parsedItems.length,
          failureMessage ?? null,
          sourceCompletion.iso,
          sourceCompletion.epoch,
          sourceSlicesJson,
          requestHash,
          instant,
        );
      this.#database
        .prepare(
          "UPDATE publishers SET last_run_status = ?, last_run_at = ?, last_run_completed_ms = ?, last_run_error = ? WHERE id = ?",
        )
        .run(
          options.status,
          sourceCompletion.iso,
          sourceCompletion.epoch,
          failureMessage ?? null,
          publisherId,
        );
      this.#touchDashboards(affectedDashboards, instant);
      this.#audit(`publisher.run.${options.status}`, publisherId, instant);
      return {
        accepted: parsedItems.length,
        deduplicated: false,
        superseded: false,
        status: options.status,
      };
    });
  }

  addAnnotation(
    viewToken: string,
    itemId: string,
    clientRequestId: string,
    body: string,
  ): z.infer<typeof DynaAnnotationSchema> {
    const instant = this.#now();
    const input = DynaAnnotationSchema.parse({
      id: clientRequestId,
      itemId,
      body,
      createdAt: instant,
      updatedAt: instant,
      version: 1,
    });
    const canonicalRequestId = input.id.toLowerCase();
    const requestHash = sha256(JSON.stringify({ body: input.body }));
    return this.#transaction(() => {
      const dashboardId = this.authorizeView(viewToken, itemId);
      const annotationId = scopedUuid([
        "annotation-request",
        dashboardId,
        itemId,
        canonicalRequestId,
      ]);
      const existing = this.#one(
        this.#database.prepare("SELECT * FROM annotations WHERE id = ?"),
        annotationId,
      );
      if (existing) {
        const existingHash = sha256(JSON.stringify({ body: requiredString(existing, "body") }));
        if (requiredString(existing, "item_id") !== itemId || existingHash !== requestHash) {
          throw new Error("Dyna rejected an annotation request ID reused with different content.");
        }
        return DynaAnnotationSchema.parse({
          id: annotationId,
          itemId,
          body: requiredString(existing, "body"),
          createdAt: requiredString(existing, "created_at"),
          updatedAt: requiredString(existing, "updated_at"),
          version: requiredNumber(existing, "version"),
        });
      }
      const annotation = DynaAnnotationSchema.parse({
        id: annotationId,
        itemId,
        body: input.body,
        createdAt: instant,
        updatedAt: instant,
        version: 1,
      });
      this.#database
        .prepare(
          `INSERT INTO annotations (
             id, item_id, body, created_at, updated_at, version, deleted_at
           ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          annotation.id,
          annotation.itemId,
          annotation.body,
          annotation.createdAt,
          annotation.updatedAt,
          annotation.version,
        );
      this.#insertAnnotationEvent({
        id: scopedUuid(["annotation-create-request", annotation.id]),
        annotationId: annotation.id,
        itemId: annotation.itemId,
        operation: "create",
        requestHash: sha256(
          canonicalJson({
            operation: "create",
            annotationId: annotation.id,
            body: annotation.body,
          }),
        ),
        resultVersion: annotation.version,
        occurredAt: annotation.createdAt,
      });
      this.#touchDashboardsForItem(itemId);
      this.#audit("annotation.created", itemId);
      return annotation;
    });
  }

  addTodo(viewToken: string, input: DynaTodoInput, clientRequestId: string): string {
    const dashboardId = this.authorizeView(viewToken);
    return this.#createTodo(dashboardId, input, clientRequestId).itemId;
  }

  createTodoFromCli(dashboardId: string, input: DynaTodoCreateInput): DynaTodoCreateResult {
    const parsed = DynaTodoCreateInputSchema.parse(input);
    const { requestId, ...todo } = parsed;
    const created = this.#createTodo(dashboardId, todo, requestId);
    return DynaTodoCreateResultSchema.parse({
      schema: "dyna/todo-create-result-v2",
      requestId,
      itemId: created.itemId,
      itemNumber: created.itemNumber,
      fingerprint: created.fingerprint,
      deduplicated: created.deduplicated,
    });
  }

  #createTodo(
    dashboardId: string,
    input: DynaTodoInput,
    clientRequestId: string,
  ): {
    readonly itemId: string;
    readonly itemNumber: DynaItemNumber;
    readonly fingerprint: string;
    readonly deduplicated: boolean;
  } {
    const parsed = DynaTodoInputSchema.parse(input);
    const requestHash = sha256(JSON.stringify(parsed));
    const instant = this.#now();
    return this.#transaction(() => {
      const previous = this.#one(
        this.#database.prepare(
          "SELECT request_hash, item_id FROM todo_requests WHERE dashboard_id = ? AND client_request_id = ?",
        ),
        dashboardId,
        clientRequestId,
      );
      if (previous) {
        if (requiredString(previous, "request_hash") !== requestHash) {
          throw new DynaCliStoreError(
            "request_conflict",
            "This Dyna to-do request ID was reused with different content.",
          );
        }
        const itemId = requiredString(previous, "item_id");
        const item = this.#itemBaseRow(itemId);
        return {
          itemId,
          itemNumber: requiredItemNumber(item, "item_number"),
          fingerprint: requiredString(item, "fingerprint"),
          deduplicated: true,
        };
      }
      const dashboard = this.#one(
        this.#database.prepare("SELECT archived FROM dashboards WHERE id = ?"),
        dashboardId,
      );
      if (!dashboard || requiredNumber(dashboard, "archived") === 1) {
        throw new DynaCliStoreError("not_found", "Dyna dashboard was not found.");
      }
      let mapping = this.#one(
        this.#database.prepare(
          "SELECT publisher_id FROM dashboard_manual_publishers WHERE dashboard_id = ?",
        ),
        dashboardId,
      );
      if (!mapping) {
        this.#assertPublisherCapacity();
        const publisherId = randomUUID();
        this.#database
          .prepare(
            `INSERT INTO publishers (
              id, name, token_hash, schedule_state, stale_after_minutes, credential_mode,
              last_run_status, created_at
            ) VALUES (?, ?, ?, 'unknown', 43200, 'disabled', 'never', ?)`,
          )
          .run(publisherId, "Dyna to-dos", tokenHash(token()), instant);
        this.#database
          .prepare("INSERT INTO dashboard_publishers (dashboard_id, publisher_id) VALUES (?, ?)")
          .run(dashboardId, publisherId);
        this.#database
          .prepare(
            "INSERT INTO dashboard_manual_publishers (dashboard_id, publisher_id) VALUES (?, ?)",
          )
          .run(dashboardId, publisherId);
        mapping = { publisher_id: publisherId };
      }
      if (parsed.followUpOfItemId) {
        if (!this.#dashboardContainsItem(dashboardId, parsed.followUpOfItemId)) {
          throw new Error("The follow-up source is outside this dashboard view.");
        }
      }
      const publisherId = requiredString(mapping, "publisher_id");
      const todoId = randomUUID();
      const item = normalizedPublishedItem({
        externalId: todoId,
        sourceRef: { source: "manual", todoId },
        sourceScope: `manual:${dashboardId}`,
        title: parsed.title,
        summary: parsed.summary ?? "Added from Dyna and ready to prioritize.",
        priority: parsed.priority,
        priorityReason: "Manually added to your priority queue.",
        sourceUpdatedAt: instant,
        labels: parsed.labels,
        people: [],
        ...(parsed.attention ? { attention: parsed.attention } : {}),
        plan: [],
        nextSteps: [],
      });
      const itemId = randomUUID();
      const fingerprint = sha256(JSON.stringify(item));
      this.#database
        .prepare(
          `INSERT INTO items (
            id, publisher_id, external_id, identity_key, source, source_ref, source_scope, title,
            summary, priority, priority_reason, source_updated_at, source_updated_ms, due_at,
            labels, people, leadership_score, attention, plan, next_steps, follow_up_of_item_id,
            fingerprint, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          itemId,
          publisherId,
          item.externalId,
          identityKey(publisherId, item.sourceRef),
          item.sourceRef.source,
          JSON.stringify(item.sourceRef),
          item.sourceScope,
          item.title,
          item.summary,
          item.priority,
          item.priorityReason,
          item.sourceUpdatedAt,
          normalizeTimestamp(item.sourceUpdatedAt).epoch,
          JSON.stringify(item.labels),
          JSON.stringify(item.people),
          item.attention ?? null,
          JSON.stringify(item.plan),
          JSON.stringify(item.nextSteps),
          parsed.followUpOfItemId ?? null,
          fingerprint,
          instant,
        );
      if (parsed.followUpOfItemId) {
        this.#insertFollowUpReference(itemId, parsed.followUpOfItemId);
      }
      this.#database
        .prepare(
          `INSERT INTO publisher_items (
            publisher_id, external_id, item_id, active, last_seen_run_id
          ) VALUES (?, ?, ?, 1, ?)`,
        )
        .run(publisherId, item.externalId, itemId, `manual:${todoId}`);
      this.#database
        .prepare(
          "INSERT INTO todo_requests (dashboard_id, client_request_id, request_hash, item_id) VALUES (?, ?, ?, ?)",
        )
        .run(dashboardId, clientRequestId, requestHash, itemId);
      this.#touchDashboards([dashboardId], instant);
      this.#audit("todo.created", itemId, instant);
      return {
        itemId,
        itemNumber: requiredItemNumber(this.#itemBaseRow(itemId), "item_number"),
        fingerprint,
        deduplicated: false,
      };
    });
  }

  setItemStatus(
    input: DynaSetItemStatusInput,
    positioned: DynaCliPositionedItem | undefined,
  ): DynaItemStatusResult {
    const parsed = DynaSetItemStatusInputSchema.parse(input);
    const dashboardId = this.authorizeView(parsed.viewToken, parsed.itemId);
    return DynaItemStatusResultSchema.parse(
      this.#cliMutation(
        dashboardId,
        parsed.itemId,
        parsed.clientRequestId,
        "app.item.status",
        {
          targetStage: parsed.targetStage,
          outcome: parsed.outcome,
          expectedRevision: parsed.expectedRevision,
          expectedFingerprint: parsed.expectedFingerprint,
        },
        () => {
          const revision = this.#one(
            this.#database.prepare("SELECT revision FROM dashboards WHERE id = ?"),
            dashboardId,
          );
          if (!revision || requiredNumber(revision, "revision") !== parsed.expectedRevision) {
            throw new DynaCliStoreError(
              "stale_dashboard",
              "The Dyna dashboard changed; refresh before changing this item status.",
            );
          }
          const item = this.#itemBaseRow(parsed.itemId);
          if (requiredString(item, "fingerprint") !== parsed.expectedFingerprint) {
            throw new DynaCliStoreError(
              "stale_item",
              "The Dyna item changed; refresh before changing its status.",
            );
          }
          if (!positioned) {
            const archived = this.#one(
              this.#database.prepare(
                "SELECT 1 AS present FROM item_archive_events WHERE dashboard_id = ? AND item_id = ? AND restored_at IS NULL",
              ),
              dashboardId,
              parsed.itemId,
            );
            throw new DynaCliStoreError(
              archived ? "archived_item" : "not_found",
              archived
                ? "Archived Dyna items cannot change status; restore the item first."
                : "The Dyna item is no longer active in this dashboard.",
            );
          }
          const linkedTask = this.#one(
            this.#database.prepare(
              "SELECT 1 AS present FROM task_bindings WHERE item_id = ? LIMIT 1",
            ),
            parsed.itemId,
          );
          if (linkedTask && parsed.targetStage !== "done") {
            throw new DynaCliStoreError(
              "invalid_input",
              "To Do and Needs You follow the linked Codex task; use Start, Open, or Refresh instead.",
            );
          }
          if (parsed.targetStage === "done") {
            const creationInFlight = this.#one(
              this.#database.prepare(
                `SELECT 1 AS present FROM action_requests
                 WHERE item_id = ? AND kind = 'create_codex_task'
                   AND (state = 'claimed' OR
                     (state = 'needs_reconciliation' AND uncertain_effect = 1))
                 LIMIT 1`,
              ),
              parsed.itemId,
            );
            if (creationInFlight) {
              throw new DynaCliStoreError(
                "invalid_input",
                "Codex task creation may already be in progress; reconcile it before marking this item Done.",
              );
            }
          }

          const workflowState = positioned.workflowState;
          const currentStage =
            workflowState === "completed"
              ? "done"
              : workflowState === "attention" || workflowState === "paused"
                ? "needs_you"
                : "todo";
          if (workflowState === "completed" && parsed.targetStage !== "done") {
            throw new DynaCliStoreError(
              "completed_item",
              "Completed Dyna work cannot be reopened; create a follow-up item instead.",
            );
          }
          if (currentStage === parsed.targetStage) {
            if (
              parsed.targetStage === "done" &&
              parsed.outcome !== positioned.userWorkflowOutcome
            ) {
              throw new DynaCliStoreError(
                "completed_item",
                "A completed Dyna item's outcome is immutable; create a follow-up for continued work.",
              );
            }
            return {
              schema: "dyna/item-status-result-v1" as const,
              requestId: parsed.clientRequestId,
              itemId: parsed.itemId,
              deduplicated: false,
              targetStage: parsed.targetStage,
              changed: false,
            };
          }

          const instant = this.#now();
          const event = DynaUserWorkflowEventSchema.parse({
            id: randomUUID(),
            itemId: parsed.itemId,
            originDashboardId: dashboardId,
            targetStage: parsed.targetStage,
            ...(parsed.outcome ? { outcome: parsed.outcome } : {}),
            createdAt: instant,
          });
          this.#database
            .prepare(
              `INSERT INTO item_workflow_events (
                 id, item_id, origin_dashboard_id, target_stage, outcome, created_at, created_at_ms
               ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              event.id,
              event.itemId,
              event.originDashboardId,
              event.targetStage,
              event.outcome ?? null,
              event.createdAt,
              this.#nowMs(),
            );
          this.#touchDashboardsForItem(parsed.itemId, instant);
          this.#audit(`item.status.${event.targetStage}`, parsed.itemId, instant);
          return {
            schema: "dyna/item-status-result-v1" as const,
            requestId: parsed.clientRequestId,
            itemId: parsed.itemId,
            deduplicated: false,
            targetStage: parsed.targetStage,
            changed: true,
            changedAt: instant,
          };
        },
      ),
    );
  }

  setItemBacklog(
    input: DynaSetItemBacklogInput,
    positioned: DynaCliPositionedItem | undefined,
    backlog: DynaBacklogState,
  ): DynaItemBacklogResult {
    const parsed = DynaSetItemBacklogInputSchema.parse(input);
    const parsedBacklog = DynaBacklogStateSchema.parse(backlog);
    const dashboardId = this.authorizeView(parsed.viewToken, parsed.itemId);
    return DynaItemBacklogResultSchema.parse(
      this.#cliMutation(
        dashboardId,
        parsed.itemId,
        parsed.clientRequestId,
        "app.item.backlog",
        {
          action: parsed.action,
          expectedRevision: parsed.expectedRevision,
          expectedFingerprint: parsed.expectedFingerprint,
        },
        () => {
          const revision = this.#one(
            this.#database.prepare("SELECT revision FROM dashboards WHERE id = ?"),
            dashboardId,
          );
          if (!revision || requiredNumber(revision, "revision") !== parsed.expectedRevision) {
            throw new DynaCliStoreError(
              "stale_dashboard",
              "The Dyna dashboard changed; refresh before changing this item's backlog state.",
            );
          }
          const item = this.#itemBaseRow(parsed.itemId);
          if (requiredString(item, "fingerprint") !== parsed.expectedFingerprint) {
            throw new DynaCliStoreError(
              "stale_item",
              "The Dyna item changed; refresh before changing its backlog state.",
            );
          }
          if (!positioned) {
            const archived = this.#one(
              this.#database.prepare(
                "SELECT 1 AS present FROM item_archive_events WHERE dashboard_id = ? AND item_id = ? AND restored_at IS NULL",
              ),
              dashboardId,
              parsed.itemId,
            );
            throw new DynaCliStoreError(
              archived ? "archived_item" : "not_found",
              archived
                ? "Archived Dyna items cannot move to Backlog; restore the item first."
                : "The Dyna item is no longer active in this dashboard.",
            );
          }
          if (positioned.workflowState === "completed") {
            throw new DynaCliStoreError(
              "completed_item",
              "Completed Dyna work cannot move to Backlog.",
            );
          }

          const preference = this.#one(
            this.#database.prepare(
              `SELECT backlogged_at, backlog_until FROM item_preferences
               WHERE dashboard_id = ? AND item_id = ?`,
            ),
            dashboardId,
            parsed.itemId,
          );
          const storedBackloggedAt = preference
            ? optionalString(preference, "backlogged_at")
            : undefined;
          const storedUntil = preference ? optionalString(preference, "backlog_until") : undefined;
          const activeBacklog =
            storedBackloggedAt && storedUntil && Date.parse(storedUntil) > this.#nowMs()
              ? DynaBacklogStateSchema.parse({
                  backloggedAt: storedBackloggedAt,
                  until: storedUntil,
                })
              : undefined;

          if (parsed.action === "defer" && activeBacklog) {
            return {
              schema: "dyna/item-backlog-result-v1" as const,
              requestId: parsed.clientRequestId,
              itemId: parsed.itemId,
              deduplicated: false,
              action: parsed.action,
              changed: false,
              backlog: activeBacklog,
            };
          }
          if (parsed.action === "return" && !storedBackloggedAt && !storedUntil) {
            return {
              schema: "dyna/item-backlog-result-v1" as const,
              requestId: parsed.clientRequestId,
              itemId: parsed.itemId,
              deduplicated: false,
              action: parsed.action,
              changed: false,
            };
          }

          const instant = this.#now();
          if (parsed.action === "defer") {
            this.#database
              .prepare(
                `INSERT INTO item_preferences (
                   dashboard_id, item_id, priority_override, sequence,
                   backlogged_at, backlog_until, updated_at
                 ) VALUES (?, ?, NULL, NULL, ?, ?, ?)
                 ON CONFLICT(dashboard_id, item_id) DO UPDATE SET
                   backlogged_at = excluded.backlogged_at,
                   backlog_until = excluded.backlog_until,
                   updated_at = excluded.updated_at`,
              )
              .run(
                dashboardId,
                parsed.itemId,
                parsedBacklog.backloggedAt,
                parsedBacklog.until,
                instant,
              );
          } else {
            this.#database
              .prepare(
                `UPDATE item_preferences SET backlogged_at = NULL, backlog_until = NULL,
                   updated_at = ? WHERE dashboard_id = ? AND item_id = ?`,
              )
              .run(instant, dashboardId, parsed.itemId);
          }
          this.#touchDashboards([dashboardId], instant);
          this.#audit(
            parsed.action === "defer" ? "item.backlog.deferred" : "item.backlog.returned",
            parsed.itemId,
            instant,
          );
          return {
            schema: "dyna/item-backlog-result-v1" as const,
            requestId: parsed.clientRequestId,
            itemId: parsed.itemId,
            deduplicated: false,
            action: parsed.action,
            changed: true,
            ...(parsed.action === "defer" ? { backlog: parsedBacklog } : {}),
          };
        },
      ),
    );
  }

  organizeItem(
    viewToken: string,
    itemId: string,
    action: "bump" | "lower" | "earlier" | "later",
    expectedRevision: number,
    expectedFingerprint: string,
    positioned: readonly DynaCliPositionedItem[],
  ): { readonly changed: boolean } {
    const dashboardId = this.authorizeView(viewToken, itemId);
    const instant = this.#now();
    return this.#transaction(() => {
      const revisionRow = this.#one(
        this.#database.prepare("SELECT revision FROM dashboards WHERE id = ?"),
        dashboardId,
      );
      const itemRow = this.#itemBaseRow(itemId);
      if (
        !revisionRow ||
        requiredNumber(revisionRow, "revision") !== expectedRevision ||
        requiredString(itemRow, "fingerprint") !== expectedFingerprint
      ) {
        throw new Error("The Dyna dashboard changed; refresh before reprioritizing this item.");
      }
      const selected = positioned.find((candidate) => candidate.id === itemId);
      const group = selected
        ? positioned.filter(
            (candidate) =>
              candidate.effectivePriority === selected.effectivePriority &&
              (candidate.workflowState === "completed") ===
                (selected.workflowState === "completed"),
          )
        : [];
      const index = group.findIndex((candidate) => candidate.id === itemId);
      const target = group[index];
      if (!target) throw new Error("The Dyna item is no longer active.");
      const currentPriority = target.effectivePriority;
      if (action === "bump" || action === "lower") {
        const priorities = ["critical", "high", "normal", "low"] as const;
        const currentIndex = priorities.indexOf(currentPriority);
        const targetIndex = Math.max(
          0,
          Math.min(priorities.length - 1, currentIndex + (action === "bump" ? -1 : 1)),
        );
        const targetPriority = priorities[targetIndex] ?? currentPriority;
        if (targetPriority === currentPriority) return { changed: false };
        this.#database
          .prepare(
            `INSERT INTO item_preferences (
               dashboard_id, item_id, priority_override, sequence, updated_at
             ) VALUES (?, ?, ?, NULL, ?)
             ON CONFLICT(dashboard_id, item_id) DO UPDATE SET
               priority_override = excluded.priority_override,
               sequence = NULL, updated_at = excluded.updated_at`,
          )
          .run(dashboardId, itemId, targetPriority, instant);
        this.#database
          .prepare(
            `INSERT INTO item_preference_events (
               id, dashboard_id, item_id, action, priority, sequence, created_at
             ) VALUES (?, ?, ?, ?, ?, NULL, ?)`,
          )
          .run(randomUUID(), dashboardId, itemId, action, targetPriority, instant);
      } else {
        const otherIndex = action === "earlier" ? index - 1 : index + 1;
        if (index < 0 || otherIndex < 0 || otherIndex >= group.length) return { changed: false };
        const current = group[index];
        const other = group[otherIndex];
        if (!current || !other) return { changed: false };
        group[index] = other;
        group[otherIndex] = current;
        const updateSequence = this.#database.prepare(
          `INSERT INTO item_preferences (dashboard_id, item_id, sequence, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(dashboard_id, item_id) DO UPDATE SET sequence = excluded.sequence,
             updated_at = excluded.updated_at`,
        );
        group.forEach((candidate, position) => {
          const candidateId = candidate.id;
          const sequence = position * 100;
          updateSequence.run(dashboardId, candidateId, sequence, instant);
          this.#database
            .prepare(
              `INSERT INTO item_preference_events (
                 id, dashboard_id, item_id, action, priority, sequence, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              randomUUID(),
              dashboardId,
              candidateId,
              candidateId === itemId ? action : "resequence",
              currentPriority,
              sequence,
              instant,
            );
        });
      }
      this.#touchDashboards([dashboardId], instant);
      this.#audit(`item.organized.${action}`, itemId, instant);
      return { changed: true };
    });
  }

  groupItems(
    viewToken: string,
    items: readonly {
      readonly itemId: string;
      readonly expectedFingerprint: string;
    }[],
    targetPriority: DynaPriority,
    expectedRevision: number,
    positioned: readonly DynaCliPositionedItem[],
  ): { readonly changed: boolean; readonly changedCount: number } {
    if (items.length === 0 || items.length > 200) {
      throw new Error("Select between 1 and 200 Dyna items to change their priority group.");
    }
    const itemIds = items.map((item) => item.itemId);
    if (new Set(itemIds).size !== itemIds.length) {
      throw new Error("Each Dyna item can appear only once in a bulk priority change.");
    }
    const parsedTargetPriority = DynaPrioritySchema.parse(targetPriority);
    const instant = this.#now();
    return this.#transaction(() => {
      const dashboardId = this.authorizeView(viewToken);
      const revisionRow = this.#one(
        this.#database.prepare("SELECT revision FROM dashboards WHERE id = ?"),
        dashboardId,
      );
      if (!revisionRow || requiredNumber(revisionRow, "revision") !== expectedRevision) {
        throw new Error("The Dyna dashboard changed; refresh before moving these items.");
      }

      const selectedRows = positioned.filter(
        (candidate) => itemIds.includes(candidate.id) && candidate.workflowState !== "completed",
      );
      const selectedById = new Map(selectedRows.map((row) => [row.id, row] as const));
      for (const item of items) {
        const row = selectedById.get(item.itemId);
        if (!row) {
          throw new Error("Only active, unfinished queue items can change priority group.");
        }
        if (row.fingerprint !== item.expectedFingerprint) {
          throw new Error("A selected Dyna item changed; refresh before moving these items.");
        }
      }

      const targetGroup = positioned.filter(
        (candidate) =>
          candidate.workflowState !== "completed" &&
          candidate.effectivePriority === parsedTargetPriority,
      );
      const priorities = ["critical", "high", "normal", "low"] as const;
      const incoming = selectedRows
        .filter((row) => row.effectivePriority !== parsedTargetPriority)
        .sort((left, right) => {
          const priorityDifference =
            priorities.indexOf(left.effectivePriority) -
            priorities.indexOf(right.effectivePriority);
          return (
            priorityDifference ||
            left.priorityPosition - right.priorityPosition ||
            left.id.localeCompare(right.id)
          );
        });
      if (incoming.length === 0) return { changed: false, changedCount: 0 };

      const incomingIds = new Set(incoming.map((row) => row.id));
      const nextTargetGroup = [...targetGroup, ...incoming];
      const setMovedPreference = this.#database.prepare(
        `INSERT INTO item_preferences (
           dashboard_id, item_id, priority_override, sequence, updated_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(dashboard_id, item_id) DO UPDATE SET
           priority_override = excluded.priority_override,
           sequence = excluded.sequence,
           updated_at = excluded.updated_at`,
      );
      const setSequence = this.#database.prepare(
        `INSERT INTO item_preferences (dashboard_id, item_id, sequence, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(dashboard_id, item_id) DO UPDATE SET
           sequence = excluded.sequence, updated_at = excluded.updated_at`,
      );
      const addEvent = this.#database.prepare(
        `INSERT INTO item_preference_events (
           id, dashboard_id, item_id, action, priority, sequence, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const [position, row] of nextTargetGroup.entries()) {
        const candidateId = row.id;
        const sequence = position * 100;
        const isIncoming = incomingIds.has(candidateId);
        if (isIncoming) {
          setMovedPreference.run(dashboardId, candidateId, parsedTargetPriority, sequence, instant);
        } else {
          setSequence.run(dashboardId, candidateId, sequence, instant);
        }
        const currentPriority = row.effectivePriority;
        const action = isIncoming
          ? priorities.indexOf(parsedTargetPriority) < priorities.indexOf(currentPriority)
            ? "bump"
            : "lower"
          : "resequence";
        addEvent.run(
          randomUUID(),
          dashboardId,
          candidateId,
          action,
          parsedTargetPriority,
          sequence,
          instant,
        );
      }
      this.#touchDashboards([dashboardId], instant);
      for (const row of incoming) {
        this.#audit("item.organized.group", row.id, instant);
      }
      return { changed: true, changedCount: incoming.length };
    });
  }

  placeItem(
    viewToken: string,
    itemId: string,
    targetPriority: DynaPriority,
    beforeItemId: string | undefined,
    expectedRevision: number,
    expectedFingerprint: string,
    positioned: readonly DynaCliPositionedItem[],
  ): { readonly changed: boolean } {
    const dashboardId = this.authorizeView(viewToken, itemId);
    const instant = this.#now();
    return this.#transaction(() => {
      const revisionRow = this.#one(
        this.#database.prepare("SELECT revision FROM dashboards WHERE id = ?"),
        dashboardId,
      );
      const itemRow = this.#itemBaseRow(itemId);
      if (
        !revisionRow ||
        requiredNumber(revisionRow, "revision") !== expectedRevision ||
        requiredString(itemRow, "fingerprint") !== expectedFingerprint
      ) {
        throw new Error("The Dyna dashboard changed; refresh before moving this item.");
      }
      const source = positioned.find((candidate) => candidate.id === itemId);
      if (!source || source.workflowState === "completed") {
        throw new Error("Only active queue items can be moved.");
      }
      const currentPriority = source.effectivePriority;
      if (beforeItemId === itemId) return { changed: false };
      const currentGroup = positioned.filter(
        (candidate) =>
          candidate.workflowState !== "completed" &&
          candidate.effectivePriority === currentPriority,
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
        throw new Error("The queue drop target changed; refresh before moving this item.");
      }
      targetGroup.splice(insertAt, 0, source);
      const currentIds = currentGroup.map((candidate) => candidate.id);
      const nextIds = targetGroup.map((candidate) => candidate.id);
      if (currentPriority === targetPriority && currentIds.join("\n") === nextIds.join("\n")) {
        return { changed: false };
      }

      const setSourcePreference = this.#database.prepare(
        `INSERT INTO item_preferences (
           dashboard_id, item_id, priority_override, sequence, updated_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(dashboard_id, item_id) DO UPDATE SET
           priority_override = excluded.priority_override,
           sequence = excluded.sequence,
           updated_at = excluded.updated_at`,
      );
      const setSequence = this.#database.prepare(
        `INSERT INTO item_preferences (dashboard_id, item_id, sequence, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(dashboard_id, item_id) DO UPDATE SET
           sequence = excluded.sequence, updated_at = excluded.updated_at`,
      );
      const addEvent = this.#database.prepare(
        `INSERT INTO item_preference_events (
           id, dashboard_id, item_id, action, priority, sequence, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const priorities = ["critical", "high", "normal", "low"] as const;
      const originalPosition = currentIds.indexOf(itemId);
      const nextPosition = nextIds.indexOf(itemId);
      const sourceAction =
        currentPriority !== targetPriority
          ? priorities.indexOf(targetPriority) < priorities.indexOf(currentPriority)
            ? "bump"
            : "lower"
          : nextPosition < originalPosition
            ? "earlier"
            : "later";
      targetGroup.forEach((candidate, position) => {
        const candidateId = candidate.id;
        const sequence = position * 100;
        if (candidateId === itemId) {
          setSourcePreference.run(dashboardId, candidateId, targetPriority, sequence, instant);
        } else {
          setSequence.run(dashboardId, candidateId, sequence, instant);
        }
        addEvent.run(
          randomUUID(),
          dashboardId,
          candidateId,
          candidateId === itemId ? sourceAction : "resequence",
          targetPriority,
          sequence,
          instant,
        );
      });
      this.#touchDashboards([dashboardId], instant);
      this.#audit(`item.organized.${sourceAction}`, itemId, instant);
      return { changed: true };
    });
  }

  archiveItem(
    viewToken: string,
    itemId: string,
    values: {
      readonly reason: DynaArchiveReason;
      readonly reasonDetail?: string;
      readonly expectedRevision: number;
      readonly expectedFingerprint: string;
      readonly clientRequestId: string;
    },
    positioned: DynaCliPositionedItem | undefined,
  ): DynaArchiveResult {
    const dashboardId = this.authorizeView(viewToken, itemId);
    const reason = DynaArchiveReasonSchema.parse(values.reason);
    const reasonDetail = values.reasonDetail?.trim();
    if (reason === "other" && !reasonDetail) {
      throw new Error("Other archive reasons require a short explanation.");
    }
    if (reason !== "other" && reasonDetail) {
      throw new Error("Archive reason details are only accepted for Other.");
    }
    if (reasonDetail && reasonDetail.length > 500) {
      throw new Error("Archive reason details cannot exceed 500 characters.");
    }
    const requestHash = sha256(
      JSON.stringify([
        "dyna/archive-v1",
        itemId,
        reason,
        reasonDetail ?? null,
        values.expectedRevision,
        values.expectedFingerprint,
      ]),
    );
    return this.#transaction(() => {
      const retry = this.#one(
        this.#database.prepare(
          "SELECT * FROM item_archive_events WHERE dashboard_id = ? AND client_request_id = ?",
        ),
        dashboardId,
        values.clientRequestId,
      );
      if (retry) {
        if (requiredString(retry, "request_hash") !== requestHash) {
          throw new Error("The archive request ID was already used for different input.");
        }
        return this.#archiveResultFromRow(retry);
      }
      const revision = this.#one(
        this.#database.prepare("SELECT revision FROM dashboards WHERE id = ?"),
        dashboardId,
      );
      if (!revision || requiredNumber(revision, "revision") !== values.expectedRevision) {
        throw new Error("The Dyna dashboard changed; refresh before archiving this item.");
      }
      if (positioned?.fingerprint !== values.expectedFingerprint) {
        throw new Error("The Dyna item changed or is no longer active; refresh before archiving.");
      }
      const workflowState = positioned.workflowState;
      if (reason === "completed" && workflowState !== "completed") {
        throw new Error("Only completed work can use the Completed archive disposition.");
      }
      const result = this.#insertArchiveEvent(
        dashboardId,
        positioned,
        reason,
        reasonDetail,
        "manual",
        values.clientRequestId,
        requestHash,
      );
      const instant = result.archivedAt;
      this.#touchDashboards([dashboardId], instant);
      this.#audit(`item.archived.${reason}.manual`, itemId, instant);
      return result;
    });
  }

  restoreItem(
    viewToken: string,
    itemId: string,
    values: {
      readonly expectedRevision: number;
      readonly expectedFingerprint: string;
      readonly clientRequestId: string;
    },
  ): { readonly itemId: string; readonly restoredAt: string } {
    const dashboardId = this.authorizeView(viewToken, itemId);
    const requestHash = sha256(
      JSON.stringify([
        "dyna/restore-v1",
        itemId,
        values.expectedRevision,
        values.expectedFingerprint,
      ]),
    );
    return this.#transaction(() => {
      const retry = this.#one(
        this.#database.prepare(
          "SELECT * FROM item_archive_events WHERE dashboard_id = ? AND restore_request_id = ?",
        ),
        dashboardId,
        values.clientRequestId,
      );
      if (retry) {
        if (requiredString(retry, "restore_request_hash") !== requestHash) {
          throw new Error("The restore request ID was already used for different input.");
        }
        return {
          itemId,
          restoredAt: requiredString(retry, "restored_at"),
        };
      }
      const revision = this.#one(
        this.#database.prepare("SELECT revision FROM dashboards WHERE id = ?"),
        dashboardId,
      );
      const item = this.#itemBaseRow(itemId);
      if (
        !revision ||
        requiredNumber(revision, "revision") !== values.expectedRevision ||
        requiredString(item, "fingerprint") !== values.expectedFingerprint
      ) {
        throw new Error("The Dyna dashboard changed; refresh before restoring this item.");
      }
      const archive = this.#one(
        this.#database.prepare(
          "SELECT * FROM item_archive_events WHERE dashboard_id = ? AND item_id = ? AND restored_at IS NULL",
        ),
        dashboardId,
        itemId,
      );
      if (!archive) throw new Error("The Dyna item is not currently archived.");
      const instant = this.#now();
      this.#database
        .prepare(
          `UPDATE item_archive_events
           SET restored_at = ?, restored_at_ms = ?, restore_request_id = ?, restore_request_hash = ?
           WHERE id = ? AND restored_at IS NULL`,
        )
        .run(
          instant,
          this.#nowMs(),
          values.clientRequestId,
          requestHash,
          requiredString(archive, "id"),
        );
      this.#touchDashboards([dashboardId], instant);
      this.#audit("item.restored", itemId, instant);
      return { itemId, restoredAt: instant };
    });
  }

  itemHistory(
    dashboardId: string,
    itemId: string,
    options: DynaItemHistoryOptions = {},
  ): DynaItemHistory {
    this.assertDashboardContainsItem(dashboardId, itemId);
    const item = this.#itemBaseRow(itemId);
    const limit = pageSize(options.limit, MAX_HISTORY_PAGE_SIZE);
    const archiveCursor = parseHistoryCursor(options.archiveCursor, "archive");
    const orderCursor = parseHistoryCursor(options.orderCursor, "order");
    const statusCursor = parseHistoryCursor(options.statusCursor, "status");
    const annotationCursor = parseHistoryCursor(options.annotationCursor, "annotation");
    const workCursor = parseHistoryCursor(options.workCursor, "work");
    const archiveRows = this.#database
      .prepare(
        `SELECT history.*, history.rowid AS insertion_sequence, i.fingerprint
         FROM item_archive_events history
         JOIN items i ON i.id = history.item_id
         WHERE history.dashboard_id = ? AND history.item_id = ?
         ${
           archiveCursor
             ? `AND (history.archived_at_ms < ? OR (
                  history.archived_at_ms = ? AND history.rowid < ?
                ))`
             : ""
         }
         ORDER BY history.archived_at_ms DESC, history.rowid DESC LIMIT ?`,
      )
      .all(
        dashboardId,
        itemId,
        ...(archiveCursor
          ? [archiveCursor.createdAtMs, archiveCursor.createdAtMs, archiveCursor.insertionSequence]
          : []),
        limit + 1,
      ) as SqlRow[];
    const archivePage = archiveRows.slice(0, limit);
    const archives = archivePage.map((row) => ({
      ...this.#archiveStateFromRow(row),
      ...(optionalString(row, "restored_at")
        ? { restoredAt: optionalString(row, "restored_at") }
        : {}),
      priorityAtArchive: DynaPrioritySchema.parse(requiredString(row, "priority_at_archive")),
      ...(typeof row["sequence_at_archive"] === "number"
        ? { sequenceAtArchive: requiredNumber(row, "sequence_at_archive") }
        : {}),
      ...(optionalString(row, "outcome_at_archive")
        ? { outcomeAtArchive: optionalString(row, "outcome_at_archive") }
        : {}),
    }));
    const orderCursorTimestamp = orderCursor
      ? new Date(orderCursor.createdAtMs).toISOString()
      : undefined;
    const organizationRows = this.#database
      .prepare(
        `SELECT action, priority, sequence, created_at, rowid AS insertion_sequence
         FROM item_preference_events
         WHERE dashboard_id = ? AND item_id = ?
         ${
           orderCursor && orderCursorTimestamp
             ? `AND (created_at < ? OR (created_at = ? AND rowid < ?))`
             : ""
         }
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(
        dashboardId,
        itemId,
        ...(orderCursor && orderCursorTimestamp
          ? [orderCursorTimestamp, orderCursorTimestamp, orderCursor.insertionSequence]
          : []),
        limit + 1,
      ) as SqlRow[];
    const organizationPage = organizationRows.slice(0, limit);
    const organization = organizationPage.map((row) => ({
      action: requiredString(row, "action") as
        "bump" | "lower" | "earlier" | "later" | "resequence",
      priority: DynaPrioritySchema.parse(requiredString(row, "priority")),
      ...(typeof row["sequence"] === "number" ? { sequence: requiredNumber(row, "sequence") } : {}),
      createdAt: requiredString(row, "created_at"),
    }));
    const statusRows = this.#database
      .prepare(
        `SELECT *, rowid AS insertion_sequence FROM item_workflow_events
         WHERE item_id = ?
         ${
           statusCursor
             ? `AND (created_at_ms < ? OR (
                  created_at_ms = ? AND rowid < ?
                ))`
             : ""
         }
         ORDER BY created_at_ms DESC, rowid DESC LIMIT ?`,
      )
      .all(
        itemId,
        ...(statusCursor
          ? [statusCursor.createdAtMs, statusCursor.createdAtMs, statusCursor.insertionSequence]
          : []),
        limit + 1,
      ) as SqlRow[];
    const statusPage = statusRows.slice(0, limit);
    const annotationRows = this.#database
      .prepare(
        `SELECT *, rowid AS insertion_sequence FROM annotation_events
         WHERE item_id = ?
         ${
           annotationCursor
             ? `AND (occurred_at_ms < ? OR (
                  occurred_at_ms = ? AND rowid < ?
                ))`
             : ""
         }
         ORDER BY occurred_at_ms DESC, rowid DESC LIMIT ?`,
      )
      .all(
        itemId,
        ...(annotationCursor
          ? [
              annotationCursor.createdAtMs,
              annotationCursor.createdAtMs,
              annotationCursor.insertionSequence,
            ]
          : []),
        limit + 1,
      ) as SqlRow[];
    const annotationPage = annotationRows.slice(0, limit);
    const workPage = this.#workUpdatePage(itemId, limit, workCursor);
    const lastArchive = archivePage.at(-1);
    const lastOrganization = organizationPage.at(-1);
    const lastStatus = statusPage.at(-1);
    const lastAnnotation = annotationPage.at(-1);
    const followUpOfItemId = followUpReferenceItemId(item);
    return DynaItemHistorySchema.parse({
      itemId,
      itemNumber: requiredItemNumber(item, "item_number"),
      ...(followUpOfItemId ? { followUpOfItemId } : {}),
      ...(typeof item["follow_up_of_item_number"] === "number"
        ? { followUpOfItemNumber: requiredItemNumber(item, "follow_up_of_item_number") }
        : {}),
      archives,
      organization,
      statusChanges: statusPage.map((row) => this.#userWorkflowEventFromRow(row)),
      annotationEvents: annotationPage.map((row) => {
        const taskId = optionalString(row, "task_id");
        const hostId = optionalString(row, "host_id");
        const taskTitle = optionalString(row, "task_title");
        const workAttemptId = optionalString(row, "work_attempt_id");
        return {
          id: requiredString(row, "id"),
          annotationId: requiredString(row, "annotation_id"),
          itemId: requiredString(row, "item_id"),
          operation: requiredString(row, "operation"),
          version: requiredNumber(row, "result_version"),
          occurredAt: requiredString(row, "occurred_at"),
          ...(taskId && hostId
            ? { task: { taskId, hostId, ...(taskTitle ? { title: taskTitle } : {}) } }
            : {}),
          ...(workAttemptId ? { workAttemptId } : {}),
        };
      }),
      workUpdates: workPage.updates,
      ...(archiveRows.length > limit && lastArchive
        ? {
            archiveEventsNextCursor: historyCursor(
              "archive",
              requiredNumber(lastArchive, "archived_at_ms"),
              requiredNumber(lastArchive, "insertion_sequence"),
            ),
          }
        : {}),
      ...(organizationRows.length > limit && lastOrganization
        ? {
            orderHistoryNextCursor: historyCursor(
              "order",
              normalizeTimestamp(requiredString(lastOrganization, "created_at")).epoch,
              requiredNumber(lastOrganization, "insertion_sequence"),
            ),
          }
        : {}),
      ...(statusRows.length > limit && lastStatus
        ? {
            statusHistoryNextCursor: historyCursor(
              "status",
              requiredNumber(lastStatus, "created_at_ms"),
              requiredNumber(lastStatus, "insertion_sequence"),
            ),
          }
        : {}),
      ...(annotationRows.length > limit && lastAnnotation
        ? {
            annotationEventsNextCursor: historyCursor(
              "annotation",
              requiredNumber(lastAnnotation, "occurred_at_ms"),
              requiredNumber(lastAnnotation, "insertion_sequence"),
            ),
          }
        : {}),
      ...(workPage.nextCursor ? { workUpdatesNextCursor: workPage.nextCursor } : {}),
    });
  }

  itemActivityPage(
    dashboardId: string,
    itemId: string,
    options: DynaItemActivityOptions = {},
  ): DynaWorkActivityPage {
    this.assertDashboardContainsItem(dashboardId, itemId);
    const item = this.#itemBaseRow(itemId);
    const limit = pageSize(options.limit, MAX_ACTIVITY_PAGE_SIZE);
    const cursor = parseHistoryCursor(options.cursor, "work");
    const page = this.#workUpdatePage(itemId, limit, cursor);
    const count = this.#one(
      this.#database.prepare("SELECT COUNT(*) AS total FROM work_updates WHERE item_id = ?"),
      itemId,
    );
    if (!count) throw new Error("Dyna could not count item activity.");
    return DynaWorkActivityPageSchema.parse({
      itemId,
      itemNumber: requiredItemNumber(item, "item_number"),
      updates: page.updates,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      total: requiredNumber(count, "total"),
    });
  }

  applyEnrichment(
    itemId: string,
    values: {
      readonly summary?: string;
      readonly priority?: string;
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
    },
  ): void {
    const dueAt = values.dueAt ? normalizeTimestamp(values.dueAt).iso : undefined;
    const dueAtSet = values.dueAt !== undefined ? 1 : 0;
    const priority =
      values.priority === undefined ? undefined : DynaPrioritySchema.parse(values.priority);
    const instant = this.#now();
    this.#transaction(() => {
      const base = this.#itemBaseRow(itemId);
      if (requiredString(base, "fingerprint") !== values.expectedFingerprint) {
        throw new Error("The Dyna item changed; retrieve its latest context before enrichment.");
      }
      if (priority === "critical" && requiredString(base, "priority") !== "critical") {
        throw new Error(
          "Dyna enrichment cannot set critical unless the source priority is already critical.",
        );
      }
      const existing = this.#one(
        this.#database.prepare("SELECT version FROM item_enrichments WHERE item_id = ?"),
        itemId,
      );
      const currentVersion = existing ? requiredNumber(existing, "version") : 0;
      if (currentVersion !== values.expectedEnrichmentVersion) {
        throw new Error(
          "The Dyna enrichment changed; retrieve its latest context before replacing it.",
        );
      }
      this.#database
        .prepare(
          `
          INSERT INTO item_enrichments (
            item_id, summary, priority, priority_reason, due_at, due_at_set, labels, people,
            leadership_score,
            attention, plan, next_steps,
            base_fingerprint, base_source_updated_at, applied_at, provenance, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
          ON CONFLICT(item_id) DO UPDATE SET summary = excluded.summary,
            priority = excluded.priority, priority_reason = excluded.priority_reason,
            due_at = excluded.due_at, due_at_set = excluded.due_at_set, labels = excluded.labels,
            people = excluded.people, leadership_score = excluded.leadership_score,
            attention = excluded.attention, plan = excluded.plan,
            next_steps = excluded.next_steps,
            base_fingerprint = excluded.base_fingerprint,
            base_source_updated_at = excluded.base_source_updated_at,
            applied_at = excluded.applied_at, provenance = excluded.provenance,
            version = item_enrichments.version + 1
        `,
        )
        .run(
          itemId,
          values.summary ?? null,
          priority ?? null,
          values.priorityReason ?? null,
          dueAt ?? null,
          dueAtSet,
          values.labels !== undefined ? JSON.stringify(values.labels) : null,
          values.people !== undefined ? JSON.stringify(values.people) : null,
          dynaLeadershipScore(values.people ?? []),
          values.attention ?? null,
          values.plan !== undefined ? JSON.stringify(values.plan) : null,
          values.nextSteps !== undefined ? JSON.stringify(values.nextSteps) : null,
          requiredString(base, "fingerprint"),
          requiredString(base, "source_updated_at"),
          instant,
          values.provenance,
        );
      this.#touchDashboardsForItem(itemId, instant);
      this.#audit("item.enriched", itemId, instant);
    });
  }

  #insertArchiveEvent(
    dashboardId: string,
    positioned: DynaCliPositionedItem,
    reason: DynaArchiveReason,
    reasonDetail: string | undefined,
    mode: "manual" | "automatic",
    clientRequestId?: string,
    requestHash?: string,
  ): DynaArchiveResult {
    const itemId = positioned.id;
    const workflowState = positioned.workflowState;
    const completion = this.#completionEvidence(itemId);
    const manuallyCompleted = positioned.userWorkflowStage === "done";
    const completedAtMs =
      workflowState === "completed"
        ? manuallyCompleted
          ? positioned.userWorkflowCreatedMs
          : completion.completedAtMs
        : undefined;
    const archiveId = randomUUID();
    const archivedAt = this.#now();
    this.#database
      .prepare(
        `INSERT INTO item_archive_events (
           id, dashboard_id, item_id, reason, reason_detail, mode,
           archived_at, archived_at_ms, fingerprint_at_archive, workflow_state,
           completed_at, completed_at_ms, outcome_at_archive,
           priority_at_archive, sequence_at_archive, client_request_id, request_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        archiveId,
        dashboardId,
        itemId,
        reason,
        reasonDetail ?? null,
        mode,
        archivedAt,
        this.#nowMs(),
        positioned.fingerprint,
        workflowState,
        completedAtMs === undefined ? null : new Date(completedAtMs).toISOString(),
        completedAtMs ?? null,
        (manuallyCompleted ? positioned.userWorkflowOutcome : completion.outcome) ?? null,
        positioned.effectivePriority,
        positioned.preferenceSequence ?? null,
        clientRequestId ?? null,
        requestHash ?? null,
      );
    return { archiveId, itemId, archivedAt, reason, mode };
  }

  #archiveResultFromRow(row: SqlRow): DynaArchiveResult {
    return {
      archiveId: requiredString(row, "id"),
      itemId: requiredString(row, "item_id"),
      archivedAt: requiredString(row, "archived_at"),
      reason: DynaArchiveReasonSchema.parse(requiredString(row, "reason")),
      mode: requiredString(row, "mode") as "manual" | "automatic",
    };
  }

  #archiveStateFromRow(row: SqlRow, prefix = ""): z.infer<typeof DynaArchiveStateSchema> {
    const key = (name: string) => `${prefix}${name}`;
    const workflowState = requiredString(row, key("workflow_state")) as
      "todo" | "executing" | "paused" | "attention" | "completed";
    return DynaArchiveStateSchema.parse({
      id: requiredString(row, key("id")),
      reason: requiredString(row, key("reason")),
      ...(optionalString(row, key("reason_detail"))
        ? { reasonDetail: optionalString(row, key("reason_detail")) }
        : {}),
      mode: requiredString(row, key("mode")),
      archivedAt: requiredString(row, key("archived_at")),
      ...(optionalString(row, key("completed_at"))
        ? { completedAt: optionalString(row, key("completed_at")) }
        : {}),
      workflowStateAtArchive: workflowState,
      wasCompleted: workflowState === "completed",
      changedSinceArchive:
        requiredString(row, "fingerprint") !==
        requiredString(row, prefix ? "archive_fingerprint" : "fingerprint_at_archive"),
    });
  }

  #dashboardContainsItem(dashboardId: string, itemId: string): boolean {
    return Boolean(
      this.#one(
        this.#database.prepare(
          `SELECT 1 AS present FROM publisher_items pi
           JOIN dashboard_publishers dp ON dp.publisher_id = pi.publisher_id
           WHERE dp.dashboard_id = ? AND pi.item_id = ? AND (
             pi.active = 1 OR EXISTS (
               SELECT 1 FROM item_archive_events history
               WHERE history.dashboard_id = dp.dashboard_id AND history.item_id = pi.item_id
             )
           )`,
        ),
        dashboardId,
        itemId,
      ),
    );
  }

  assertDashboardContainsItem(dashboardId: string, itemId: string): void {
    this.getDashboard(dashboardId);
    if (!this.#dashboardContainsItem(dashboardId, itemId)) {
      throw new DynaCliStoreError(
        "outside_dashboard",
        "The Dyna item is outside the requested dashboard.",
      );
    }
  }

  createView(dashboardId: string): string {
    this.getDashboard(dashboardId);
    const value = token();
    this.#database.prepare("DELETE FROM view_sessions WHERE expires_at <= ?").run(this.#now());
    this.#database
      .prepare("INSERT INTO view_sessions (token_hash, dashboard_id, expires_at) VALUES (?, ?, ?)")
      .run(tokenHash(value), dashboardId, new Date(this.#nowMs() + VIEW_TTL_MS).toISOString());
    return value;
  }

  authorizeView(viewToken: string, itemId?: string): string {
    const hash = tokenHash(viewToken);
    const row = this.#one(
      this.#database.prepare(
        "SELECT dashboard_id, expires_at FROM view_sessions WHERE token_hash = ?",
      ),
      hash,
    );
    const instant = this.#now();
    if (!row || requiredString(row, "expires_at") <= instant) {
      throw new Error("The Dyna view session has expired; reopen the dashboard.");
    }
    const dashboardId = requiredString(row, "dashboard_id");
    if (itemId) {
      if (!this.#dashboardContainsItem(dashboardId, itemId)) {
        throw new Error("The Dyna item is outside this dashboard view.");
      }
    }
    this.#database
      .prepare("UPDATE view_sessions SET expires_at = ? WHERE token_hash = ?")
      .run(new Date(this.#nowMs() + VIEW_TTL_MS).toISOString(), hash);
    return dashboardId;
  }

  #listProjectionItems(
    dashboardId: string,
    scope: DynaSnapshotScope = "active",
  ): readonly DynaRepositoryProjectionItem[] {
    const cte = dynaProjectionMembershipCte(scope);
    const rows = this.#database
      .prepare(`${cte} SELECT * FROM projection_items ORDER BY id`)
      .all(dashboardId) as SqlRow[];
    if (rows.length === 0) return [];

    const taskRows = this.#database
      .prepare(
        `${cte}
         SELECT task.* FROM task_bindings task
         JOIN projection_items item ON item.id = task.item_id
         ORDER BY task.item_id, task.observed_ms DESC, task.task_id, task.host_id`,
      )
      .all(dashboardId) as SqlRow[];
    const updateRows = this.#database
      .prepare(
        `${cte}, latest_projection_updates AS (
           SELECT update_row.*, update_row.rowid AS insertion_sequence,
             ROW_NUMBER() OVER (
               PARTITION BY update_row.item_id, update_row.task_id,
                 update_row.host_id, update_row.kind
               ORDER BY update_row.created_at_ms DESC, update_row.rowid DESC
             ) AS update_rank
           FROM work_updates update_row
           JOIN projection_items item ON item.id = update_row.item_id
           WHERE update_row.task_id IS NOT NULL AND update_row.host_id IS NOT NULL
         )
         SELECT * FROM latest_projection_updates WHERE update_rank = 1
         ORDER BY item_id, created_at_ms DESC, insertion_sequence DESC`,
      )
      .all(dashboardId) as SqlRow[];

    const tasks = new Map<string, DynaRepositoryProjectionTask[]>();
    for (const row of taskRows) {
      const itemId = requiredString(row, "item_id");
      const task = this.#taskFromRow(row);
      const values = tasks.get(itemId) ?? [];
      values.push({
        taskId: task.taskId,
        hostId: task.hostId,
        state: task.state,
        observedAtMs: requiredNumber(row, "observed_ms"),
        statusUpdatedAtMs: requiredNumber(row, "status_updated_ms"),
        statusUpdatedAt: task.statusUpdatedAt,
        ...(task.outcome ? { outcome: task.outcome } : {}),
      });
      tasks.set(itemId, values);
    }
    const workUpdates = new Map<string, DynaRepositoryProjectionWorkUpdate[]>();
    for (const row of updateRows) {
      const itemId = requiredString(row, "item_id");
      const update = this.#workUpdateFromRow(row);
      if (!update.task) continue;
      const values = workUpdates.get(itemId) ?? [];
      values.push({
        taskId: update.task.taskId,
        hostId: update.task.hostId,
        kind: update.kind,
        body: update.body,
        createdAtMs: requiredNumber(row, "created_at_ms"),
        insertionSequence: requiredNumber(row, "insertion_sequence"),
      });
      workUpdates.set(itemId, values);
    }

    return rows.map((row) => {
      const id = requiredString(row, "id");
      const enrichmentBaseFingerprint = optionalString(row, "enrichment_base_fingerprint");
      const enrichment: DynaRepositoryProjectionEnrichment | undefined = enrichmentBaseFingerprint
        ? {
            ...(optionalString(row, "enrichment_summary")
              ? { summary: optionalString(row, "enrichment_summary") }
              : {}),
            ...(optionalString(row, "enrichment_priority")
              ? {
                  priority: DynaPrioritySchema.parse(optionalString(row, "enrichment_priority")),
                }
              : {}),
            ...(optionalString(row, "enrichment_priority_reason")
              ? { priorityReason: optionalString(row, "enrichment_priority_reason") }
              : {}),
            ...(optionalString(row, "enrichment_due_at")
              ? { dueAt: optionalString(row, "enrichment_due_at") }
              : {}),
            dueAtSet: requiredNumber(row, "enrichment_due_at_set") === 1,
            ...(optionalString(row, "enrichment_labels")
              ? {
                  labels: DynaPublishedItemSchema.shape.labels.parse(
                    parseJson(requiredString(row, "enrichment_labels")),
                  ),
                }
              : {}),
            ...(optionalString(row, "enrichment_people")
              ? {
                  people: DynaMaterializedItemSchema.shape.people.parse(
                    parseJson(requiredString(row, "enrichment_people")),
                  ),
                }
              : {}),
            leadershipScore: requiredNumber(row, "enrichment_leadership_score"),
            ...(optionalString(row, "enrichment_attention")
              ? { attention: optionalString(row, "enrichment_attention") }
              : {}),
            ...(optionalString(row, "enrichment_plan")
              ? {
                  plan: DynaPublishedItemSchema.shape.plan.parse(
                    parseJson(requiredString(row, "enrichment_plan")),
                  ),
                }
              : {}),
            ...(optionalString(row, "enrichment_next_steps")
              ? {
                  nextSteps: DynaPublishedItemSchema.shape.nextSteps.parse(
                    parseJson(requiredString(row, "enrichment_next_steps")),
                  ),
                }
              : {}),
            baseFingerprint: enrichmentBaseFingerprint,
            baseSourceUpdatedAt: requiredString(row, "enrichment_base_source_updated_at"),
            appliedAt: requiredString(row, "enrichment_applied_at"),
            provenance: requiredString(row, "enrichment_provenance"),
            version: requiredNumber(row, "enrichment_version"),
          }
        : undefined;
      const userWorkflowStage = optionalString(row, "user_workflow_stage");
      const userWorkflowTaskId = optionalString(row, "user_workflow_task_id");
      const userWorkflowHostId = optionalString(row, "user_workflow_host_id");
      const userWorkflowTaskTitle = optionalString(row, "user_workflow_task_title");
      const userWorkflowWorkAttemptId = optionalString(row, "user_workflow_work_attempt_id");
      const preferencePriority = optionalString(row, "preference_priority");
      const backloggedAt = optionalString(row, "preference_backlogged_at");
      const backlogUntil = optionalString(row, "preference_backlog_until");
      const backlog =
        backloggedAt && backlogUntil && Date.parse(backlogUntil) > this.#nowMs()
          ? DynaBacklogStateSchema.parse({ backloggedAt, until: backlogUntil })
          : undefined;
      const followUpOfItemId = followUpReferenceItemId(row);
      return {
        id,
        itemNumber: requiredItemNumber(row, "item_number"),
        identityKey: requiredString(row, "identity_key"),
        fingerprint: requiredString(row, "fingerprint"),
        base: this.#baseItem(row),
        sourceLeadershipScore: requiredNumber(row, "leadership_score"),
        sourceUpdatedAtMs: requiredNumber(row, "source_updated_ms"),
        updatedAt: requiredString(row, "updated_at"),
        ...(followUpOfItemId ? { followUpOfItemId } : {}),
        ...(typeof row["follow_up_of_item_number"] === "number"
          ? { followUpOfItemNumber: requiredItemNumber(row, "follow_up_of_item_number") }
          : {}),
        ...(enrichment ? { enrichment } : {}),
        ...(preferencePriority
          ? { preferencePriority: DynaPrioritySchema.parse(preferencePriority) }
          : {}),
        ...(typeof row["preference_sequence"] === "number"
          ? { preferenceSequence: requiredNumber(row, "preference_sequence") }
          : {}),
        ...(backlog ? { backlog } : {}),
        ...(userWorkflowStage
          ? {
              userWorkflow: {
                stage: DynaUserWorkflowStageSchema.parse(userWorkflowStage),
                ...(optionalString(row, "user_workflow_outcome")
                  ? { outcome: optionalString(row, "user_workflow_outcome") }
                  : {}),
                ...(userWorkflowTaskId && userWorkflowHostId
                  ? {
                      task: {
                        taskId: userWorkflowTaskId,
                        hostId: userWorkflowHostId,
                        ...(userWorkflowTaskTitle ? { title: userWorkflowTaskTitle } : {}),
                      },
                    }
                  : {}),
                ...(userWorkflowWorkAttemptId ? { workAttemptId: userWorkflowWorkAttemptId } : {}),
                createdAt: requiredString(row, "user_workflow_created_at"),
                createdAtMs: requiredNumber(row, "user_workflow_created_ms"),
              },
            }
          : {}),
        ...(optionalString(row, "archive_id")
          ? { archive: this.#archiveStateFromRow(row, "archive_") }
          : {}),
        ...(typeof row["last_restored_at_ms"] === "number"
          ? { lastRestoredAtMs: requiredNumber(row, "last_restored_at_ms") }
          : {}),
        tasks: tasks.get(id) ?? [],
        workUpdates: workUpdates.get(id) ?? [],
      };
    });
  }

  #matchingProjectionItemIds(
    dashboardId: string,
    scope: DynaSnapshotScope,
    terms: readonly string[],
  ): ReadonlySet<string> {
    if (terms.length === 0) {
      return new Set(this.#listProjectionItems(dashboardId, scope).map(({ id }) => id));
    }
    const fragments = terms.map(
      () => `(
        instr(lower(
          ':' || CAST(item.item_number AS TEXT) || ': ' ||
          COALESCE(item.title, '') || ' ' || COALESCE(item.summary, '') || ' ' ||
          COALESCE(item.source_ref, '') || ' ' || COALESCE(item.source_scope, '') || ' ' ||
          COALESCE(item.labels, '') || ' ' || COALESCE(item.people, '') || ' ' ||
          COALESCE(item.attention, '') || ' ' || COALESCE(item.plan, '') || ' ' ||
          COALESCE(item.next_steps, '') || ' ' || COALESCE(item.archive_reason, '') || ' ' ||
          COALESCE(item.archive_reason_detail, '') || ' ' || COALESCE(item.archive_outcome, '') || ' ' ||
          COALESCE(item.user_workflow_outcome, '') || ' ' ||
          CASE WHEN item.enrichment_base_fingerprint = item.fingerprint THEN
            COALESCE(item.enrichment_summary, '') || ' ' ||
            COALESCE(item.enrichment_priority_reason, '') || ' ' ||
            COALESCE(item.enrichment_labels, '') || ' ' || COALESCE(item.enrichment_people, '') || ' ' ||
            COALESCE(item.enrichment_attention, '') || ' ' || COALESCE(item.enrichment_plan, '') || ' ' ||
            COALESCE(item.enrichment_next_steps, '')
          ELSE '' END
        ), ?) > 0
        OR EXISTS (SELECT 1 FROM annotations annotation
          WHERE annotation.item_id = item.id AND annotation.deleted_at IS NULL
            AND instr(lower(annotation.body), ?) > 0)
        OR EXISTS (SELECT 1 FROM task_bindings task
          WHERE task.item_id = item.id AND instr(lower(
            task.title || ' ' || task.state || ' ' || COALESCE(task.outcome, '')
          ), ?) > 0)
        OR EXISTS (SELECT 1 FROM work_updates update_row
          WHERE update_row.item_id = item.id AND instr(${activitySearchSql("update_row")}, ?) > 0)
      )`,
    );
    const rows = this.#database
      .prepare(
        `${dynaProjectionMembershipCte(scope)}
         SELECT item.id FROM projection_items item WHERE ${fragments.join(" AND ")}`,
      )
      .all(dashboardId, ...terms.flatMap((term) => [term, term, term, term])) as SqlRow[];
    return new Set(rows.map((row) => requiredString(row, "id")));
  }

  #loadCardEvidence(
    itemIds: readonly string[],
    searchTerms: readonly string[] = [],
  ): readonly DynaRepositoryCardEvidence[] {
    if (itemIds.length === 0) return [];
    if (itemIds.length > 200) throw new Error("Dyna card evidence is limited to 200 items.");
    const placeholders = itemIds.map(() => "?").join(", ");
    const annotationRows = this.#database
      .prepare(
        `SELECT * FROM (
           SELECT *, ROW_NUMBER() OVER (
             PARTITION BY item_id ORDER BY created_at DESC, id
           ) AS item_rank
           FROM annotations
           WHERE item_id IN (${placeholders}) AND deleted_at IS NULL
         ) WHERE item_rank <= 20 ORDER BY item_id, created_at DESC`,
      )
      .all(...itemIds) as SqlRow[];
    const taskRows = this.#database
      .prepare(
        `SELECT * FROM (
           SELECT *, ROW_NUMBER() OVER (
             PARTITION BY item_id ORDER BY observed_ms DESC, task_id, host_id
           ) AS item_rank
           FROM task_bindings WHERE item_id IN (${placeholders})
         ) WHERE item_rank <= 8 ORDER BY item_id, observed_ms DESC`,
      )
      .all(...itemIds) as SqlRow[];
    const workUpdateRows = this.#database
      .prepare(
        `SELECT * FROM (
           SELECT update_row.*, update_row.rowid AS insertion_seq, ROW_NUMBER() OVER (
             PARTITION BY item_id ORDER BY created_at_ms DESC, update_row.rowid DESC
           ) AS item_rank
           FROM work_updates update_row WHERE item_id IN (${placeholders})
         ) WHERE item_rank <= ? ORDER BY item_id, created_at_ms DESC, insertion_seq DESC`,
      )
      .all(...itemIds, MAX_WORK_UPDATES_PER_CARD) as SqlRow[];
    const countRows = this.#database
      .prepare(
        `SELECT item_id, COUNT(*) AS total FROM work_updates
         WHERE item_id IN (${placeholders}) GROUP BY item_id`,
      )
      .all(...itemIds) as SqlRow[];
    const activityExpression = activitySearchSql("update_row");
    const activityMatches = searchTerms.map(() => `instr(${activityExpression}, ?) > 0`);
    const activityCoverage = activityMatches
      .map((match) => `CASE WHEN ${match} THEN 1 ELSE 0 END`)
      .join(" + ");
    const matchingActivityRows =
      searchTerms.length === 0
        ? []
        : (this.#database
            .prepare(
              `SELECT * FROM (
                 SELECT update_row.*, ROW_NUMBER() OVER (
                   PARTITION BY item_id ORDER BY (${activityCoverage}) DESC,
                     created_at_ms DESC, rowid DESC
                 ) AS item_rank
                 FROM work_updates update_row
                 WHERE item_id IN (${placeholders}) AND (${activityMatches.join(" OR ")})
               ) WHERE item_rank = 1`,
            )
            .all(...searchTerms, ...itemIds, ...searchTerms) as SqlRow[]);
    const annotations = new Map<string, z.infer<typeof DynaAnnotationSchema>[]>();
    for (const row of annotationRows) {
      const itemId = requiredString(row, "item_id");
      const values = annotations.get(itemId) ?? [];
      values.push(DynaAnnotationSchema.parse(this.#annotationFromRow(row)));
      annotations.set(itemId, values);
    }
    const tasks = new Map<string, DynaTaskStatus[]>();
    for (const row of taskRows) {
      const itemId = requiredString(row, "item_id");
      const values = tasks.get(itemId) ?? [];
      values.push(this.#taskFromRow(row));
      tasks.set(itemId, values);
    }
    const updates = new Map<string, DynaWorkUpdate[]>();
    for (const row of workUpdateRows) {
      const itemId = requiredString(row, "item_id");
      const values = updates.get(itemId) ?? [];
      values.push(this.#workUpdateFromRow(row));
      updates.set(itemId, values);
    }
    const counts = new Map(
      countRows.map((row) => [requiredString(row, "item_id"), requiredNumber(row, "total")]),
    );
    const matched = new Map<string, string>();
    for (const row of matchingActivityRows) {
      const summary = matchedActivitySummary(this.#workUpdateFromRow(row), searchTerms);
      if (summary) matched.set(requiredString(row, "item_id"), summary);
    }
    return itemIds.map((itemId) => ({
      itemId,
      annotations: annotations.get(itemId) ?? [],
      linkedTasks: tasks.get(itemId) ?? [],
      workUpdates: updates.get(itemId) ?? [],
      workUpdateCount: counts.get(itemId) ?? 0,
      ...(matched.get(itemId) ? { matchedActivity: matched.get(itemId) } : {}),
    }));
  }

  itemContext(itemId: string): DynaItemContext {
    return DynaItemContextSchema.parse({
      ...this.#item(itemId),
      annotations: this.#annotations(itemId),
      workUpdates: this.#workUpdates(itemId, 20),
      workUpdateCount: this.#workUpdateCount(itemId),
      linkedTasks: this.#linkedTasks(itemId),
    });
  }

  #pruneCodexSessionCaches(): void {
    const now = this.#nowMs();
    for (const [requestId, entry] of this.#codexSessionCandidateLists) {
      if (entry.expiresAtMs <= now) this.#codexSessionCandidateLists.delete(requestId);
    }
    for (const [requestId, entry] of this.#codexSessionAttachAuthorizations) {
      if (
        entry.expiresAtMs <= now ||
        !this.#codexSessionCandidateLists.has(entry.sessionListRequestId)
      ) {
        this.#codexSessionAttachAuthorizations.delete(requestId);
      }
    }
  }

  #rememberCodexSessionCandidates(
    requestId: string,
    row: SqlRow,
    candidates: readonly DynaCodexSessionCandidate[],
  ): void {
    this.#pruneCodexSessionCaches();
    const parsed = DynaCodexSessionCandidatesSchema.parse(candidates);
    const viewTokenHash = storedTokenHashKey(row["view_token_hash"]);
    const itemId = optionalString(row, "item_id");
    if (!viewTokenHash || !itemId) {
      throw new Error("The Dyna Codex session request is missing its authorization context.");
    }
    const expiresAtMs = Math.min(
      Date.parse(requiredString(row, "expires_at")),
      this.#nowMs() + CODEX_SESSION_CANDIDATE_TTL_MS,
    );
    this.#codexSessionCandidateLists.delete(requestId);
    this.#codexSessionCandidateLists.set(requestId, {
      dashboardId: requiredString(row, "dashboard_id"),
      itemId,
      viewTokenHash,
      expiresAtMs,
      candidates: parsed,
    });
    while (this.#codexSessionCandidateLists.size > MAX_CODEX_SESSION_CANDIDATE_LISTS) {
      const oldest = this.#codexSessionCandidateLists.keys().next().value;
      if (!oldest) break;
      this.#codexSessionCandidateLists.delete(oldest);
    }
    this.#pruneCodexSessionCaches();
  }

  #authorizeCodexSessionCandidate(
    viewToken: string,
    dashboardId: string,
    itemId: string,
    sessionListRequestId: string,
    taskId: string,
    hostId: string,
  ): CachedCodexSessionAttachAuthorization {
    this.#pruneCodexSessionCaches();
    const row = this.#one(
      this.#database.prepare("SELECT * FROM action_requests WHERE id = ?"),
      sessionListRequestId,
    );
    const cache = this.#codexSessionCandidateLists.get(sessionListRequestId);
    const viewTokenHash = tokenHash(viewToken).toString("hex");
    if (
      !row ||
      requiredString(row, "kind") !== "list_codex_sessions" ||
      requiredString(row, "state") !== "succeeded" ||
      requiredString(row, "dashboard_id") !== dashboardId ||
      optionalString(row, "item_id") !== itemId ||
      !hashesMatch(viewToken, row["view_token_hash"]) ||
      requiredString(row, "expires_at") <= this.#now() ||
      cache?.dashboardId !== dashboardId ||
      cache.itemId !== itemId ||
      cache.viewTokenHash !== viewTokenHash ||
      cache.expiresAtMs <= this.#nowMs()
    ) {
      throw new Error(
        "The Codex session list expired or belongs to another Dyna view; refresh it.",
      );
    }
    if (
      !cache.candidates.some(
        (candidate) => candidate.taskId === taskId && candidate.hostId === hostId,
      )
    ) {
      throw new Error("The selected Codex session is not in the authorized session list.");
    }
    return { sessionListRequestId, expiresAtMs: cache.expiresAtMs };
  }

  #rememberCodexSessionAttachAuthorization(
    requestId: string,
    authorization: CachedCodexSessionAttachAuthorization,
  ): void {
    this.#pruneCodexSessionCaches();
    this.#codexSessionAttachAuthorizations.delete(requestId);
    this.#codexSessionAttachAuthorizations.set(requestId, authorization);
    while (this.#codexSessionAttachAuthorizations.size > MAX_CODEX_SESSION_ATTACH_AUTHORIZATIONS) {
      const oldest = this.#codexSessionAttachAuthorizations.keys().next().value;
      if (!oldest) break;
      this.#codexSessionAttachAuthorizations.delete(oldest);
    }
  }

  #assertCodexSessionAttachAuthorization(row: SqlRow): void {
    this.#pruneCodexSessionCaches();
    const requestId = requiredString(row, "id");
    const authorization = this.#codexSessionAttachAuthorizations.get(requestId);
    const cache = authorization
      ? this.#codexSessionCandidateLists.get(authorization.sessionListRequestId)
      : undefined;
    const taskId = optionalString(row, "task_id");
    const hostId = optionalString(row, "host_id");
    const viewTokenHash = storedTokenHashKey(row["view_token_hash"]);
    if (
      !authorization ||
      authorization.expiresAtMs <= this.#nowMs() ||
      !cache ||
      cache.expiresAtMs <= this.#nowMs() ||
      cache.dashboardId !== requiredString(row, "dashboard_id") ||
      cache.itemId !== optionalString(row, "item_id") ||
      !viewTokenHash ||
      cache.viewTokenHash !== viewTokenHash ||
      !taskId ||
      !hostId ||
      !cache.candidates.some(
        (candidate) => candidate.taskId === taskId && candidate.hostId === hostId,
      )
    ) {
      throw new Error(
        "The selected Codex session authorization expired; refresh the session list.",
      );
    }
  }

  prepareAction(
    viewToken: string,
    kind: DynaActionKind,
    values: {
      readonly itemId: string;
      readonly taskId?: string;
      readonly taskHostId?: string;
      readonly sessionListRequestId?: string;
      readonly expectedRevision: number;
      readonly expectedFingerprint: string;
      readonly idempotencyKey: string;
    },
    attachmentBlocker?: DynaRepositoryTaskAttachmentBlocker,
  ): z.infer<typeof DynaActionRequestSchema> {
    DynaActionKindSchema.parse(kind);
    const dashboardId = this.authorizeView(viewToken, values.itemId);
    let attachAuthorization: CachedCodexSessionAttachAuthorization | undefined;
    const result = this.#transaction<
      z.infer<typeof DynaActionRequestSchema> | { readonly error: string }
    >(() => {
      const instant = this.#now();
      if (kind === "attach_codex_task") {
        if (!values.taskId || !values.taskHostId || !values.sessionListRequestId) {
          throw new Error(
            "Attaching a Codex session requires its exact task, host, and authorized session list.",
          );
        }
      } else if (values.sessionListRequestId) {
        throw new Error("Only a Codex session attachment can use a session list request.");
      }
      const existing = this.#one(
        this.#database.prepare(
          "SELECT * FROM action_requests WHERE dashboard_id = ? AND idempotency_key = ?",
        ),
        dashboardId,
        values.idempotencyKey,
      );
      if (existing) {
        if (
          requiredString(existing, "kind") !== kind ||
          requiredString(existing, "item_id") !== values.itemId ||
          optionalString(existing, "task_id") !== values.taskId ||
          optionalString(existing, "host_id") !== values.taskHostId ||
          requiredNumber(existing, "dashboard_revision") !== values.expectedRevision ||
          requiredString(existing, "item_fingerprint") !== values.expectedFingerprint
        ) {
          throw new Error("The Dyna idempotency key was already used for another action.");
        }
        return this.#actionFromRow(existing);
      }

      if (kind === "attach_codex_task") {
        const taskId = values.taskId;
        const taskHostId = values.taskHostId;
        const sessionListRequestId = values.sessionListRequestId;
        if (!taskId || !taskHostId || !sessionListRequestId) {
          throw new Error(
            "Attaching a Codex session requires its exact task, host, and authorized session list.",
          );
        }
        attachAuthorization = this.#authorizeCodexSessionCandidate(
          viewToken,
          dashboardId,
          values.itemId,
          sessionListRequestId,
          taskId,
          taskHostId,
        );
      }

      const revisionRow = this.#one(
        this.#database.prepare("SELECT revision FROM dashboards WHERE id = ?"),
        dashboardId,
      );
      if (!revisionRow || requiredNumber(revisionRow, "revision") !== values.expectedRevision) {
        throw new Error("The Dyna dashboard changed; refresh before taking action.");
      }
      const item = this.#itemBaseRow(values.itemId);
      if (requiredString(item, "fingerprint") !== values.expectedFingerprint) {
        throw new Error("The Dyna item changed; refresh before taking action.");
      }
      if (kind === "open_source" && requiredString(item, "source") === "manual") {
        throw new Error("This Dyna to-do has no originating source to open.");
      }
      if (
        kind === "open_codex_task" ||
        kind === "refresh_codex_status" ||
        kind === "attach_codex_task"
      ) {
        if (!values.taskId || !values.taskHostId) {
          throw new Error("This Dyna action requires a linked Codex task and host.");
        }
        const linked = this.#one(
          this.#database.prepare(
            "SELECT 1 AS present FROM task_bindings WHERE item_id = ? AND task_id = ? AND host_id = ?",
          ),
          values.itemId,
          values.taskId,
          values.taskHostId,
        );
        if (kind !== "attach_codex_task" && !linked) {
          throw new Error("The Codex task is not linked to this Dyna item.");
        }
        if (kind === "attach_codex_task" && !linked) {
          if (attachmentBlocker) throw new Error(attachmentBlocker.message);
          if (!this.#taskBindingCapacityAvailable(values.itemId)) {
            throw new Error("A Dyna item cannot link more than eight Codex tasks.");
          }
        }
      } else if (values.taskId || values.taskHostId) {
        throw new Error("This Dyna action cannot target an existing Codex task.");
      }

      if (kind === "create_codex_task") {
        if (attachmentBlocker) throw new Error(attachmentBlocker.message);
        this.#database
          .prepare(
            `UPDATE action_requests SET state = 'needs_reconciliation', uncertain_effect = 1,
               failure_message = ?, claim_token_hash = NULL, claim_expires_at = NULL,
               updated_at = ?
             WHERE item_id = ? AND kind = 'create_codex_task' AND state = 'claimed'
               AND (claim_expires_at IS NULL OR claim_expires_at <= ?)`,
          )
          .run(
            "The controller claim expired after task creation may have started.",
            instant,
            values.itemId,
            instant,
          );
      }

      const unresolved = this.#one(
        this.#database.prepare(
          `
        SELECT * FROM action_requests
        WHERE dashboard_id = ? AND item_id = ? AND kind = ?
          AND dashboard_revision = ? AND item_fingerprint = ?
          AND COALESCE(task_id, '') = COALESCE(?, '')
          AND COALESCE(host_id, '') = COALESCE(?, '')
          AND expires_at > ?
          AND (
            state IN ('prepared', 'delivered') OR
            (state = 'claimed' AND claim_expires_at > ?)
          )
        ORDER BY created_at DESC LIMIT 1
      `,
        ),
        dashboardId,
        values.itemId,
        kind,
        values.expectedRevision,
        values.expectedFingerprint,
        values.taskId ?? null,
        values.taskHostId ?? null,
        instant,
        instant,
      );
      if (unresolved) return this.#actionFromRow(unresolved);

      if (kind === "create_codex_task") {
        const hasUncertainCreation = Boolean(
          this.#one(
            this.#database.prepare(
              `SELECT 1 AS present FROM action_requests
               WHERE item_id = ? AND kind = 'create_codex_task'
                 AND state = 'needs_reconciliation' AND uncertain_effect = 1
               LIMIT 1`,
            ),
            values.itemId,
          ),
        );
        if (hasUncertainCreation) {
          return {
            error:
              "A prior Codex task creation needs explicit reconciliation before another can start.",
          };
        }
        if (!this.#taskBindingCapacityAvailable(values.itemId)) {
          throw new Error("A Dyna item cannot link more than eight Codex tasks.");
        }
      }

      const request = DynaActionRequestSchema.parse({
        id: randomUUID(),
        kind,
        dashboardId,
        itemId: values.itemId,
        ...(values.taskId ? { taskId: values.taskId } : {}),
        ...(values.taskHostId ? { taskHostId: values.taskHostId } : {}),
        dashboardRevision: values.expectedRevision,
        itemFingerprint: values.expectedFingerprint,
        state: "prepared",
        expiresAt: new Date(Date.parse(instant) + ACTION_TTL_MS).toISOString(),
        createdAt: instant,
        updatedAt: instant,
      });
      this.#database
        .prepare(
          `
        INSERT INTO action_requests (
          id, view_token_hash, dashboard_id, kind, item_id, item_fingerprint,
          dashboard_revision, task_id, host_id, idempotency_key, state,
          expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          request.id,
          tokenHash(viewToken),
          dashboardId,
          request.kind,
          request.itemId ?? null,
          request.itemFingerprint,
          request.dashboardRevision,
          request.taskId ?? null,
          request.taskHostId ?? null,
          values.idempotencyKey,
          request.state,
          request.expiresAt,
          request.createdAt,
          request.updatedAt,
        );
      return request;
    });
    if ("error" in result) throw new DynaCommittedMutationError(result.error);
    if (kind === "attach_codex_task" && attachAuthorization) {
      this.#rememberCodexSessionAttachAuthorization(result.id, attachAuthorization);
    }
    return result;
  }

  markDelivered(viewToken: string, requestId: string): z.infer<typeof DynaActionRequestSchema> {
    this.authorizeView(viewToken);
    const hash = tokenHash(viewToken);
    return this.#transaction(() => {
      const instant = this.#now();
      let row = this.#one(
        this.#database.prepare(
          "SELECT * FROM action_requests WHERE id = ? AND view_token_hash = ?",
        ),
        requestId,
        hash,
      );
      if (!row) throw new Error("The Dyna action request cannot be delivered.");

      const state = requiredString(row, "state");
      const requestExpired = requiredString(row, "expires_at") <= instant;
      const claimExpired =
        state === "claimed" &&
        (!optionalString(row, "claim_expires_at") ||
          requiredString(row, "claim_expires_at") <= instant);
      if (requestExpired && (state === "prepared" || state === "delivered")) {
        this.#database
          .prepare(
            `UPDATE action_requests SET state = 'needs_reconciliation', failure_message = ?,
               uncertain_effect = 0, claim_token_hash = NULL, claim_expires_at = NULL,
               updated_at = ?
             WHERE id = ? AND view_token_hash = ? AND state = ? AND expires_at <= ?`,
          )
          .run(
            "The action expired before the controller confirmed delivery.",
            instant,
            requestId,
            hash,
            state,
            instant,
          );
      } else if (claimExpired) {
        this.#database
          .prepare(
            `UPDATE action_requests SET state = 'needs_reconciliation', failure_message = ?,
               uncertain_effect = 1, claim_token_hash = NULL, claim_expires_at = NULL,
               updated_at = ?
             WHERE id = ? AND view_token_hash = ? AND state = 'claimed'
               AND (claim_expires_at IS NULL OR claim_expires_at <= ?)`,
          )
          .run(
            "The controller claim expired before completion.",
            instant,
            requestId,
            hash,
            instant,
          );
      } else if (state === "prepared") {
        this.#database
          .prepare(
            `UPDATE action_requests SET state = 'delivered', updated_at = ?
             WHERE id = ? AND view_token_hash = ? AND state = 'prepared' AND expires_at > ?`,
          )
          .run(instant, requestId, hash, instant);
      }

      row = this.#one(
        this.#database.prepare(
          "SELECT * FROM action_requests WHERE id = ? AND view_token_hash = ?",
        ),
        requestId,
        hash,
      );
      if (!row) throw new Error("The Dyna action request cannot be delivered.");
      const request = this.#actionFromRow(row);
      if (
        !["delivered", "claimed", "succeeded", "failed", "needs_reconciliation"].includes(
          request.state,
        )
      ) {
        throw new Error("The Dyna action request cannot be delivered.");
      }
      return request;
    });
  }

  actionStatusForView(
    viewToken: string,
    requestId: string,
  ): z.infer<typeof DynaActionRequestSchema> & {
    readonly candidates?: readonly DynaCodexSessionCandidate[];
  } {
    this.authorizeView(viewToken);
    let row = this.#one(
      this.#database.prepare("SELECT * FROM action_requests WHERE id = ? AND view_token_hash = ?"),
      requestId,
      tokenHash(viewToken),
    );
    if (!row) throw new Error("Dyna action request was not found in this view.");
    const instant = this.#now();
    const state = requiredString(row, "state");
    const requestExpired = requiredString(row, "expires_at") <= instant;
    const claimExpired =
      state === "claimed" &&
      (!optionalString(row, "claim_expires_at") ||
        requiredString(row, "claim_expires_at") <= instant);
    if ((requestExpired && ["prepared", "delivered"].includes(state)) || claimExpired) {
      const failureMessage = claimExpired
        ? "The controller claim expired before completion."
        : "The action expired before the controller confirmed delivery.";
      this.#database
        .prepare(
          `UPDATE action_requests SET state = 'needs_reconciliation', failure_message = ?,
             uncertain_effect = ?,
             claim_token_hash = NULL, claim_expires_at = NULL, updated_at = ?
           WHERE id = ? AND state = ?`,
        )
        .run(failureMessage, claimExpired ? 1 : 0, instant, requestId, state);
      row = this.#one(
        this.#database.prepare("SELECT * FROM action_requests WHERE id = ?"),
        requestId,
      );
      if (!row) throw new Error("Dyna action request was not found in this view.");
    }
    const request = this.#actionFromRow(row);
    this.#pruneCodexSessionCaches();
    const cache =
      request.kind === "list_codex_sessions" && request.state === "succeeded"
        ? this.#codexSessionCandidateLists.get(request.id)
        : undefined;
    return {
      ...request,
      ...(cache ? { candidates: cache.candidates.map((candidate) => ({ ...candidate })) } : {}),
    };
  }

  claimAction(
    requestId: string,
    attachmentBlocker?: DynaRepositoryTaskAttachmentBlocker,
  ): ClaimedDynaAction {
    const claimToken = token();
    const result = this.#transaction<ClaimedDynaAction | { readonly error: string }>(() => {
      const instant = this.#now();
      const requestRow = this.#one(
        this.#database.prepare("SELECT * FROM action_requests WHERE id = ?"),
        requestId,
      );
      if (!requestRow) throw new Error("The Dyna action request was not found.");
      const requestExpiry = Date.parse(requiredString(requestRow, "expires_at"));
      const dashboardId = optionalString(requestRow, "dashboard_id");
      const itemId = optionalString(requestRow, "item_id");
      const dashboard = dashboardId
        ? this.#one(
            this.#database.prepare("SELECT revision FROM dashboards WHERE id = ?"),
            dashboardId,
          )
        : undefined;
      const item = itemId
        ? this.#one(this.#database.prepare("SELECT fingerprint FROM items WHERE id = ?"), itemId)
        : undefined;
      const membership =
        dashboardId && itemId
          ? this.#one(
              this.#database.prepare(
                `SELECT 1 AS present FROM publisher_items pi
                 JOIN dashboard_publishers dp ON dp.publisher_id = pi.publisher_id
                 WHERE dp.dashboard_id = ? AND pi.item_id = ? AND pi.active = 1`,
              ),
              dashboardId,
              itemId,
            )
          : undefined;
      const kind = requiredString(requestRow, "kind");
      const selectedTaskId = optionalString(requestRow, "task_id");
      const selectedTaskHostId = optionalString(requestRow, "host_id");
      const attachingNewTask =
        kind === "attach_codex_task" && itemId && selectedTaskId && selectedTaskHostId
          ? !this.#taskBindingExists(itemId, selectedTaskId)
          : false;
      let sessionAuthorizationError: string | undefined;
      if (kind === "attach_codex_task") {
        try {
          this.#assertCodexSessionAttachAuthorization(requestRow);
        } catch {
          sessionAuthorizationError =
            "The selected Codex session authorization expired; refresh the session list.";
        }
      }
      if (
        sessionAuthorizationError &&
        requiredString(requestRow, "state") === "delivered" &&
        requiredString(requestRow, "expires_at") > instant
      ) {
        this.#database
          .prepare(
            `UPDATE action_requests SET state = 'failed', failure_message = ?,
               uncertain_effect = 0, claim_token_hash = NULL, claim_expires_at = NULL,
               updated_at = ? WHERE id = ? AND state = 'delivered'`,
          )
          .run(sessionAuthorizationError, instant, requestId);
        return { error: sessionAuthorizationError };
      }
      const applicableAttachmentBlocker =
        dashboardId && itemId && (kind === "create_codex_task" || attachingNewTask)
          ? attachmentBlocker
          : undefined;
      if (
        applicableAttachmentBlocker &&
        requiredString(requestRow, "state") === "delivered" &&
        requiredString(requestRow, "expires_at") > instant
      ) {
        this.#database
          .prepare(
            `UPDATE action_requests SET state = 'failed', failure_message = ?,
               uncertain_effect = 0, claim_token_hash = NULL, claim_expires_at = NULL,
               updated_at = ? WHERE id = ? AND state = 'delivered'`,
          )
          .run(applicableAttachmentBlocker.message, instant, requestId);
        return { error: applicableAttachmentBlocker.message };
      }
      if (
        !dashboard ||
        !item ||
        !membership ||
        requiredNumber(dashboard, "revision") !==
          requiredNumber(requestRow, "dashboard_revision") ||
        requiredString(item, "fingerprint") !== requiredString(requestRow, "item_fingerprint")
      ) {
        this.#database
          .prepare(
            `UPDATE action_requests SET state = 'needs_reconciliation', failure_message = ?,
               uncertain_effect = 0,
               claim_token_hash = NULL, claim_expires_at = NULL, updated_at = ?
             WHERE id = ? AND state = 'delivered'`,
          )
          .run(
            "The dashboard or item changed before the controller claimed the action.",
            instant,
            requestId,
          );
        return { error: "The Dyna action preconditions changed before it could be claimed." };
      }
      if (
        itemId &&
        (kind === "create_codex_task" || attachingNewTask) &&
        requiredString(requestRow, "state") === "delivered" &&
        requiredString(requestRow, "expires_at") > instant &&
        !this.#taskBindingCapacityAvailable(
          itemId,
          kind === "attach_codex_task" ? requestId : undefined,
        )
      ) {
        this.#database
          .prepare(
            `UPDATE action_requests SET state = 'failed', failure_message = ?,
               uncertain_effect = 0, claim_token_hash = NULL, claim_expires_at = NULL,
               updated_at = ? WHERE id = ? AND state = 'delivered'`,
          )
          .run(
            kind === "create_codex_task"
              ? "The linked Codex task limit was reached before creation started."
              : "The linked Codex task limit was reached before attachment started.",
            instant,
            requestId,
          );
        return { error: "The Dyna item cannot link another Codex task." };
      }
      const claimExpiresAt = new Date(
        Math.min(this.#nowMs() + CLAIM_LEASE_MS, requestExpiry),
      ).toISOString();
      const changed = this.#database
        .prepare(
          `
          UPDATE action_requests SET state = 'claimed', claim_token_hash = ?,
            claim_expires_at = ?, updated_at = ?
          WHERE id = ? AND state = 'delivered' AND expires_at > ?
        `,
        )
        .run(tokenHash(claimToken), claimExpiresAt, instant, requestId, instant).changes;
      if (changed !== 1) {
        throw new Error("The Dyna action request is unavailable, expired, or already claimed.");
      }
      const request = this.actionStatus(requestId);
      return {
        request,
        claimToken,
        context: {
          ...(request.itemId ? { item: this.#actionItemContext(request.itemId) } : {}),
          ...((request.kind === "open_codex_task" || request.kind === "refresh_codex_status") &&
          request.taskId &&
          request.taskHostId &&
          request.itemId
            ? { task: this.#task(request.itemId, request.taskId, request.taskHostId) }
            : {}),
        },
      };
    });
    if ("error" in result) throw new DynaCommittedMutationError(result.error);
    return result;
  }

  completeAction(
    requestId: string,
    claimToken: string,
    result:
      | {
          readonly outcome: "succeeded";
          readonly task?: DynaTaskStatus;
          readonly candidates?: readonly DynaCodexSessionCandidate[];
        }
      | {
          readonly outcome: "failed" | "needs_reconciliation";
          readonly failureMessage: string;
        },
    attachmentBlocker?: DynaRepositoryTaskAttachmentBlocker,
  ): z.infer<typeof DynaActionRequestSchema> {
    const publicFailureMessage =
      result.outcome === "succeeded"
        ? undefined
        : sanitizePublicFailureMessage(result.failureMessage);
    let candidateCache:
      | { readonly row: SqlRow; readonly candidates: readonly DynaCodexSessionCandidate[] }
      | undefined;
    const completed = this.#transaction(() => {
      const row = this.#one(
        this.#database.prepare("SELECT * FROM action_requests WHERE id = ? AND state = 'claimed'"),
        requestId,
      );
      if (!row || !hashesMatch(claimToken, row["claim_token_hash"])) {
        throw new Error("The Dyna action completion capability is invalid.");
      }
      const instant = this.#now();
      const claimExpiry = optionalString(row, "claim_expires_at");
      if (!claimExpiry || claimExpiry <= instant || requiredString(row, "expires_at") <= instant) {
        this.#database
          .prepare(
            `
            UPDATE action_requests SET state = 'needs_reconciliation', failure_message = ?,
              uncertain_effect = 1,
              claim_token_hash = NULL, claim_expires_at = NULL, updated_at = ? WHERE id = ?
          `,
          )
          .run("The controller claim expired before completion.", instant, requestId);
        return this.actionStatus(requestId);
      }

      const kind = requiredString(row, "kind");
      if (result.outcome === "succeeded") {
        if (
          (kind === "create_codex_task" ||
            kind === "refresh_codex_status" ||
            kind === "attach_codex_task") &&
          !result.task
        ) {
          throw new Error("The successful Dyna action requires controller-reported task metadata.");
        }
        if (
          (kind === "open_codex_task" ||
            kind === "open_source" ||
            kind === "list_codex_sessions") &&
          result.task
        ) {
          throw new Error("Opening a Dyna target cannot attach task metadata.");
        }
        if (kind === "list_codex_sessions") {
          if (!result.candidates) {
            throw new Error("A successful Codex session list requires bounded candidates.");
          }
          candidateCache = {
            row,
            candidates: DynaCodexSessionCandidatesSchema.parse(result.candidates),
          };
        } else if (result.candidates) {
          throw new Error("Only a Codex session list can return session candidates.");
        }
        if (
          (kind === "refresh_codex_status" || kind === "attach_codex_task") &&
          result.task &&
          result.task.taskId !== optionalString(row, "task_id")
        ) {
          throw new Error("The controller-observed Codex task does not match the claimed request.");
        }
        if (kind === "create_codex_task" && result.task) {
          const itemId = optionalString(row, "item_id");
          if (!itemId) throw new Error("The Dyna action has no item to link.");
          if (attachmentBlocker) {
            this.#database
              .prepare(
                `UPDATE action_requests SET state = 'needs_reconciliation', failure_message = ?,
                   uncertain_effect = 1, result_task_id = NULL,
                   claim_token_hash = NULL, claim_expires_at = NULL, updated_at = ?
                 WHERE id = ? AND state = 'claimed'`,
              )
              .run(attachmentBlocker.message, instant, requestId);
            this.#audit("action.needs_reconciliation", requestId, instant);
            return this.actionStatus(requestId);
          }
        }
        if (kind === "attach_codex_task" && result.task) {
          const itemId = optionalString(row, "item_id");
          if (!itemId) throw new Error("The Dyna action has no item to link.");
          const alreadyLinked = this.#taskBindingExists(itemId, result.task.taskId);
          try {
            this.#assertCodexSessionAttachAuthorization(row);
          } catch {
            const message =
              "The selected Codex session authorization expired; refresh the session list.";
            this.#database
              .prepare(
                `UPDATE action_requests SET state = 'failed', failure_message = ?,
                   uncertain_effect = 0, result_task_id = NULL,
                   claim_token_hash = NULL, claim_expires_at = NULL, updated_at = ?
                 WHERE id = ? AND state = 'claimed'`,
              )
              .run(message, instant, requestId);
            this.#audit("action.failed", requestId, instant);
            return this.actionStatus(requestId);
          }
          if (!alreadyLinked) {
            const capacityAvailable = this.#taskBindingCapacityAvailable(itemId, requestId);
            if (attachmentBlocker || !capacityAvailable) {
              const message =
                attachmentBlocker?.message ?? "The Dyna item cannot link another Codex task.";
              this.#database
                .prepare(
                  `UPDATE action_requests SET state = 'failed', failure_message = ?,
                     uncertain_effect = 0, result_task_id = NULL,
                     claim_token_hash = NULL, claim_expires_at = NULL, updated_at = ?
                   WHERE id = ? AND state = 'claimed'`,
                )
                .run(message, instant, requestId);
              this.#audit("action.failed", requestId, instant);
              return this.actionStatus(requestId);
            }
          }
          this.#upsertTaskStatus(itemId, result.task, requestId);
        } else if (result.task) {
          const itemId = optionalString(row, "item_id");
          if (!itemId) throw new Error("The Dyna action has no item to link.");
          this.#upsertTaskStatus(
            itemId,
            result.task,
            kind === "create_codex_task" ? requestId : undefined,
          );
        }
      }
      this.#database
        .prepare(
          `
          UPDATE action_requests SET state = ?, result_task_id = ?, failure_message = ?,
            uncertain_effect = ?,
            claim_token_hash = NULL, claim_expires_at = NULL, updated_at = ?
          WHERE id = ? AND state = 'claimed'
        `,
        )
        .run(
          result.outcome,
          result.outcome === "succeeded" ? (result.task?.taskId ?? null) : null,
          publicFailureMessage ?? null,
          result.outcome === "needs_reconciliation" ? 1 : 0,
          instant,
          requestId,
        );
      this.#audit(`action.${result.outcome}`, requestId, instant);
      return this.actionStatus(requestId);
    });
    if (candidateCache && completed.state === "succeeded") {
      this.#rememberCodexSessionCandidates(
        requestId,
        candidateCache.row,
        candidateCache.candidates,
      );
    }
    if (
      completed.kind === "attach_codex_task" &&
      ["succeeded", "failed", "needs_reconciliation"].includes(completed.state)
    ) {
      this.#codexSessionAttachAuthorizations.delete(requestId);
    }
    return completed;
  }

  resolveActionReconciliation(
    requestId: string,
    resolution:
      | { readonly outcome: "task_linked"; readonly task: DynaTaskStatus }
      | { readonly outcome: "no_task_created"; readonly explanation: string },
    attachmentBlocker?: DynaRepositoryTaskAttachmentBlocker,
  ): z.infer<typeof DynaActionRequestSchema> {
    const publicExplanation =
      resolution.outcome === "no_task_created"
        ? sanitizePublicFailureMessage(resolution.explanation)
        : undefined;
    return this.#transaction(() => {
      const row = this.#one(
        this.#database.prepare(
          `SELECT * FROM action_requests WHERE id = ?
             AND kind IN ('create_codex_task', 'attach_codex_task')
             AND state = 'needs_reconciliation' AND uncertain_effect = 1`,
        ),
        requestId,
      );
      if (!row) throw new Error("The Dyna task association is not awaiting reconciliation.");
      const itemId = optionalString(row, "item_id");
      if (!itemId) throw new Error("The Dyna action has no item to reconcile.");
      const kind = requiredString(row, "kind");
      const instant = this.#now();
      if (resolution.outcome === "task_linked") {
        if (attachmentBlocker) throw new Error(attachmentBlocker.message);
        this.#upsertTaskStatus(
          itemId,
          resolution.task,
          kind === "create_codex_task" || kind === "attach_codex_task" ? requestId : undefined,
        );
      }
      this.#database
        .prepare(
          `UPDATE action_requests SET state = ?, result_task_id = ?, failure_message = ?,
             uncertain_effect = 0, updated_at = ? WHERE id = ?`,
        )
        .run(
          resolution.outcome === "task_linked" ? "succeeded" : "failed",
          resolution.outcome === "task_linked" ? resolution.task.taskId : null,
          publicExplanation ?? null,
          instant,
          requestId,
        );
      this.#audit(`action.reconciled.${resolution.outcome}`, requestId, instant);
      return this.actionStatus(requestId);
    });
  }

  actionStatus(requestId: string): z.infer<typeof DynaActionRequestSchema> {
    const row = this.#one(
      this.#database.prepare("SELECT * FROM action_requests WHERE id = ?"),
      requestId,
    );
    if (!row) throw new Error("Dyna action request was not found.");
    return this.#actionFromRow(row);
  }

  #taskBindingCapacityAvailable(itemId: string, excludedRequestId?: string): boolean {
    const creationCount = this.#one(
      this.#database.prepare(
        `SELECT COUNT(*) AS total FROM action_requests
         WHERE item_id = ? AND kind = 'create_codex_task'
           AND (state = 'claimed' OR
             (state = 'needs_reconciliation' AND uncertain_effect = 1))
           AND (? IS NULL OR id <> ?)`,
      ),
      itemId,
      excludedRequestId ?? null,
      excludedRequestId ?? null,
    );
    if (!creationCount) {
      throw new Error("Dyna could not determine linked Codex task capacity.");
    }
    return (
      this.#countTaskBindingsForItem(itemId) +
        requiredNumber(creationCount, "total") +
        this.#countActiveTaskAssociationReservationsForItem(itemId, excludedRequestId) <
      MAX_TASK_BINDINGS_PER_ITEM
    );
  }

  #taskBindingExists(itemId: string, taskId: string): boolean {
    return Boolean(
      this.#one(
        this.#database.prepare(
          "SELECT 1 AS present FROM task_bindings WHERE item_id = ? AND task_id = ?",
        ),
        itemId,
        taskId,
      ),
    );
  }

  #actionFromRow(row: SqlRow): z.infer<typeof DynaActionRequestSchema> {
    return DynaActionRequestSchema.parse({
      id: requiredString(row, "id"),
      kind: requiredString(row, "kind"),
      dashboardId: requiredString(row, "dashboard_id"),
      ...(optionalString(row, "item_id") ? { itemId: optionalString(row, "item_id") } : {}),
      ...(optionalString(row, "task_id") ? { taskId: optionalString(row, "task_id") } : {}),
      ...(optionalString(row, "host_id") ? { taskHostId: optionalString(row, "host_id") } : {}),
      dashboardRevision: requiredNumber(row, "dashboard_revision"),
      itemFingerprint: requiredString(row, "item_fingerprint"),
      state: requiredString(row, "state"),
      expiresAt: requiredString(row, "expires_at"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at"),
    });
  }

  #listTaskSyncRuns(dashboardId: string, limit = 10): readonly DynaRepositoryTaskSyncRun[] {
    const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    return (
      this.#database
        .prepare(
          `SELECT * FROM task_sync_runs
           WHERE dashboard_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(dashboardId, boundedLimit) as SqlRow[]
    ).map((row) => this.#taskSyncRunFromRow(row));
  }

  #findTaskSyncRun(runId: string): DynaRepositoryTaskSyncRun | undefined {
    const row = this.#one(
      this.#database.prepare("SELECT * FROM task_sync_runs WHERE id = ?"),
      runId,
    );
    return row ? this.#taskSyncRunFromRow(row) : undefined;
  }

  #taskSyncRunFromRow(row: SqlRow): DynaRepositoryTaskSyncRun {
    const scopeKind = requiredString(row, "scope_kind");
    const scope = DynaTaskSyncScopeSchema.parse(
      scopeKind === "dashboard"
        ? { kind: "dashboard" }
        : {
            kind: "task",
            itemId: requiredString(row, "scope_item_id"),
            taskId: requiredString(row, "scope_task_id"),
            hostId: requiredString(row, "scope_host_id"),
          },
    );
    return {
      id: requiredString(row, "id"),
      dashboardId: requiredString(row, "dashboard_id"),
      scope,
      state: requiredString(row, "state") as DynaTaskSyncRunState,
      ...(optionalString(row, "claim_token_hash")
        ? { claimTokenHash: optionalString(row, "claim_token_hash") }
        : {}),
      ...(optionalString(row, "lease_expires_at")
        ? { leaseExpiresAt: optionalString(row, "lease_expires_at") }
        : {}),
      expiresAt: requiredString(row, "expires_at"),
      totalTasks: requiredNumber(row, "total_tasks"),
      excessTasks: requiredNumber(row, "excess_tasks"),
      processedTasks: requiredNumber(row, "processed_tasks"),
      updatedItems: requiredNumber(row, "updated_items"),
      unavailableTasks: requiredNumber(row, "unavailable_tasks"),
      incompleteMetadataTasks: requiredNumber(row, "incomplete_metadata_tasks"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at"),
      ...(optionalString(row, "completed_at")
        ? { completedAt: optionalString(row, "completed_at") }
        : {}),
    };
  }

  #listTaskSyncCandidates(
    dashboardId: string,
    scope: DynaTaskSyncScope,
    limit: number,
  ): { readonly candidates: readonly DynaRepositoryTaskSyncCandidate[]; readonly total: number } {
    const parsedScope = DynaTaskSyncScopeSchema.parse(scope);
    const boundedLimit = Math.max(1, Math.min(MAX_TASK_SYNC_TARGETS, Math.trunc(limit)));
    const taskPredicate =
      parsedScope.kind === "task"
        ? "AND item.id = ?2 AND task.task_id = ?3 AND task.host_id = ?4"
        : "";
    const membership = `
      FROM task_bindings task
      JOIN items item ON item.id = task.item_id
      JOIN item_numbers item_number ON item_number.item_id = item.id
      JOIN publisher_items publisher_item ON publisher_item.item_id = item.id
        AND publisher_item.publisher_id = item.publisher_id
      JOIN dashboard_publishers dashboard_publisher
        ON dashboard_publisher.publisher_id = publisher_item.publisher_id
       AND dashboard_publisher.dashboard_id = ?1
      LEFT JOIN item_archive_events archive
        ON archive.dashboard_id = dashboard_publisher.dashboard_id
       AND archive.item_id = item.id AND archive.restored_at IS NULL
      LEFT JOIN task_sync_checkpoints checkpoint ON checkpoint.task_id = task.task_id
      WHERE archive.id IS NULL
        AND (publisher_item.active = 1 OR EXISTS (
          SELECT 1 FROM item_archive_events restored
          WHERE restored.dashboard_id = dashboard_publisher.dashboard_id
            AND restored.item_id = item.id AND restored.restored_at IS NOT NULL
        )) ${taskPredicate}`;
    const parameters: SQLInputValue[] =
      parsedScope.kind === "task"
        ? [dashboardId, parsedScope.itemId, parsedScope.taskId, parsedScope.hostId]
        : [dashboardId];
    const totalRow = this.#one(
      this.#database.prepare(`SELECT COUNT(DISTINCT task.task_id) AS total ${membership}`),
      ...parameters,
    );
    const rows = this.#database
      .prepare(
        `SELECT DISTINCT item.id AS item_id, item_number.number AS item_number,
           task.title AS task_title, task.task_id, task.host_id,
           COALESCE(checkpoint.version, 0) AS checkpoint_version,
           CASE WHEN checkpoint.host_id = task.host_id THEN checkpoint.cursor END AS cursor,
           checkpoint.last_turn_id,
           checkpoint.observed_at_ms AS checkpoint_observed_at_ms
         ${membership}
         ORDER BY COALESCE(checkpoint.updated_at, ''), task.observed_ms, task.task_id
         LIMIT ?${parameters.length + 1}`,
      )
      .all(...parameters, boundedLimit) as SqlRow[];
    return {
      total: totalRow ? requiredNumber(totalRow, "total") : 0,
      candidates: rows.map((row) => ({
        itemId: requiredString(row, "item_id"),
        itemNumber: requiredItemNumber(row, "item_number"),
        taskTitle: requiredString(row, "task_title"),
        taskId: requiredString(row, "task_id"),
        hostId: requiredString(row, "host_id"),
        checkpointVersion: requiredNumber(row, "checkpoint_version"),
        ...(optionalString(row, "cursor") ? { cursor: optionalString(row, "cursor") } : {}),
        ...(optionalString(row, "last_turn_id")
          ? { lastTurnId: optionalString(row, "last_turn_id") }
          : {}),
        ...(typeof row["checkpoint_observed_at_ms"] === "number"
          ? { checkpointObservedAtMs: row["checkpoint_observed_at_ms"] }
          : {}),
      })),
    };
  }

  #listTaskSyncTargets(runId: string): readonly DynaRepositoryTaskSyncTarget[] {
    return (
      this.#database
        .prepare("SELECT * FROM task_sync_targets WHERE run_id = ? ORDER BY task_id")
        .all(runId) as SqlRow[]
    ).map((row) => ({
      runId: requiredString(row, "run_id"),
      itemId: requiredString(row, "item_id"),
      itemNumber: requiredItemNumber(row, "item_number"),
      // The v9 schema named this captured title column after the item. Keep the
      // physical column for compatibility, but expose its actual task-title
      // semantics to the application layer.
      taskTitle: requiredString(row, "item_title"),
      taskId: requiredString(row, "task_id"),
      hostId: requiredString(row, "host_id"),
      checkpointVersion: requiredNumber(row, "checkpoint_version"),
      ...(optionalString(row, "checkpoint_cursor")
        ? { cursor: optionalString(row, "checkpoint_cursor") }
        : {}),
      ...(optionalString(row, "checkpoint_last_turn_id")
        ? { lastTurnId: optionalString(row, "checkpoint_last_turn_id") }
        : {}),
      ...(typeof row["checkpoint_observed_at_ms"] === "number"
        ? { checkpointObservedAtMs: row["checkpoint_observed_at_ms"] }
        : {}),
      state: requiredString(row, "state") as DynaTaskSyncTargetState,
      ...(optionalString(row, "observation_json")
        ? {
            observation: DynaTaskSyncObservationSchema.parse(
              parseJson(requiredString(row, "observation_json")),
            ),
          }
        : {}),
      ...(optionalString(row, "unavailable_reason")
        ? { unavailableReason: optionalString(row, "unavailable_reason") }
        : {}),
    }));
  }

  #findTaskSyncCheckpoint(taskId: string): DynaRepositoryTaskSyncCheckpoint | undefined {
    const row = this.#one(
      this.#database.prepare("SELECT * FROM task_sync_checkpoints WHERE task_id = ?"),
      taskId,
    );
    if (!row) return undefined;
    return {
      taskId: requiredString(row, "task_id"),
      hostId: requiredString(row, "host_id"),
      version: requiredNumber(row, "version"),
      ...(optionalString(row, "cursor") ? { cursor: optionalString(row, "cursor") } : {}),
      ...(optionalString(row, "last_turn_id")
        ? { lastTurnId: optionalString(row, "last_turn_id") }
        : {}),
      ...(optionalString(row, "status_updated_at")
        ? { statusUpdatedAt: optionalString(row, "status_updated_at") }
        : {}),
      ...(optionalString(row, "observed_at")
        ? { observedAt: optionalString(row, "observed_at") }
        : {}),
      updatedAt: requiredString(row, "updated_at"),
    };
  }

  #findTaskSyncReceipt(id: string): DynaRepositoryTaskSyncReceipt | undefined {
    const row = this.#one(
      this.#database.prepare("SELECT * FROM task_sync_receipts WHERE id = ?"),
      id,
    );
    if (!row) return undefined;
    return {
      id: requiredString(row, "id"),
      runId: requiredString(row, "run_id"),
      kind: requiredString(row, "kind") as DynaRepositoryTaskSyncReceipt["kind"],
      ...(optionalString(row, "task_id") ? { taskId: optionalString(row, "task_id") } : {}),
      requestHash: requiredString(row, "request_hash"),
      ...(optionalString(row, "result_json")
        ? { result: parseJson(requiredString(row, "result_json")) }
        : {}),
      createdAt: requiredString(row, "created_at"),
    };
  }

  #insertTaskSyncRun(run: DynaRepositoryTaskSyncRun): void {
    const scope = DynaTaskSyncScopeSchema.parse(run.scope);
    this.#database
      .prepare(
        `INSERT INTO task_sync_runs (
           id, dashboard_id, scope_kind, scope_item_id, scope_task_id, scope_host_id,
           state, claim_token_hash, lease_expires_at, expires_at, total_tasks,
           excess_tasks, processed_tasks, updated_items, unavailable_tasks,
           incomplete_metadata_tasks, created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.dashboardId,
        scope.kind,
        scope.kind === "task" ? scope.itemId : null,
        scope.kind === "task" ? scope.taskId : null,
        scope.kind === "task" ? scope.hostId : null,
        run.state,
        run.claimTokenHash ?? null,
        run.leaseExpiresAt ?? null,
        run.expiresAt,
        run.totalTasks,
        run.excessTasks,
        run.processedTasks,
        run.updatedItems,
        run.unavailableTasks,
        run.incompleteMetadataTasks,
        run.createdAt,
        run.updatedAt,
        run.completedAt ?? null,
      );
  }

  #updateTaskSyncRun(run: DynaRepositoryTaskSyncRun): void {
    const changed = this.#database
      .prepare(
        `UPDATE task_sync_runs SET state = ?, claim_token_hash = ?, lease_expires_at = ?,
           processed_tasks = ?, updated_items = ?, unavailable_tasks = ?,
           incomplete_metadata_tasks = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
      )
      .run(
        run.state,
        run.claimTokenHash ?? null,
        run.leaseExpiresAt ?? null,
        run.processedTasks,
        run.updatedItems,
        run.unavailableTasks,
        run.incompleteMetadataTasks,
        run.updatedAt,
        run.completedAt ?? null,
        run.id,
      ).changes;
    if (changed !== 1) throw new Error("The Dyna task synchronization run was not found.");
  }

  #insertTaskSyncTargets(runId: string, targets: readonly DynaRepositoryTaskSyncCandidate[]): void {
    const insert = this.#database.prepare(
      `INSERT INTO task_sync_targets (
         run_id, item_id, item_number, item_title, task_id, host_id,
         checkpoint_version, checkpoint_cursor, checkpoint_last_turn_id,
         checkpoint_observed_at_ms, state
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    );
    for (const target of targets) {
      insert.run(
        runId,
        target.itemId,
        target.itemNumber,
        target.taskTitle,
        target.taskId,
        target.hostId,
        target.checkpointVersion,
        target.cursor ?? null,
        target.lastTurnId ?? null,
        target.checkpointObservedAtMs ?? null,
      );
    }
  }

  #stageTaskSyncObservation(
    runId: string,
    taskId: string,
    observation: DynaTaskSyncObservation,
  ): boolean {
    return (
      this.#database
        .prepare(
          `UPDATE task_sync_targets SET state = 'staged', observation_json = ?,
             unavailable_reason = NULL
           WHERE run_id = ? AND task_id = ? AND state = 'pending'`,
        )
        .run(JSON.stringify(DynaTaskSyncObservationSchema.parse(observation)), runId, taskId)
        .changes === 1
    );
  }

  #stageTaskSyncUnavailable(runId: string, taskId: string, reason: string): boolean {
    return (
      this.#database
        .prepare(
          `UPDATE task_sync_targets SET state = 'unavailable', observation_json = NULL,
             unavailable_reason = ?
           WHERE run_id = ? AND task_id = ? AND state = 'pending'`,
        )
        .run(reason, runId, taskId).changes === 1
    );
  }

  #markTaskSyncTarget(runId: string, taskId: string, state: "applied" | "skipped"): void {
    const changed = this.#database
      .prepare(
        `UPDATE task_sync_targets SET state = ? WHERE run_id = ? AND task_id = ?
         AND state IN ('staged', 'unavailable')`,
      )
      .run(state, runId, taskId).changes;
    if (changed !== 1) throw new Error("The Dyna task synchronization target is not staged.");
  }

  #insertTaskSyncReceipt(receipt: DynaRepositoryTaskSyncReceipt): void {
    this.#database
      .prepare(
        `INSERT INTO task_sync_receipts (
           id, run_id, kind, task_id, request_hash, result_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.id,
        receipt.runId,
        receipt.kind,
        receipt.taskId ?? null,
        receipt.requestHash,
        receipt.result === undefined ? null : JSON.stringify(receipt.result),
        receipt.createdAt,
      );
  }

  #upsertTaskSyncCheckpoint(checkpoint: DynaRepositoryTaskSyncCheckpoint): void {
    const observed = checkpoint.observedAt
      ? normalizeTimestamp(checkpoint.observedAt, true)
      : undefined;
    this.#database
      .prepare(
        `INSERT INTO task_sync_checkpoints (
           task_id, host_id, version, cursor, last_turn_id, status_updated_at,
           observed_at, observed_at_ms, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           host_id = excluded.host_id, version = excluded.version, cursor = excluded.cursor,
           last_turn_id = excluded.last_turn_id,
           status_updated_at = excluded.status_updated_at,
           observed_at = excluded.observed_at, observed_at_ms = excluded.observed_at_ms,
           updated_at = excluded.updated_at`,
      )
      .run(
        checkpoint.taskId,
        checkpoint.hostId,
        checkpoint.version,
        checkpoint.cursor ?? null,
        checkpoint.lastTurnId ?? null,
        checkpoint.statusUpdatedAt ?? null,
        observed?.iso ?? null,
        observed?.epoch ?? null,
        checkpoint.updatedAt ?? checkpoint.observedAt ?? this.#now(),
      );
  }

  upsertTaskStatus(itemId: string, status: DynaTaskStatus): void {
    this.#transaction(() => {
      this.#upsertTaskStatus(itemId, status);
    });
  }

  upsertTaskStatusForDashboard(
    dashboardId: string,
    itemId: string,
    status: DynaTaskStatus,
    attachmentBlocker?: DynaRepositoryTaskAttachmentBlocker,
    excludedReservationRequestId?: string,
  ): void {
    this.#transaction(() => {
      const parsed = DynaTaskStatusSchema.parse(status);
      this.assertDashboardContainsItem(dashboardId, itemId);
      const existing = this.#one(
        this.#database.prepare("SELECT item_id FROM task_bindings WHERE task_id = ?"),
        parsed.taskId,
      );
      if (existing && requiredString(existing, "item_id") !== itemId) {
        throw new DynaCliStoreError(
          "request_conflict",
          "This Codex task is already linked to another Dyna item.",
        );
      }
      if (!existing) {
        if (attachmentBlocker) {
          throw new DynaCliStoreError(attachmentBlocker.code, attachmentBlocker.message);
        }
      }
      this.#upsertTaskStatus(itemId, parsed, excludedReservationRequestId);
    });
  }

  #upsertTaskStatus(
    itemId: string,
    status: DynaTaskStatus,
    excludedCapacityRequestId?: string,
    touchDashboards = true,
  ): boolean {
    const parsed = DynaTaskStatusSchema.parse(status);
    this.#itemBaseRow(itemId);
    const statusTime = normalizeTimestamp(parsed.statusUpdatedAt, true);
    const observedTime = normalizeTimestamp(parsed.observedAt, true);
    const existing = this.#one(
      this.#database.prepare(
        `SELECT item_id, host_id, project_id, title, state, outcome,
           status_updated_ms, observed_ms
         FROM task_bindings WHERE task_id = ?`,
      ),
      parsed.taskId,
    );
    if (existing && requiredString(existing, "item_id") !== itemId) {
      throw new DynaCliStoreError(
        "request_conflict",
        "This Codex task is already linked to another Dyna item.",
      );
    }
    if (!existing && !this.#taskBindingCapacityAvailable(itemId, excludedCapacityRequestId)) {
      throw new Error("A Dyna item cannot link more than eight Codex tasks.");
    }
    // A controller-observed success closes this task binding for the original
    // item. Continued execution belongs on an explicit follow-up item instead
    // of silently moving historical Done work back into the active pipeline.
    if (
      existing &&
      requiredString(existing, "state") === "succeeded" &&
      parsed.state !== "succeeded"
    ) {
      throw new DynaCliStoreError(
        "request_conflict",
        "A controller-confirmed Codex success is terminal; continued work requires a follow-up item.",
      );
    }
    if (
      existing &&
      observedTime.epoch > requiredNumber(existing, "observed_ms") &&
      statusTime.epoch === requiredNumber(existing, "status_updated_ms") &&
      (parsed.state !== requiredString(existing, "state") ||
        parsed.outcome !== optionalString(existing, "outcome"))
    ) {
      throw new Error("Dyna rejected conflicting Codex task data at the same status timestamp.");
    }
    const semanticallyChanged =
      !existing ||
      requiredString(existing, "host_id") !== parsed.hostId ||
      optionalString(existing, "project_id") !== parsed.projectId ||
      requiredString(existing, "title") !== parsed.title ||
      requiredString(existing, "state") !== parsed.state ||
      requiredNumber(existing, "status_updated_ms") !== statusTime.epoch ||
      optionalString(existing, "outcome") !== parsed.outcome;
    const changed = this.#database
      .prepare(
        `
        INSERT INTO task_bindings (
          item_id, task_id, host_id, project_id, title, state,
          status_updated_at, status_updated_ms, observed_at, observed_ms, outcome
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          host_id = excluded.host_id, project_id = excluded.project_id,
          title = excluded.title, state = excluded.state,
          status_updated_at = excluded.status_updated_at,
          status_updated_ms = excluded.status_updated_ms,
          observed_at = excluded.observed_at, observed_ms = excluded.observed_ms,
          outcome = excluded.outcome
        WHERE task_bindings.item_id = excluded.item_id
          AND excluded.observed_ms > task_bindings.observed_ms
          AND excluded.status_updated_ms >= task_bindings.status_updated_ms
      `,
      )
      .run(
        itemId,
        parsed.taskId,
        parsed.hostId,
        parsed.projectId ?? null,
        parsed.title,
        parsed.state,
        statusTime.iso,
        statusTime.epoch,
        observedTime.iso,
        observedTime.epoch,
        parsed.outcome ?? null,
      ).changes;
    if (changed === 1 && touchDashboards) this.#touchDashboardsForItem(itemId);
    return changed === 1 && semanticallyChanged;
  }

  #task(itemId: string, taskId: string, hostId: string): DynaTaskStatus {
    const row = this.#one(
      this.#database.prepare(
        "SELECT * FROM task_bindings WHERE item_id = ? AND task_id = ? AND host_id = ?",
      ),
      itemId,
      taskId,
      hostId,
    );
    if (!row) throw new Error("The linked Codex task was not found.");
    return this.#taskFromRow(row);
  }

  #itemBaseRow(itemId: string): SqlRow {
    const row = this.#one(
      this.#database.prepare(
        `SELECT item.*, item_number.number AS item_number,
           follow_up.source_item_id AS follow_up_reference_item_id,
           follow_up.source_item_number AS follow_up_of_item_number
         FROM items item
         JOIN item_numbers item_number ON item_number.item_id = item.id
         LEFT JOIN item_follow_ups follow_up ON follow_up.item_id = item.id
         WHERE item.id = ?`,
      ),
      itemId,
    );
    if (!row) throw new Error("Dyna item was not found.");
    return row;
  }

  #baseItem(row: SqlRow): DynaPublishedItem {
    return DynaMaterializedItemSchema.parse({
      externalId: requiredString(row, "external_id"),
      sourceRef: DynaSourceRefSchema.parse(parseJson(requiredString(row, "source_ref"))),
      sourceScope: requiredString(row, "source_scope"),
      title: requiredString(row, "title"),
      summary: requiredString(row, "summary"),
      priority: requiredString(row, "priority"),
      priorityReason: requiredString(row, "priority_reason"),
      sourceUpdatedAt: requiredString(row, "source_updated_at"),
      ...(optionalString(row, "due_at") ? { dueAt: optionalString(row, "due_at") } : {}),
      labels: parseJson(requiredString(row, "labels")),
      people: parseJson(requiredString(row, "people")),
      ...(optionalString(row, "attention") ? { attention: optionalString(row, "attention") } : {}),
      plan: parseJson(requiredString(row, "plan")),
      nextSteps: parseJson(requiredString(row, "next_steps")),
    });
  }

  #item(
    itemId: string,
  ): Omit<DynaItemContext, "annotations" | "workUpdates" | "workUpdateCount" | "linkedTasks"> {
    const row = this.#itemBaseRow(itemId);
    const enrichment = this.#one(
      this.#database.prepare("SELECT * FROM item_enrichments WHERE item_id = ?"),
      itemId,
    );
    return this.#mergeItem(row, enrichment);
  }

  #mergeItem(
    row: SqlRow,
    enrichment?: SqlRow,
  ): Omit<DynaItemContext, "annotations" | "workUpdates" | "workUpdateCount" | "linkedTasks"> {
    const itemId = requiredString(row, "id");
    const itemNumber = requiredItemNumber(row, "item_number");
    const followUpOfItemId = followUpReferenceItemId(row);
    const followUpOfItemNumber =
      typeof row["follow_up_of_item_number"] === "number"
        ? requiredItemNumber(row, "follow_up_of_item_number")
        : undefined;
    const base = this.#baseItem(row);
    if (!enrichment) {
      return {
        ...base,
        id: itemId,
        itemNumber,
        fingerprint: requiredString(row, "fingerprint"),
        ...(followUpOfItemId ? { followUpOfItemId } : {}),
        ...(followUpOfItemNumber ? { followUpOfItemNumber } : {}),
      };
    }
    const enrichmentActive =
      requiredString(enrichment, "base_fingerprint") === requiredString(row, "fingerprint");
    const dueAtSet = enrichmentActive && requiredNumber(enrichment, "due_at_set") === 1;
    const merged = DynaMaterializedItemSchema.parse({
      ...base,
      ...(enrichmentActive && optionalString(enrichment, "summary")
        ? { summary: optionalString(enrichment, "summary") }
        : {}),
      ...(enrichmentActive && optionalString(enrichment, "priority")
        ? { priority: optionalString(enrichment, "priority") }
        : {}),
      ...(enrichmentActive && optionalString(enrichment, "priority_reason")
        ? { priorityReason: optionalString(enrichment, "priority_reason") }
        : {}),
      ...(dueAtSet ? { dueAt: optionalString(enrichment, "due_at") } : {}),
      ...(enrichmentActive && optionalString(enrichment, "labels")
        ? { labels: parseJson(requiredString(enrichment, "labels")) }
        : {}),
      ...(enrichmentActive && optionalString(enrichment, "people")
        ? { people: parseJson(requiredString(enrichment, "people")) }
        : {}),
      ...(enrichmentActive && optionalString(enrichment, "attention")
        ? { attention: optionalString(enrichment, "attention") }
        : {}),
      ...(enrichmentActive && optionalString(enrichment, "plan")
        ? { plan: parseJson(requiredString(enrichment, "plan")) }
        : {}),
      ...(enrichmentActive && optionalString(enrichment, "next_steps")
        ? { nextSteps: parseJson(requiredString(enrichment, "next_steps")) }
        : {}),
    });
    return {
      ...merged,
      id: itemId,
      itemNumber,
      fingerprint: requiredString(row, "fingerprint"),
      ...(followUpOfItemId ? { followUpOfItemId } : {}),
      ...(followUpOfItemNumber ? { followUpOfItemNumber } : {}),
      enrichment: {
        state: enrichmentActive ? "active" : "stale",
        appliedAt: requiredString(enrichment, "applied_at"),
        baseSourceUpdatedAt: requiredString(enrichment, "base_source_updated_at"),
        provenance: requiredString(enrichment, "provenance"),
        version: requiredNumber(enrichment, "version"),
      },
    };
  }

  #annotations(itemId: string): z.infer<typeof DynaAnnotationSchema>[] {
    return (
      this.#database
        .prepare(
          `SELECT * FROM annotations
           WHERE item_id = ? AND deleted_at IS NULL
           ORDER BY created_at DESC LIMIT 20`,
        )
        .all(itemId) as SqlRow[]
    ).map((annotation) => DynaAnnotationSchema.parse(this.#annotationFromRow(annotation)));
  }

  #workUpdates(itemId: string, limit = MAX_WORK_UPDATES_PER_CARD): DynaWorkUpdate[] {
    return (
      this.#database
        .prepare(
          "SELECT * FROM work_updates WHERE item_id = ? ORDER BY created_at_ms DESC, rowid DESC LIMIT ?",
        )
        .all(itemId, limit) as SqlRow[]
    ).map((row) => this.#workUpdateFromRow(row));
  }

  #findWorkUpdate(id: string): DynaWorkUpdate | undefined {
    const row = this.#one(this.#database.prepare("SELECT * FROM work_updates WHERE id = ?"), id);
    return row ? this.#workUpdateFromRow(row) : undefined;
  }

  #workUpdateCount(itemId: string): number {
    const row = this.#one(
      this.#database.prepare("SELECT COUNT(*) AS total FROM work_updates WHERE item_id = ?"),
      itemId,
    );
    if (!row) throw new Error("Dyna could not count item work updates.");
    return requiredNumber(row, "total");
  }

  #workUpdatePage(
    itemId: string,
    limit: number,
    cursor?: DynaHistoryCursor,
  ): { readonly updates: DynaWorkUpdate[]; readonly nextCursor?: string } {
    const rows = this.#database
      .prepare(
        `SELECT *, rowid AS insertion_sequence FROM work_updates
         WHERE item_id = ?
         ${
           cursor
             ? `AND (created_at_ms < ? OR (
                  created_at_ms = ? AND rowid < ?
                ))`
             : ""
         }
         ORDER BY created_at_ms DESC, rowid DESC LIMIT ?`,
      )
      .all(
        itemId,
        ...(cursor ? [cursor.createdAtMs, cursor.createdAtMs, cursor.insertionSequence] : []),
        limit + 1,
      ) as SqlRow[];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      updates: page.map((row) => this.#workUpdateFromRow(row)),
      ...(rows.length > limit && last
        ? {
            nextCursor: historyCursor(
              "work",
              requiredNumber(last, "created_at_ms"),
              requiredNumber(last, "insertion_sequence"),
            ),
          }
        : {}),
    };
  }

  #linkedTasks(itemId: string): DynaTaskStatus[] {
    return (
      this.#database
        .prepare(
          "SELECT * FROM task_bindings WHERE item_id = ? ORDER BY observed_ms DESC, task_id, host_id LIMIT ?",
        )
        .all(itemId, MAX_TASK_BINDINGS_PER_ITEM) as SqlRow[]
    ).map((row) => this.#taskFromRow(row));
  }

  #actionItemContext(itemId: string): z.infer<typeof DynaActionItemContextSchema> {
    const item = this.#item(itemId);
    return DynaActionItemContextSchema.parse({
      id: itemId,
      itemNumber: item.itemNumber,
      title: item.title,
      sourceRef: item.sourceRef,
      sourceUpdatedAt: item.sourceUpdatedAt,
      annotations: this.#annotations(itemId),
      trustBoundary: "untrusted_reference_data",
    });
  }

  #workUpdateFromRow(row: SqlRow): DynaWorkUpdate {
    return DynaWorkUpdateSchema.parse({
      schema: "dyna/work-update-v1",
      id: requiredString(row, "id"),
      itemId: requiredString(row, "item_id"),
      originDashboardId: requiredString(row, "origin_dashboard_id"),
      workAttemptId: requiredString(row, "work_attempt_id"),
      kind: requiredString(row, "kind"),
      body: requiredString(row, "body"),
      ...(optionalString(row, "outcome") ? { outcome: optionalString(row, "outcome") } : {}),
      ...(optionalString(row, "supersedes_work_update_id")
        ? { supersedesWorkUpdateId: optionalString(row, "supersedes_work_update_id") }
        : {}),
      artifacts: parseJson(requiredString(row, "artifacts")),
      ...(optionalString(row, "task_id") && optionalString(row, "host_id")
        ? {
            task: {
              taskId: optionalString(row, "task_id"),
              hostId: optionalString(row, "host_id"),
              ...(optionalString(row, "task_title")
                ? { title: optionalString(row, "task_title") }
                : {}),
            },
          }
        : {}),
      createdAt: requiredString(row, "created_at"),
    });
  }

  #userWorkflowEventFromRow(row: SqlRow): DynaUserWorkflowEvent {
    return DynaUserWorkflowEventSchema.parse({
      id: requiredString(row, "id"),
      itemId: requiredString(row, "item_id"),
      originDashboardId: requiredString(row, "origin_dashboard_id"),
      targetStage: requiredString(row, "target_stage"),
      ...(optionalString(row, "outcome") ? { outcome: optionalString(row, "outcome") } : {}),
      ...(optionalString(row, "task_id") && optionalString(row, "host_id")
        ? {
            task: {
              taskId: optionalString(row, "task_id"),
              hostId: optionalString(row, "host_id"),
              ...(optionalString(row, "task_title")
                ? { title: optionalString(row, "task_title") }
                : {}),
            },
          }
        : {}),
      ...(optionalString(row, "work_attempt_id")
        ? { workAttemptId: optionalString(row, "work_attempt_id") }
        : {}),
      createdAt: requiredString(row, "created_at"),
    });
  }

  #taskFromRow(row: SqlRow): DynaTaskStatus {
    return DynaTaskStatusSchema.parse({
      taskId: requiredString(row, "task_id"),
      hostId: requiredString(row, "host_id"),
      ...(optionalString(row, "project_id")
        ? { projectId: optionalString(row, "project_id") }
        : {}),
      title: requiredString(row, "title"),
      state: requiredString(row, "state"),
      statusUpdatedAt: requiredString(row, "status_updated_at"),
      observedAt: requiredString(row, "observed_at"),
      ...(optionalString(row, "outcome") ? { outcome: optionalString(row, "outcome") } : {}),
    });
  }

  #touchDashboardsForPublisher(publisherId: string, instant?: string): void {
    const dashboards = (
      this.#database
        .prepare("SELECT dashboard_id FROM dashboard_publishers WHERE publisher_id = ?")
        .all(publisherId) as SqlRow[]
    ).map((row) => requiredString(row, "dashboard_id"));
    this.#touchDashboards(dashboards, instant);
  }

  #touchDashboardsForItem(itemId: string, instant?: string): void {
    const dashboards = (
      this.#database
        .prepare(
          `
        SELECT DISTINCT dp.dashboard_id FROM dashboard_publishers dp
        JOIN publisher_items pi ON pi.publisher_id = dp.publisher_id
        WHERE pi.item_id = ? AND (
          pi.active = 1 OR EXISTS (
            SELECT 1 FROM item_archive_events history
            WHERE history.dashboard_id = dp.dashboard_id AND history.item_id = pi.item_id
          )
        )
      `,
        )
        .all(itemId) as SqlRow[]
    ).map((row) => requiredString(row, "dashboard_id"));
    this.#touchDashboards(dashboards, instant);
  }

  #touchDashboards(dashboardIds: Iterable<string>, instant?: string): void {
    const updatedAt = instant ?? this.#now();
    const update = this.#database.prepare(
      "UPDATE dashboards SET revision = revision + 1, updated_at = ? WHERE id = ?",
    );
    for (const dashboardId of new Set(dashboardIds)) update.run(updatedAt, dashboardId);
  }
}

/**
 * Internal persistence port. Protocol adapters must depend on
 * DynaApplicationService rather than this interface or its SQLite
 * implementation.
 */
export interface DynaRepository {
  read<T>(operation: (unitOfWork: DynaReadUnitOfWork) => T): T;
  write<T>(operation: (unitOfWork: DynaWriteUnitOfWork) => T): T;
  close: SqliteDynaRepository["close"];
  backup: SqliteDynaRepository["backup"];
}

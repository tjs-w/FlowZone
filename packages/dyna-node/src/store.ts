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
  DynaDashboardSchema,
  DynaDashboardSnapshotSchema,
  DynaItemContextSchema,
  DynaMaterializedItemSchema,
  DynaPrioritySchema,
  DynaPublishedItemSchema,
  DynaPublisherSchema,
  DynaSourceRefSchema,
  DynaTaskStatusSchema,
  DynaTodoInputSchema,
  dynaLeadershipScore,
  dynaSourceLabel,
  effectiveDynaPriority,
  type DynaCard,
  type DynaDashboard,
  type DynaDashboardSnapshot,
  type DynaItemContext,
  type DynaPublishedItem,
  type DynaPublisher,
  type DynaTaskStatus,
  type DynaTodoInput,
} from "@flowzone/dyna-contracts";
import type { z } from "zod";

type DynaActionKind = z.infer<typeof DynaActionKindSchema>;
type SqlRow = Readonly<Record<string, unknown>>;

const VIEW_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const ACTION_TTL_MS = 10 * 60 * 1_000;
const CLAIM_LEASE_MS = 5 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const DYNA_SCHEMA_VERSION = 1;
const MAX_SCHEDULES_PER_DASHBOARD = 50;
const MAX_TASK_BINDINGS_PER_ITEM = 8;
const MAX_PUBLIC_FAILURE_LENGTH = 500;
const MAX_FAILURE_SANITIZATION_INPUT = 4_096;
const LEGACY_COMPLETION_OUTCOME =
  "Completed before outcome tracking; refresh this task for details.";
const LEGACY_UNSPECIFIED_FAILURE = "An earlier operation reported an unspecified failure.";

const DYNA_ELIGIBLE_CTE = `
  WITH eligible AS (
    SELECT DISTINCT i.*,
      CASE WHEN e.base_fingerprint = i.fingerprint THEN e.summary END AS enrichment_summary,
      CASE WHEN e.base_fingerprint = i.fingerprint THEN e.priority END AS enrichment_priority,
      CASE WHEN e.base_fingerprint = i.fingerprint THEN e.priority_reason END AS enrichment_priority_reason,
      CASE WHEN e.base_fingerprint = i.fingerprint THEN e.due_at END AS enrichment_due_at,
      CASE WHEN e.base_fingerprint = i.fingerprint THEN e.due_at_set END AS enrichment_due_at_set,
      CASE WHEN e.base_fingerprint = i.fingerprint THEN e.labels END AS enrichment_labels,
      CASE WHEN e.base_fingerprint = i.fingerprint THEN e.people END AS enrichment_people,
      CASE WHEN e.base_fingerprint = i.fingerprint THEN e.attention END AS enrichment_attention,
      CASE WHEN e.base_fingerprint = i.fingerprint THEN e.plan END AS enrichment_plan,
      CASE WHEN e.base_fingerprint = i.fingerprint THEN e.next_steps END AS enrichment_next_steps,
      e.base_fingerprint AS enrichment_base_fingerprint,
      e.base_source_updated_at AS enrichment_base_source_updated_at,
      e.applied_at AS enrichment_applied_at,
      e.provenance AS enrichment_provenance,
      e.version AS enrichment_version,
      p.priority_override AS preference_priority,
      p.sequence AS preference_sequence,
      CASE
        WHEN p.priority_override IS NOT NULL THEN p.priority_override
        WHEN e.base_fingerprint = i.fingerprint AND e.leadership_score >= 75
          AND COALESCE(e.priority, i.priority) = 'normal' THEN 'high'
        WHEN e.base_fingerprint = i.fingerprint AND e.leadership_score >= 55
          AND COALESCE(e.priority, i.priority) = 'low' THEN 'normal'
        ELSE COALESCE(
          CASE WHEN e.base_fingerprint = i.fingerprint THEN e.priority END,
          i.priority
        )
      END AS effective_priority,
      CASE WHEN e.base_fingerprint = i.fingerprint
        THEN e.leadership_score ELSE i.leadership_score END AS effective_leadership_score,
      CASE
        WHEN NOT EXISTS (SELECT 1 FROM task_bindings t WHERE t.item_id = i.id) THEN 'todo'
        WHEN EXISTS (
          SELECT 1 FROM task_bindings t
          WHERE t.item_id = i.id AND t.state IN ('failed', 'unknown')
        ) THEN 'attention'
        WHEN EXISTS (
          SELECT 1 FROM task_bindings t
          WHERE t.item_id = i.id AND t.state = 'waiting'
        ) THEN 'paused'
        WHEN EXISTS (
          SELECT 1 FROM task_bindings t
          WHERE t.item_id = i.id AND t.state IN ('queued', 'running')
        ) THEN 'executing'
        WHEN NOT EXISTS (
          SELECT 1 FROM task_bindings t
          WHERE t.item_id = i.id AND t.state <> 'succeeded'
        ) THEN 'completed'
        ELSE 'attention'
      END AS workflow_state
    FROM items i
    JOIN publisher_items pi ON pi.item_id = i.id AND pi.active = 1
    JOIN dashboard_publishers dp ON dp.publisher_id = pi.publisher_id
    LEFT JOIN item_enrichments e ON e.item_id = i.id
    LEFT JOIN item_preferences p ON p.item_id = i.id AND p.dashboard_id = dp.dashboard_id
    WHERE dp.dashboard_id = ?
  ), ranked AS (
    SELECT *, ROW_NUMBER() OVER (
      PARTITION BY identity_key ORDER BY source_updated_ms DESC, updated_at DESC, id
    ) AS identity_rank
    FROM eligible
  ), deduplicated AS (
    SELECT * FROM ranked WHERE identity_rank = 1
  ), positioned AS (
    SELECT *,
      CASE WHEN workflow_state = 'completed' THEN 1 ELSE 0 END AS completed_group,
      ROW_NUMBER() OVER (
        PARTITION BY effective_priority,
          CASE WHEN workflow_state = 'completed' THEN 1 ELSE 0 END
        ORDER BY COALESCE(preference_sequence, 2147483647),
          effective_leadership_score DESC,
          CASE WHEN enrichment_due_at_set = 1
            THEN COALESCE(enrichment_due_at, '9999') ELSE COALESCE(due_at, '9999') END,
          source_updated_ms DESC, id
      ) AS priority_position,
      COUNT(*) OVER (
        PARTITION BY effective_priority,
          CASE WHEN workflow_state = 'completed' THEN 1 ELSE 0 END
      ) AS priority_count
    FROM deduplicated
  )
`;

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
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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

function requiredNumber(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new Error(`Dyna database column ${key} is invalid.`);
  return value;
}

function requiredWorkflowState(row: SqlRow): DynaCard["workflowState"] {
  const value = requiredString(row, "workflow_state");
  if (
    value !== "todo" &&
    value !== "executing" &&
    value !== "paused" &&
    value !== "attention" &&
    value !== "completed"
  ) {
    throw new Error("Dyna database workflow state is invalid.");
  }
  return value;
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

export class DynaStore {
  readonly #database: DatabaseSync;
  readonly #clock: () => Date;

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

  close(): void {
    this.#database.close();
  }

  backup(destinationPath: string): string {
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
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS publishers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash BLOB NOT NULL,
        schedule_id TEXT, schedule_title TEXT, schedule_state TEXT NOT NULL DEFAULT 'unknown',
        stale_after_minutes INTEGER NOT NULL DEFAULT 1440,
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
        priority_override TEXT, sequence INTEGER, updated_at TEXT NOT NULL,
        PRIMARY KEY (dashboard_id, item_id)
      );
      CREATE TABLE IF NOT EXISTS todo_requests (
        dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
        client_request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        PRIMARY KEY (dashboard_id, client_request_id)
      );
      CREATE TABLE IF NOT EXISTS annotations (
        id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        body TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_bindings (
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL, host_id TEXT NOT NULL, project_id TEXT,
        title TEXT NOT NULL, state TEXT NOT NULL, status_updated_at TEXT NOT NULL,
        status_updated_ms INTEGER NOT NULL, observed_at TEXT NOT NULL, observed_ms INTEGER NOT NULL,
        outcome TEXT,
        PRIMARY KEY (item_id, task_id, host_id)
      );
      CREATE TABLE IF NOT EXISTS view_sessions (
        token_hash BLOB PRIMARY KEY, dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS action_requests (
        id TEXT PRIMARY KEY, view_token_hash BLOB NOT NULL, dashboard_id TEXT,
        kind TEXT NOT NULL, item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
        item_fingerprint TEXT, dashboard_revision INTEGER, task_id TEXT, host_id TEXT,
        idempotency_key TEXT, state TEXT NOT NULL, claim_token_hash BLOB, claim_expires_at TEXT,
        result_task_id TEXT, failure_message TEXT, uncertain_effect INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY, event_kind TEXT NOT NULL, entity_id TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
  }

  #migrateSchema(): void {
    const versionRow = this.#one(this.#database.prepare("PRAGMA user_version"));
    if (!versionRow) throw new Error("Dyna could not read its database schema version.");
    const version = requiredNumber(versionRow, "user_version");
    if (version > DYNA_SCHEMA_VERSION) {
      throw new Error(
        "The Dyna database was created by a newer FlowZone version and cannot be opened safely.",
      );
    }
    this.#database.exec("PRAGMA journal_mode = WAL;");
    if (version === DYNA_SCHEMA_VERSION) return;
    if (version !== 0) throw new Error("The Dyna database schema version is unsupported.");

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
      this.#database.exec("PRAGMA user_version = 1;");
    });
    const migratedVersion = this.#one(this.#database.prepare("PRAGMA user_version"));
    if (
      !migratedVersion ||
      requiredNumber(migratedVersion, "user_version") !== DYNA_SCHEMA_VERSION
    ) {
      throw new Error("Dyna could not complete its database schema migration.");
    }
  }

  #migrateUnversionedSchema(): void {
    const additions: Readonly<Record<string, Readonly<Record<string, string>>>> = {
      publishers: {
        schedule_id: "TEXT",
        schedule_title: "TEXT",
        schedule_state: "TEXT NOT NULL DEFAULT 'unknown'",
        stale_after_minutes: "INTEGER NOT NULL DEFAULT 1440",
        last_run_status: "TEXT NOT NULL DEFAULT 'never'",
        last_run_at: "TEXT",
        last_run_completed_ms: "INTEGER",
        last_run_error: "TEXT",
        revoked_at: "TEXT",
      },
      publisher_runs: {
        source_completed_at: "TEXT",
        source_completed_ms: "INTEGER",
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
            priority_override TEXT, sequence INTEGER, updated_at TEXT NOT NULL,
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
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #readTransaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK");
      throw error;
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

  createDashboard(name: string, description: string): DynaDashboard {
    const instant = this.#now();
    const dashboard = DynaDashboardSchema.parse({
      id: randomUUID(),
      name,
      description,
      archived: false,
      createdAt: instant,
      updatedAt: instant,
    });
    this.#database
      .prepare(
        "INSERT INTO dashboards (id, name, description, archived, revision, created_at, updated_at) VALUES (?, ?, ?, 0, 0, ?, ?)",
      )
      .run(dashboard.id, dashboard.name, dashboard.description, instant, instant);
    return dashboard;
  }

  updateDashboard(
    id: string,
    values: { readonly name?: string; readonly description?: string; readonly archived?: boolean },
  ): DynaDashboard {
    const current = this.getDashboard(id);
    const updated = DynaDashboardSchema.parse({ ...current, ...values, updatedAt: this.#now() });
    this.#database
      .prepare(
        "UPDATE dashboards SET name = ?, description = ?, archived = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
      )
      .run(updated.name, updated.description, updated.archived ? 1 : 0, updated.updatedAt, id);
    return updated;
  }

  purgeDashboard(id: string, confirmation: string): void {
    if (confirmation !== id) throw new Error("Dashboard purge confirmation did not match.");
    this.#transaction(() => {
      this.getDashboard(id);
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
      this.#audit("dashboard.purged", id);
    });
  }

  listDashboards(): DynaDashboard[] {
    return (
      this.#database
        .prepare(
          "SELECT id, name, description, archived, created_at, updated_at FROM dashboards ORDER BY archived, updated_at DESC",
        )
        .all() as SqlRow[]
    ).map((row) => this.#dashboardFromRow(row));
  }

  getDashboard(id: string): DynaDashboard {
    const row = this.#one(
      this.#database.prepare(
        "SELECT id, name, description, archived, created_at, updated_at FROM dashboards WHERE id = ?",
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
  ): { readonly publisher: DynaPublisher; readonly secret: string } {
    const secret = token();
    const publisher = DynaPublisherSchema.parse({
      id: randomUUID(),
      name,
      ...(schedule ? { scheduleId: schedule.id, scheduleTitle: schedule.title } : {}),
      scheduleState: schedule?.state ?? "unknown",
      staleAfterMinutes: schedule?.staleAfterMinutes ?? 1_440,
      lastRunStatus: "never",
      createdAt: this.#now(),
    });
    this.#database
      .prepare(
        `
        INSERT INTO publishers (
          id, name, token_hash, schedule_id, schedule_title, schedule_state,
          stale_after_minutes, last_run_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'never', ?)
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
        publisher.createdAt,
      );
    return { publisher, secret };
  }

  rotatePublisherSecret(publisherId: string): string {
    const secret = token();
    this.#transaction(() => {
      const changed = this.#database
        .prepare("UPDATE publishers SET token_hash = ? WHERE id = ? AND revoked_at IS NULL")
        .run(tokenHash(secret), publisherId).changes;
      if (changed !== 1) throw new Error("Active Dyna publisher was not found.");
      this.#audit("publisher.rotated", publisherId);
    });
    return secret;
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
            "UPDATE publishers SET revoked_at = COALESCE(revoked_at, ?), schedule_state = 'paused' WHERE id = ?",
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
        this.#database.prepare("SELECT schedule_id, revoked_at FROM publishers WHERE id = ?"),
        publisherId,
      );
      if (!publisher) throw new Error("Dyna publisher was not found.");
      if (optionalString(publisher, "revoked_at")) {
        throw new Error("A revoked Dyna publisher cannot be bound to a schedule.");
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
          `UPDATE publishers SET schedule_id = ?, schedule_title = ?, schedule_state = ?, stale_after_minutes = ?
           WHERE id = ? AND (
             COALESCE(schedule_id, '') != ? OR COALESCE(schedule_title, '') != ? OR
             schedule_state != ? OR stale_after_minutes != ?
           )`,
        )
        .run(
          scheduleId,
          scheduleTitle,
          schedule.state,
          schedule.staleAfterMinutes,
          publisherId,
          scheduleId,
          scheduleTitle,
          schedule.state,
          schedule.staleAfterMinutes,
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
    },
  ): void {
    this.#transaction(() => {
      const row = this.#one(
        this.#database.prepare(
          "SELECT schedule_title, schedule_state, stale_after_minutes FROM publishers WHERE id = ?",
        ),
        publisherId,
      );
      if (!row) throw new Error("Dyna publisher was not found.");
      const title = schedule.title ?? optionalString(row, "schedule_title");
      const staleAfterMinutes =
        schedule.staleAfterMinutes ?? requiredNumber(row, "stale_after_minutes");
      const changed = this.#database
        .prepare(
          "UPDATE publishers SET schedule_title = ?, schedule_state = ?, stale_after_minutes = ? WHERE id = ? AND (COALESCE(schedule_title, '') != COALESCE(?, '') OR schedule_state != ? OR stale_after_minutes != ?)",
        )
        .run(
          title ?? null,
          schedule.state,
          staleAfterMinutes,
          publisherId,
          title ?? null,
          schedule.state,
          staleAfterMinutes,
        ).changes;
      if (changed === 1) this.#touchDashboardsForPublisher(publisherId);
    });
  }

  listPublishers(dashboardId?: string): DynaPublisher[] {
    const rows = dashboardId
      ? (this.#database
          .prepare(
            `
            SELECT p.* FROM publishers p
            JOIN dashboard_publishers dp ON dp.publisher_id = p.id
            LEFT JOIN dashboard_manual_publishers mp ON mp.publisher_id = p.id
            WHERE dp.dashboard_id = ? AND mp.publisher_id IS NULL ORDER BY p.name, p.id
          `,
          )
          .all(dashboardId) as SqlRow[])
      : (this.#database
          .prepare(
            `SELECT p.* FROM publishers p
             LEFT JOIN dashboard_manual_publishers mp ON mp.publisher_id = p.id
             WHERE mp.publisher_id IS NULL ORDER BY p.name, p.id`,
          )
          .all() as SqlRow[]);
    return rows.map((row) => this.#publisherFromRow(row));
  }

  #publisherFromRow(row: SqlRow): DynaPublisher {
    const lastRunError = optionalString(row, "last_run_error");
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
      staleAfterMinutes: requiredNumber(row, "stale_after_minutes"),
      lastRunStatus: requiredString(row, "last_run_status"),
      ...(optionalString(row, "last_run_at")
        ? { lastRunAt: optionalString(row, "last_run_at") }
        : {}),
      ...(lastRunError ? { lastRunError: sanitizePersistedFailureMessage(lastRunError) } : {}),
      ...(optionalString(row, "revoked_at")
        ? { revokedAt: optionalString(row, "revoked_at") }
        : {}),
      createdAt: requiredString(row, "created_at"),
    });
  }

  publish(
    publisherId: string,
    secret: string,
    items: readonly DynaPublishedItem[],
    options: DynaPublishOptions,
  ): DynaPublishResult {
    const failureMessage =
      options.failureMessage === undefined
        ? undefined
        : sanitizePublicFailureMessage(options.failureMessage);
    if (options.status === "failed" && (items.length > 0 || !failureMessage)) {
      throw new Error("A failed Dyna run requires an error and cannot publish a partial snapshot.");
    }
    if (options.status === "succeeded" && failureMessage) {
      throw new Error("A successful Dyna run cannot include an error.");
    }
    if (
      options.status === "partial" &&
      (options.mode !== "upsert" || items.length === 0 || !failureMessage)
    ) {
      throw new Error(
        "A partial Dyna run requires upsert mode, at least one item, and a bounded error.",
      );
    }
    const parsedItems = items.map(normalizedPublishedItem);
    const sourceCompletion = normalizeTimestamp(options.sourceCompletedAt, true);
    const requestHash = sha256(
      JSON.stringify({
        runId: options.runId,
        sourceCompletedAt: sourceCompletion.iso,
        mode: options.mode,
        status: options.status,
        failureMessage: failureMessage ?? null,
        items: parsedItems,
      }),
    );
    const instant = this.#now();
    return this.#transaction(() => {
      const publisher = this.#one(
        this.#database.prepare("SELECT token_hash, revoked_at FROM publishers WHERE id = ?"),
        publisherId,
      );
      if (
        !publisher ||
        optionalString(publisher, "revoked_at") ||
        !hashesMatch(secret, publisher["token_hash"])
      ) {
        throw new Error("Dyna publisher credentials are invalid.");
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
              source_completed_at, source_completed_ms, request_hash, promoted, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
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
          this.#database
            .prepare("UPDATE publisher_items SET active = 0 WHERE publisher_id = ?")
            .run(publisherId);
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
            source_completed_at, source_completed_ms, request_hash, promoted, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
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
    body: string,
  ): z.infer<typeof DynaAnnotationSchema> {
    this.authorizeView(viewToken, itemId);
    const annotation = DynaAnnotationSchema.parse({
      id: randomUUID(),
      itemId,
      body,
      createdAt: this.#now(),
    });
    return this.#transaction(() => {
      this.#database
        .prepare("INSERT INTO annotations (id, item_id, body, created_at) VALUES (?, ?, ?, ?)")
        .run(annotation.id, annotation.itemId, annotation.body, annotation.createdAt);
      this.#touchDashboardsForItem(itemId);
      this.#audit("annotation.created", itemId);
      return annotation;
    });
  }

  addTodo(viewToken: string, input: DynaTodoInput, clientRequestId: string): string {
    const dashboardId = this.authorizeView(viewToken);
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
          throw new Error("Dyna rejected a to-do request ID reused with different content.");
        }
        return requiredString(previous, "item_id");
      }
      let mapping = this.#one(
        this.#database.prepare(
          "SELECT publisher_id FROM dashboard_manual_publishers WHERE dashboard_id = ?",
        ),
        dashboardId,
      );
      if (!mapping) {
        const publisherId = randomUUID();
        this.#database
          .prepare(
            `INSERT INTO publishers (
              id, name, token_hash, schedule_state, stale_after_minutes, last_run_status, created_at
            ) VALUES (?, ?, ?, 'unknown', 43200, 'never', ?)`,
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
        const parent = this.#one(
          this.#database.prepare(`
            SELECT 1 AS present FROM publisher_items pi
            JOIN dashboard_publishers dp ON dp.publisher_id = pi.publisher_id
            WHERE dp.dashboard_id = ? AND pi.item_id = ? AND pi.active = 1
          `),
          dashboardId,
          parsed.followUpOfItemId,
        );
        if (!parent) throw new Error("The follow-up source is outside this dashboard view.");
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
          sha256(JSON.stringify(item)),
          instant,
        );
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
      return itemId;
    });
  }

  organizeItem(
    viewToken: string,
    itemId: string,
    action: "bump" | "lower" | "earlier" | "later",
    expectedRevision: number,
    expectedFingerprint: string,
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
      const group = this.#database
        .prepare(
          `${DYNA_ELIGIBLE_CTE}
          SELECT id, effective_priority, priority_position FROM positioned
          WHERE effective_priority = (
            SELECT effective_priority FROM positioned WHERE id = ?
          )
          AND completed_group = (
            SELECT completed_group FROM positioned WHERE id = ?
          )
          ORDER BY priority_position`,
        )
        .all(dashboardId, itemId, itemId) as SqlRow[];
      const index = group.findIndex((candidate) => requiredString(candidate, "id") === itemId);
      const target = group[index];
      if (!target) throw new Error("The Dyna item is no longer active.");
      const currentPriority = DynaPrioritySchema.parse(
        requiredString(target, "effective_priority"),
      );
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
          updateSequence.run(dashboardId, requiredString(candidate, "id"), position * 100, instant);
        });
      }
      this.#touchDashboards([dashboardId], instant);
      this.#audit(`item.organized.${action}`, itemId, instant);
      return { changed: true };
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
    const instant = this.#now();
    this.#transaction(() => {
      const base = this.#itemBaseRow(itemId);
      if (requiredString(base, "fingerprint") !== values.expectedFingerprint) {
        throw new Error("The Dyna item changed; retrieve its latest context before enrichment.");
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
          values.priority ?? null,
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
      const membership = this.#one(
        this.#database.prepare(`
          SELECT 1 AS present FROM publisher_items pi
          JOIN dashboard_publishers dp ON dp.publisher_id = pi.publisher_id
          WHERE dp.dashboard_id = ? AND pi.item_id = ? AND pi.active = 1
        `),
        dashboardId,
        itemId,
      );
      if (!membership) throw new Error("The Dyna item is outside this dashboard view.");
    }
    this.#database
      .prepare("UPDATE view_sessions SET expires_at = ? WHERE token_hash = ?")
      .run(new Date(this.#nowMs() + VIEW_TTL_MS).toISOString(), hash);
    return dashboardId;
  }

  snapshot(dashboardId: string, searchQuery = ""): DynaDashboardSnapshot {
    return this.#readTransaction(() => {
      const query = searchQuery.trim().slice(0, 500);
      const terms = [...new Set(query.toLocaleLowerCase().split(/\s+/u).filter(Boolean))].slice(
        0,
        12,
      );
      const searchClause = terms
        .map(
          () => `AND (
            instr(lower(
              COALESCE(title, '') || ' ' || COALESCE(summary, '') || ' ' ||
              COALESCE(source_ref, '') || ' ' || COALESCE(source_scope, '') || ' ' ||
              COALESCE(labels, '') || ' ' || COALESCE(people, '') || ' ' ||
              COALESCE(attention, '') || ' ' || COALESCE(plan, '') || ' ' ||
              COALESCE(next_steps, '') || ' ' || COALESCE(enrichment_summary, '') || ' ' ||
              COALESCE(enrichment_priority_reason, '') || ' ' ||
              COALESCE(enrichment_labels, '') || ' ' || COALESCE(enrichment_people, '') || ' ' ||
              COALESCE(enrichment_attention, '') || ' ' || COALESCE(enrichment_plan, '') || ' ' ||
              COALESCE(enrichment_next_steps, '')
            ), ?) > 0
            OR EXISTS (
              SELECT 1 FROM annotations a
              WHERE a.item_id = positioned.id AND instr(lower(a.body), ?) > 0
            )
            OR EXISTS (
              SELECT 1 FROM task_bindings t
              WHERE t.item_id = positioned.id AND instr(lower(
                t.title || ' ' || t.state || ' ' || COALESCE(t.outcome, '')
              ), ?) > 0
            )
          )`,
        )
        .join("\n");
      const searchValues = terms.flatMap((term) => [term, term, term]);
      const dashboard = this.getDashboard(dashboardId);
      const revisionRow = this.#one(
        this.#database.prepare("SELECT revision FROM dashboards WHERE id = ?"),
        dashboardId,
      );
      const countRow = this.#one(
        this.#database.prepare(`${DYNA_ELIGIBLE_CTE}
          SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN workflow_state <> 'completed' AND effective_priority = 'critical' THEN 1 ELSE 0 END), 0) AS critical,
            COALESCE(SUM(CASE WHEN workflow_state <> 'completed' AND effective_priority = 'high' THEN 1 ELSE 0 END), 0) AS high,
            COALESCE(SUM(CASE WHEN effective_leadership_score > 0 THEN 1 ELSE 0 END), 0) AS leadership,
            MAX(source_updated_at) AS newest
          FROM positioned WHERE 1 = 1 ${searchClause}`),
        dashboardId,
        ...searchValues,
      );
      if (!countRow) throw new Error("Dyna could not count dashboard items.");
      const rows = this.#database
        .prepare(
          `${DYNA_ELIGIBLE_CTE}
          SELECT * FROM positioned WHERE 1 = 1 ${searchClause}
          ORDER BY
            CASE effective_priority
              WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
            priority_position
          LIMIT 200`,
        )
        .all(dashboardId, ...searchValues) as SqlRow[];
      const cards = this.#cardsFromSnapshotRows(rows);
      const criticalCount = requiredNumber(countRow, "critical");
      const highCount = requiredNumber(countRow, "high");
      const leadershipCount = requiredNumber(countRow, "leadership");
      const newest = optionalString(countRow, "newest");
      const schedules = this.listPublishers(dashboardId);
      const activeSchedules = schedules.filter((schedule) => schedule.scheduleState === "active");
      const scheduleFreshness = activeSchedules.map((schedule) => {
        if (
          schedule.lastRunStatus === "failed" ||
          schedule.lastRunStatus === "partial" ||
          !schedule.lastRunAt
        )
          return "stale" as const;
        const age = Math.max(0, this.#nowMs() - Date.parse(schedule.lastRunAt));
        const staleAfter = schedule.staleAfterMinutes * 60_000;
        return age > staleAfter
          ? ("stale" as const)
          : age > staleAfter * 0.75
            ? ("aging" as const)
            : ("fresh" as const);
      });
      const unscheduledAge = newest
        ? Math.max(0, this.#nowMs() - Date.parse(newest))
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
        schema: "dyna/snapshot-v3",
        dashboard,
        generatedAt: this.#now(),
        query,
        revision: revisionRow ? requiredNumber(revisionRow, "revision") : 0,
        freshness,
        counts: {
          critical: criticalCount,
          high: highCount,
          leadership: leadershipCount,
          total: requiredNumber(countRow, "total"),
        },
        schedules,
        cards,
      });
    });
  }

  snapshotForView(viewToken: string, query = ""): DynaDashboardSnapshot {
    return this.snapshot(this.authorizeView(viewToken), query);
  }

  itemContext(itemId: string): DynaItemContext {
    return DynaItemContextSchema.parse({
      ...this.#item(itemId),
      annotations: this.#annotations(itemId),
    });
  }

  prepareAction(
    viewToken: string,
    kind: DynaActionKind,
    values: {
      readonly itemId: string;
      readonly taskId?: string;
      readonly taskHostId?: string;
      readonly expectedRevision: number;
      readonly expectedFingerprint: string;
      readonly idempotencyKey: string;
    },
  ): z.infer<typeof DynaActionRequestSchema> {
    DynaActionKindSchema.parse(kind);
    const dashboardId = this.authorizeView(viewToken, values.itemId);
    const result = this.#transaction<
      z.infer<typeof DynaActionRequestSchema> | { readonly error: string }
    >(() => {
      const instant = this.#now();
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
      if (kind === "open_codex_task" || kind === "refresh_codex_status") {
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
        if (!linked) throw new Error("The Codex task is not linked to this Dyna item.");
      } else if (values.taskId || values.taskHostId) {
        throw new Error("This Dyna action cannot target an existing Codex task.");
      }

      if (kind === "create_codex_task") {
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
    if ("error" in result) throw new Error(result.error);
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
  ): z.infer<typeof DynaActionRequestSchema> {
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
    return this.#actionFromRow(row);
  }

  claimAction(requestId: string): ClaimedDynaAction {
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
        requiredString(requestRow, "kind") === "create_codex_task" &&
        requiredString(requestRow, "state") === "delivered" &&
        requiredString(requestRow, "expires_at") > instant &&
        !this.#taskBindingCapacityAvailable(itemId)
      ) {
        this.#database
          .prepare(
            `UPDATE action_requests SET state = 'failed', failure_message = ?,
               uncertain_effect = 0, claim_token_hash = NULL, claim_expires_at = NULL,
               updated_at = ? WHERE id = ? AND state = 'delivered'`,
          )
          .run(
            "The linked Codex task limit was reached before creation started.",
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
          ...(request.taskId && request.taskHostId && request.itemId
            ? { task: this.#task(request.itemId, request.taskId, request.taskHostId) }
            : {}),
        },
      };
    });
    if ("error" in result) throw new Error(result.error);
    return result;
  }

  completeAction(
    requestId: string,
    claimToken: string,
    result:
      | { readonly outcome: "succeeded"; readonly task?: DynaTaskStatus }
      | {
          readonly outcome: "failed" | "needs_reconciliation";
          readonly failureMessage: string;
        },
  ): z.infer<typeof DynaActionRequestSchema> {
    const publicFailureMessage =
      result.outcome === "succeeded"
        ? undefined
        : sanitizePublicFailureMessage(result.failureMessage);
    return this.#transaction(() => {
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
        if ((kind === "create_codex_task" || kind === "refresh_codex_status") && !result.task) {
          throw new Error("The successful Dyna action requires controller-reported task metadata.");
        }
        if ((kind === "open_codex_task" || kind === "open_source") && result.task) {
          throw new Error("Opening a Dyna target cannot attach task metadata.");
        }
        if (
          kind === "refresh_codex_status" &&
          result.task &&
          (result.task.taskId !== optionalString(row, "task_id") ||
            result.task.hostId !== optionalString(row, "host_id"))
        ) {
          throw new Error("The refreshed Codex task does not match the claimed request.");
        }
        if (result.task) {
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
  }

  resolveActionReconciliation(
    requestId: string,
    resolution:
      | { readonly outcome: "task_linked"; readonly task: DynaTaskStatus }
      | { readonly outcome: "no_task_created"; readonly explanation: string },
  ): z.infer<typeof DynaActionRequestSchema> {
    const publicExplanation =
      resolution.outcome === "no_task_created"
        ? sanitizePublicFailureMessage(resolution.explanation)
        : undefined;
    return this.#transaction(() => {
      const row = this.#one(
        this.#database.prepare(
          `SELECT * FROM action_requests WHERE id = ? AND kind = 'create_codex_task'
             AND state = 'needs_reconciliation' AND uncertain_effect = 1`,
        ),
        requestId,
      );
      if (!row) throw new Error("The Dyna task creation is not awaiting reconciliation.");
      const itemId = optionalString(row, "item_id");
      if (!itemId) throw new Error("The Dyna action has no item to reconcile.");
      const instant = this.#now();
      if (resolution.outcome === "task_linked") {
        this.#upsertTaskStatus(itemId, resolution.task, requestId);
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

  #taskBindingCapacityAvailable(itemId: string, excludedClaimRequestId?: string): boolean {
    const taskCount = this.#one(
      this.#database.prepare("SELECT COUNT(*) AS total FROM task_bindings WHERE item_id = ?"),
      itemId,
    );
    const reservationCount = this.#one(
      this.#database.prepare(
        `SELECT COUNT(*) AS total FROM action_requests
         WHERE item_id = ? AND kind = 'create_codex_task'
           AND (state = 'claimed' OR
             (state = 'needs_reconciliation' AND uncertain_effect = 1))
           AND (? IS NULL OR id <> ?)`,
      ),
      itemId,
      excludedClaimRequestId ?? null,
      excludedClaimRequestId ?? null,
    );
    if (!taskCount || !reservationCount) {
      throw new Error("Dyna could not determine linked Codex task capacity.");
    }
    return (
      requiredNumber(taskCount, "total") + requiredNumber(reservationCount, "total") <
      MAX_TASK_BINDINGS_PER_ITEM
    );
  }

  #actionFromRow(row: SqlRow): z.infer<typeof DynaActionRequestSchema> {
    return DynaActionRequestSchema.parse({
      id: requiredString(row, "id"),
      kind: requiredString(row, "kind"),
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

  upsertTaskStatus(itemId: string, status: DynaTaskStatus): void {
    this.#transaction(() => {
      this.#upsertTaskStatus(itemId, status);
    });
  }

  #upsertTaskStatus(
    itemId: string,
    status: DynaTaskStatus,
    reservedCreateRequestId?: string,
  ): void {
    const parsed = DynaTaskStatusSchema.parse(status);
    this.#itemBaseRow(itemId);
    const statusTime = normalizeTimestamp(parsed.statusUpdatedAt, true);
    const observedTime = normalizeTimestamp(parsed.observedAt, true);
    const existing = this.#one(
      this.#database.prepare(
        "SELECT title, state, outcome, status_updated_ms, observed_ms FROM task_bindings WHERE item_id = ? AND task_id = ? AND host_id = ?",
      ),
      itemId,
      parsed.taskId,
      parsed.hostId,
    );
    if (!existing && !this.#taskBindingCapacityAvailable(itemId, reservedCreateRequestId)) {
      throw new Error("A Dyna item cannot link more than eight Codex tasks.");
    }
    if (
      existing &&
      observedTime.epoch > requiredNumber(existing, "observed_ms") &&
      statusTime.epoch === requiredNumber(existing, "status_updated_ms") &&
      (parsed.state !== requiredString(existing, "state") ||
        parsed.title !== requiredString(existing, "title") ||
        parsed.outcome !== optionalString(existing, "outcome"))
    ) {
      throw new Error("Dyna rejected conflicting Codex task data at the same status timestamp.");
    }
    const changed = this.#database
      .prepare(
        `
        INSERT INTO task_bindings (
          item_id, task_id, host_id, project_id, title, state,
          status_updated_at, status_updated_ms, observed_at, observed_ms, outcome
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(item_id, task_id, host_id) DO UPDATE SET
          project_id = excluded.project_id, title = excluded.title, state = excluded.state,
          status_updated_at = excluded.status_updated_at,
          status_updated_ms = excluded.status_updated_ms,
          observed_at = excluded.observed_at, observed_ms = excluded.observed_ms,
          outcome = excluded.outcome
        WHERE excluded.observed_ms > task_bindings.observed_ms
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
    if (changed === 1) this.#touchDashboardsForItem(itemId);
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
    const row = this.#one(this.#database.prepare("SELECT * FROM items WHERE id = ?"), itemId);
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

  #item(itemId: string): Omit<DynaItemContext, "annotations"> {
    const row = this.#itemBaseRow(itemId);
    const enrichment = this.#one(
      this.#database.prepare("SELECT * FROM item_enrichments WHERE item_id = ?"),
      itemId,
    );
    return this.#mergeItem(row, enrichment);
  }

  #mergeItem(row: SqlRow, enrichment?: SqlRow): Omit<DynaItemContext, "annotations"> {
    const itemId = requiredString(row, "id");
    const base = this.#baseItem(row);
    if (!enrichment) {
      return { ...base, id: itemId, fingerprint: requiredString(row, "fingerprint") };
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
      fingerprint: requiredString(row, "fingerprint"),
      enrichment: {
        state: enrichmentActive ? "active" : "stale",
        appliedAt: requiredString(enrichment, "applied_at"),
        baseSourceUpdatedAt: requiredString(enrichment, "base_source_updated_at"),
        provenance: requiredString(enrichment, "provenance"),
        version: requiredNumber(enrichment, "version"),
      },
    };
  }

  #itemFromSnapshotRow(row: SqlRow): Omit<DynaItemContext, "annotations"> {
    const enrichment = optionalString(row, "enrichment_base_fingerprint")
      ? {
          summary: row["enrichment_summary"],
          priority: row["enrichment_priority"],
          priority_reason: row["enrichment_priority_reason"],
          due_at: row["enrichment_due_at"],
          due_at_set: row["enrichment_due_at_set"],
          labels: row["enrichment_labels"],
          people: row["enrichment_people"],
          attention: row["enrichment_attention"],
          plan: row["enrichment_plan"],
          next_steps: row["enrichment_next_steps"],
          base_fingerprint: row["enrichment_base_fingerprint"],
          base_source_updated_at: row["enrichment_base_source_updated_at"],
          applied_at: row["enrichment_applied_at"],
          provenance: row["enrichment_provenance"],
          version: row["enrichment_version"],
        }
      : undefined;
    return this.#mergeItem(row, enrichment);
  }

  #annotations(itemId: string): z.infer<typeof DynaAnnotationSchema>[] {
    return (
      this.#database
        .prepare("SELECT * FROM annotations WHERE item_id = ? ORDER BY created_at DESC LIMIT 20")
        .all(itemId) as SqlRow[]
    ).map((annotation) =>
      DynaAnnotationSchema.parse({
        id: requiredString(annotation, "id"),
        itemId,
        body: requiredString(annotation, "body"),
        createdAt: requiredString(annotation, "created_at"),
      }),
    );
  }

  #actionItemContext(itemId: string): z.infer<typeof DynaActionItemContextSchema> {
    const item = this.#item(itemId);
    return DynaActionItemContextSchema.parse({
      id: itemId,
      title: item.title,
      sourceRef: item.sourceRef,
      sourceUpdatedAt: item.sourceUpdatedAt,
      annotations: this.#annotations(itemId),
      trustBoundary: "untrusted_reference_data",
    });
  }

  #cardsFromSnapshotRows(rows: readonly SqlRow[]): DynaCard[] {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => requiredString(row, "id"));
    const placeholders = ids.map(() => "?").join(", ");
    const annotationRows = this.#database
      .prepare(
        `SELECT * FROM (
           SELECT *, ROW_NUMBER() OVER (
             PARTITION BY item_id ORDER BY created_at DESC, id
           ) AS item_rank
           FROM annotations WHERE item_id IN (${placeholders})
         ) WHERE item_rank <= 20 ORDER BY item_id, created_at DESC`,
      )
      .all(...ids) as SqlRow[];
    const taskRows = this.#database
      .prepare(
        `SELECT * FROM (
           SELECT *, ROW_NUMBER() OVER (
             PARTITION BY item_id ORDER BY observed_ms DESC, task_id, host_id
           ) AS item_rank
           FROM task_bindings WHERE item_id IN (${placeholders})
         ) WHERE item_rank <= 8 ORDER BY item_id, observed_ms DESC`,
      )
      .all(...ids) as SqlRow[];
    const annotations = new Map<string, z.infer<typeof DynaAnnotationSchema>[]>();
    for (const annotation of annotationRows) {
      const itemId = requiredString(annotation, "item_id");
      const values = annotations.get(itemId) ?? [];
      values.push(
        DynaAnnotationSchema.parse({
          id: requiredString(annotation, "id"),
          itemId,
          body: requiredString(annotation, "body"),
          createdAt: requiredString(annotation, "created_at"),
        }),
      );
      annotations.set(itemId, values);
    }
    const tasks = new Map<string, DynaTaskStatus[]>();
    for (const task of taskRows) {
      const itemId = requiredString(task, "item_id");
      const values = tasks.get(itemId) ?? [];
      values.push(this.#taskFromRow(task));
      tasks.set(itemId, values);
    }
    return rows.map((row) => {
      const id = requiredString(row, "id");
      const item = this.#itemFromSnapshotRow(row);
      const sourcePriority = DynaPrioritySchema.parse(requiredString(row, "priority"));
      const leadershipScore = dynaLeadershipScore(item.people);
      const linkedTasks = tasks.get(id) ?? [];
      const workflowState = requiredWorkflowState(row);
      const completedTask =
        workflowState === "completed"
          ? linkedTasks.find((task) => task.state === "succeeded")
          : undefined;
      const leadershipPriority = effectiveDynaPriority(item.priority, item.people);
      const storedPriority = optionalString(row, "preference_priority");
      const manualPriority = storedPriority ? DynaPrioritySchema.parse(storedPriority) : undefined;
      const sequenceValue = row["preference_sequence"];
      return {
        id,
        fingerprint: item.fingerprint,
        source: item.sourceRef.source,
        sourceRef: item.sourceRef,
        sourceLabel: dynaSourceLabel(item.sourceRef),
        title: item.title,
        summary: item.summary,
        sourcePriority,
        priority: manualPriority ?? leadershipPriority,
        priorityReason: item.priorityReason,
        sourceUpdatedAt: item.sourceUpdatedAt,
        ...(item.dueAt ? { dueAt: item.dueAt } : {}),
        labels: item.labels,
        people: item.people,
        leadershipScore,
        priorityMode: manualPriority
          ? "manual"
          : leadershipPriority !== item.priority
            ? "leadership"
            : item.priority !== sourcePriority
              ? "enrichment"
              : "source",
        ...(typeof sequenceValue === "number" ? { sequence: sequenceValue } : {}),
        canMoveEarlier: requiredNumber(row, "priority_position") > 1,
        canMoveLater:
          requiredNumber(row, "priority_position") < requiredNumber(row, "priority_count"),
        workflowState,
        ...(workflowState === "completed" && completedTask?.outcome
          ? { outcome: completedTask.outcome }
          : {}),
        ...(optionalString(row, "follow_up_of_item_id")
          ? { followUpOfItemId: optionalString(row, "follow_up_of_item_id") }
          : {}),
        ...(item.attention ? { attention: item.attention } : {}),
        plan: item.plan,
        nextSteps: item.nextSteps,
        ...(item.enrichment ? { enrichmentState: item.enrichment.state } : {}),
        annotations: annotations.get(id) ?? [],
        linkedTasks,
      };
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
        WHERE pi.item_id = ? AND pi.active = 1
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

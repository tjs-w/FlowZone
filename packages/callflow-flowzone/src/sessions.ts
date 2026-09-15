import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";

import {
  CallFlowSourceExcerptSchema,
  CallFlowUiPayloadSchema,
  MAX_INITIAL_GRAPH_BYTES,
  MAX_SOURCE_EXCERPT_BYTES,
  type CallFlowSourceExcerpt,
  type CallFlowUiPayload,
  type EvidenceSource,
  type GraphSnapshot,
  type WorkflowManifest,
} from "@callflow/contracts";
import { CallFlowError, RepositoryPolicy, sha256 } from "@callflow/node";

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_CAPABILITY_TTL_MS = 15 * 60 * 1_000;
const DEFAULT_SOURCE_BYTE_BUDGET = 64 * 1024;
const MAXIMUM_SESSIONS = 8;
const MAXIMUM_SESSION_BYTES = 32 * 1024 * 1024;

interface StoredSession {
  readonly id: string;
  readonly repositoryRoot: string;
  readonly manifest: WorkflowManifest;
  snapshot: GraphSnapshot;
  readonly createdAt: number;
  expiresAt: number;
  capabilityDigest?: Buffer;
  capabilityExpiresAt?: number;
  sourceGrant?: SourceGrant;
  sourceByteBudget: number;
  serializedBytes: number;
}

interface SourceGrant {
  readonly evidenceId: string;
  readonly path: string;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly contentDigest: string;
  readonly purpose: string;
  readonly maximumBytes: number;
  readonly expiresAt: number;
  readonly repositoryRevision: string;
  readonly graphRevision: string;
  used: boolean;
}

export interface AuthorizedSession {
  readonly session: StoredSession;
}

export interface SessionAuthorization {
  readonly sessionId: string;
  readonly capabilityToken: string;
  readonly graphRevision: string;
}

export interface SourceRequest extends SessionAuthorization {
  readonly evidenceId: string;
  readonly purpose: string;
  readonly maxBytes: number;
}

export interface SessionStoreOptions {
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly createToken?: () => string;
  readonly repositoryPolicy?: RepositoryPolicy;
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function utf8Prefix(buffer: Buffer, maximumBytes: number): string {
  if (buffer.byteLength <= maximumBytes)
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  let end = maximumBytes;
  while (end > 0) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

type SourceSpan = Extract<EvidenceSource, { readonly type: "source-span" }>;

export function sliceSourceSpan(sourceText: string, span: SourceSpan): string {
  const lines = sourceText.split(/\r?\n/);
  if (span.start.line > lines.length || span.end.line > lines.length) {
    throw new CallFlowError("source_changed", "The recorded source span is no longer available.");
  }
  const selected = lines.slice(span.start.line - 1, span.end.line);
  const first = selected[0];
  const last = selected.at(-1);
  if (first === undefined || last === undefined) return "";
  const startOffset = Math.min(span.start.column - 1, first.length);
  const endOffset = Math.min(span.end.column - 1, last.length);
  if (selected.length === 1) return first.slice(startOffset, Math.max(startOffset, endOffset));
  selected[0] = first.slice(startOffset);
  selected[selected.length - 1] = last.slice(0, endOffset);
  return selected.join("\n");
}

export class CallFlowSessionStore {
  readonly #sessions = new Map<string, StoredSession>();
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #createToken: () => string;
  readonly #repositoryPolicy: RepositoryPolicy;
  #serializedBytes = 0;

  constructor(options: SessionStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? randomUUID;
    this.#createToken = options.createToken ?? (() => randomBytes(32).toString("base64url"));
    this.#repositoryPolicy = options.repositoryPolicy ?? new RepositoryPolicy();
  }

  create(repositoryRoot: string, manifest: WorkflowManifest, snapshot: GraphSnapshot): string {
    const serializedBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    if (serializedBytes > MAX_INITIAL_GRAPH_BYTES) {
      throw new CallFlowError("output_too_large", "The CallFlow graph exceeds the session limit.");
    }
    const now = this.#now();
    this.#removeExpired(now);
    let id = this.#createId();
    while (this.#sessions.has(id)) id = this.#createId();
    const session: StoredSession = {
      id,
      repositoryRoot,
      manifest,
      snapshot,
      createdAt: now,
      expiresAt: now + DEFAULT_SESSION_TTL_MS,
      sourceByteBudget: DEFAULT_SOURCE_BYTE_BUDGET,
      serializedBytes,
    };
    this.#sessions.set(id, session);
    this.#serializedBytes += serializedBytes;
    this.#evictToLimits();
    return id;
  }

  getForModel(sessionId: string, graphRevision: string): StoredSession {
    const session = this.#get(sessionId);
    if (session.snapshot.id !== graphRevision) {
      throw new CallFlowError(
        "source_changed",
        "The CallFlow graph changed; use its current revision.",
      );
    }
    return session;
  }

  authorize(input: SessionAuthorization): StoredSession {
    const session = this.getForModel(input.sessionId, input.graphRevision);
    const now = this.#now();
    if (
      !session.capabilityDigest ||
      session.capabilityExpiresAt === undefined ||
      session.capabilityExpiresAt <= now
    ) {
      throw new CallFlowError("unavailable", "The CallFlow capability expired; reopen the view.");
    }
    const candidate = tokenDigest(input.capabilityToken);
    if (
      candidate.byteLength !== session.capabilityDigest.byteLength ||
      !timingSafeEqual(candidate, session.capabilityDigest)
    ) {
      throw new CallFlowError("path_denied", "The CallFlow capability is invalid.");
    }
    return session;
  }

  issuePayload(sessionId: string): CallFlowUiPayload {
    const session = this.#get(sessionId);
    const token = this.#createToken();
    if (token.length < 32) {
      throw new CallFlowError("invalid_output", "The capability token generator is invalid.");
    }
    const expiresAtMs = this.#now() + DEFAULT_CAPABILITY_TTL_MS;
    session.capabilityDigest = tokenDigest(token);
    session.capabilityExpiresAt = expiresAtMs;
    delete session.sourceGrant;
    return CallFlowUiPayloadSchema.parse({
      schema: "callflow/ui-payload-v1",
      sessionId: session.id,
      capability: {
        token,
        expiresAt: new Date(expiresAtMs).toISOString(),
        repositoryRevision: session.snapshot.repository.commit,
        graphRevision: session.snapshot.id,
        sourceByteBudget: session.sourceByteBudget,
      },
      snapshot: session.snapshot,
    });
  }

  replaceSnapshot(sessionId: string, snapshot: GraphSnapshot): CallFlowUiPayload {
    const session = this.#get(sessionId);
    if (
      snapshot.repository.identity !== session.snapshot.repository.identity ||
      snapshot.workflowManifestId !== session.snapshot.workflowManifestId
    ) {
      throw new CallFlowError("invalid_output", "A refreshed graph changed session identity.");
    }
    const serializedBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    if (serializedBytes > MAX_INITIAL_GRAPH_BYTES) {
      throw new CallFlowError("output_too_large", "The refreshed graph exceeds the session limit.");
    }
    this.#serializedBytes -= session.serializedBytes;
    session.snapshot = snapshot;
    session.serializedBytes = serializedBytes;
    this.#serializedBytes += serializedBytes;
    return this.issuePayload(sessionId);
  }

  async source(request: SourceRequest, signal?: AbortSignal): Promise<CallFlowSourceExcerpt> {
    if (!request.purpose.trim() || request.purpose.length > 256) {
      throw new CallFlowError("invalid_input", "A bounded source-access purpose is required.");
    }
    if (
      !Number.isInteger(request.maxBytes) ||
      request.maxBytes < 1 ||
      request.maxBytes > MAX_SOURCE_EXCERPT_BYTES
    ) {
      throw new CallFlowError(
        "invalid_input",
        `Source requests are limited to ${String(MAX_SOURCE_EXCERPT_BYTES)} bytes.`,
      );
    }
    const session = this.authorize(request);
    const evidence = session.snapshot.evidence.find((item) => item.id === request.evidenceId);
    if (evidence?.source.type !== "source-span") {
      throw new CallFlowError("not_found", "The selected source evidence is unavailable.");
    }
    const grant = session.sourceGrant;
    if (grant) {
      if (
        grant.used ||
        grant.evidenceId !== evidence.id ||
        grant.path !== evidence.source.path ||
        grant.startLine !== evidence.source.start.line ||
        grant.startColumn !== evidence.source.start.column ||
        grant.endLine !== evidence.source.end.line ||
        grant.endColumn !== evidence.source.end.column ||
        grant.contentDigest !== evidence.contentDigest ||
        grant.purpose !== request.purpose ||
        grant.maximumBytes !== request.maxBytes ||
        grant.repositoryRevision !== session.snapshot.repository.commit ||
        grant.graphRevision !== session.snapshot.id ||
        grant.expiresAt !== session.capabilityExpiresAt
      ) {
        throw new CallFlowError(
          "path_denied",
          "This capability is already bound to a different exact source request.",
        );
      }
    } else {
      if (session.capabilityExpiresAt === undefined) {
        throw new CallFlowError("unavailable", "The CallFlow capability is unavailable.");
      }
      session.sourceGrant = {
        evidenceId: evidence.id,
        path: evidence.source.path,
        startLine: evidence.source.start.line,
        startColumn: evidence.source.start.column,
        endLine: evidence.source.end.line,
        endColumn: evidence.source.end.column,
        contentDigest: evidence.contentDigest,
        purpose: request.purpose,
        maximumBytes: request.maxBytes,
        expiresAt: session.capabilityExpiresAt,
        repositoryRevision: session.snapshot.repository.commit,
        graphRevision: session.snapshot.id,
        used: false,
      };
    }
    const activeGrant = session.sourceGrant;
    if (!activeGrant || activeGrant.used) {
      throw new CallFlowError("path_denied", "The exact source capability was already consumed.");
    }
    // Reserve this exact grant before asynchronous repository access so two
    // concurrent app requests cannot reuse one authorization.
    activeGrant.used = true;
    const currentRepository = await this.#repositoryPolicy.resolveRepository(
      session.repositoryRoot,
      signal,
    );
    if (
      currentRepository.revision.commit !== session.snapshot.repository.commit ||
      currentRepository.revision.dirtyDigest !== session.snapshot.repository.dirtyDigest
    ) {
      throw new CallFlowError("source_changed", "The repository changed; refresh CallFlow first.");
    }
    const source = await this.#repositoryPolicy.readSource(
      session.repositoryRoot,
      evidence.source.path,
      signal,
    );
    if (sha256(source) !== evidence.contentDigest) {
      throw new CallFlowError("source_changed", "The source changed; refresh CallFlow first.");
    }
    if (activeGrant.expiresAt <= this.#now()) {
      throw new CallFlowError("unavailable", "The exact source capability expired.");
    }
    let sourceText: string;
    try {
      sourceText = new TextDecoder("utf-8", { fatal: true }).decode(source);
    } catch {
      throw new CallFlowError("path_denied", "The selected source is not valid UTF-8 text.");
    }
    const fullExcerpt = sliceSourceSpan(sourceText, evidence.source);
    const fullBytes = Buffer.from(fullExcerpt, "utf8");
    const maximumBytes = Math.min(activeGrant.maximumBytes, session.sourceByteBudget);
    if (maximumBytes < 1) {
      throw new CallFlowError("path_denied", "The CallFlow source byte budget is exhausted.");
    }
    const content = utf8Prefix(fullBytes, maximumBytes);
    const consumed = Buffer.byteLength(content, "utf8");
    session.sourceByteBudget -= consumed;
    return CallFlowSourceExcerptSchema.parse({
      schema: "callflow/source-v1",
      evidenceId: evidence.id,
      path: evidence.source.path,
      startLine: evidence.source.start.line,
      endLine: evidence.source.end.line,
      content,
      truncated: consumed < fullBytes.byteLength,
      remainingByteBudget: session.sourceByteBudget,
    });
  }

  get size(): number {
    this.#removeExpired(this.#now());
    return this.#sessions.size;
  }

  #get(sessionId: string): StoredSession {
    const now = this.#now();
    const session = this.#sessions.get(sessionId);
    if (!session || session.expiresAt <= now) {
      if (session) this.#delete(session);
      throw new CallFlowError(
        "unavailable",
        "The CallFlow session expired; rediscover the workflow.",
      );
    }
    session.expiresAt = now + DEFAULT_SESSION_TTL_MS;
    this.#sessions.delete(session.id);
    this.#sessions.set(session.id, session);
    this.#removeExpired(now);
    return session;
  }

  #removeExpired(now: number): void {
    for (const session of this.#sessions.values()) {
      if (session.expiresAt <= now) this.#delete(session);
    }
  }

  #evictToLimits(): void {
    while (
      this.#sessions.size > MAXIMUM_SESSIONS ||
      this.#serializedBytes > MAXIMUM_SESSION_BYTES
    ) {
      const oldest: StoredSession | undefined = this.#sessions.values().next().value;
      if (!oldest) return;
      this.#delete(oldest);
    }
  }

  #delete(session: StoredSession): void {
    if (!this.#sessions.delete(session.id)) return;
    this.#serializedBytes -= session.serializedBytes;
    session.capabilityDigest?.fill(0);
  }
}

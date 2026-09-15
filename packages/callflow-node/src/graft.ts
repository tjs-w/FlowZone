import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";

import {
  RepositoryRelativePathSchema,
  type AdapterRevision,
  type DiscoveredEdgeDraft,
  type DiscoveredEvidenceDraft,
  type DiscoveredNodeDraft,
  type EvidenceReferenceSlice,
  type GraphWarning,
  type RepositoryRevision,
  type WorkflowAnchor,
} from "@callflow/contracts";
import { compareStableStrings } from "@callflow/core";
import { z } from "zod";

import { CallFlowError, asCallFlowError } from "./errors.js";
import {
  resolveExecutable,
  runBoundedProcess,
  type ProcessResult,
  type ProcessRunner,
} from "./process.js";
import { RepositoryPolicy, isWithinRoot, sha256, type RepositoryContext } from "./repository.js";

const GRAFT_CANDIDATES = [
  "/opt/homebrew/bin/graft",
  "/usr/local/bin/graft",
  "/usr/bin/graft",
  "C:\\Program Files\\Graft\\graft.exe",
] as const;
const RIPGREP_CANDIDATES = [
  "/opt/homebrew/bin/rg",
  "/usr/local/bin/rg",
  "/usr/bin/rg",
  "C:\\Program Files\\ripgrep\\rg.exe",
] as const;
const SUPPORTED_GRAFT_VERSION = /^0\.18\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const MAX_GRAFT_JSON_BYTES = 8 * 1024 * 1024;
const MAX_GRAFT_INDEX_BYTES = 64 * 1024 * 1024;
const GRAFT_INDEX_CHUNK_BYTES = 64 * 1024;
const GRAFT_INDEX_RELATIVE_PATH = "graft/.graph/wiring.json";

const GraftFreshnessSectionSchema = z
  .object({
    ok: z.boolean(),
    missing: z.boolean().optional(),
    added: z.array(z.unknown()).optional(),
    removed: z.array(z.unknown()).optional(),
    changed: z.array(z.unknown()).optional(),
    stale: z.array(z.unknown()).optional(),
    pending: z.number().int().nonnegative().optional(),
  })
  .loose();
const GraftCheckSchema = z
  .object({
    context: GraftFreshnessSectionSchema.optional(),
    graph: GraftFreshnessSectionSchema,
  })
  .loose();
const GraftSymbolSchema = z
  .object({
    id: z.string().min(1).max(4_096),
    name: z.string().min(1).max(1_024),
    kind: z.string().min(1).max(128),
    path: RepositoryRelativePathSchema,
    span: z.string().regex(/^L\d+(?:-L?\d+)?$/),
  })
  .loose();
const GraftHitSchema = GraftSymbolSchema.extend({
  relation: z.string().min(1).max(128),
  depth: z.number().int().positive().max(128),
});
const GraftCallersSchema = z
  .object({
    query: z.string().max(4_096),
    matches: z
      .array(
        z
          .object({
            symbol: GraftSymbolSchema,
            hits: z.array(GraftHitSchema).max(25_000),
          })
          .loose(),
      )
      .max(1_024),
  })
  .loose();
const RipgrepEventSchema = z
  .object({
    type: z.string(),
    data: z.unknown().optional(),
  })
  .loose();
const RipgrepMatchDataSchema = z
  .object({
    path: z.object({ text: z.string().min(1).max(4_096) }).loose(),
    lines: z.object({ text: z.string().max(256 * 1024) }).loose(),
    line_number: z.number().int().positive(),
    submatches: z
      .array(
        z
          .object({
            start: z.number().int().nonnegative(),
            end: z.number().int().positive(),
          })
          .loose(),
      )
      .min(1),
  })
  .loose();

const BoundedTextSchema = z.string().max(64 * 1024);
const GraftSpanSchema = z.string().regex(/^L\d+(?:-L?\d+)?$/);
const GraftSavingsSchema = z
  .object({
    files: z.number().int().nonnegative(),
    baselineChars: z.number().int().nonnegative(),
  })
  .loose();
const GraftMapHubSchema = z
  .object({
    name: z.string().min(1).max(1_024),
    kind: z.string().min(1).max(128),
    path: RepositoryRelativePathSchema,
    span: GraftSpanSchema,
    inDegree: z.number().int().nonnegative(),
  })
  .loose();
const GraftMapDirectorySchema = z
  .object({
    path: RepositoryRelativePathSchema,
    files: z.number().int().nonnegative(),
    symbols: z.number().int().nonnegative(),
    languages: z.array(z.string().min(1).max(128)).max(256),
    hubs: z.array(GraftMapHubSchema).max(1_024),
    isFile: z.boolean(),
  })
  .loose();
const GraftMapScopeSchema = z
  .object({
    scope: z.string().min(1).max(2_048),
    dirs: z.array(GraftMapDirectorySchema).max(10_000),
    dropped: z.number().int().nonnegative(),
  })
  .loose();
const GraftMapSchema = z
  .object({
    totals: z
      .object({
        files: z.number().int().nonnegative(),
        symbols: z.number().int().nonnegative(),
        edges: z.number().int().nonnegative(),
        languages: z.array(z.string().min(1).max(128)).max(256),
      })
      .loose(),
    dirs: z.array(GraftMapDirectorySchema).max(10_000),
    scopes: z.array(GraftMapScopeSchema).max(1_024).optional(),
    hotspots: z.array(GraftMapHubSchema).max(10_000),
    dropped: z.number().int().nonnegative(),
    saved: GraftSavingsSchema.optional(),
  })
  .loose();

const GraftAskPointerSchema = z
  .string()
  .min(1)
  .max(4_096)
  .superRefine((pointer, context) => {
    const match = /^(.*?)(?::(L\d+(?:-L?\d+)?))?$/.exec(pointer);
    if (!match?.[1] || !RepositoryRelativePathSchema.safeParse(match[1]).success) {
      context.addIssue({
        code: "custom",
        message: "Expected a repository-relative Graft pointer.",
      });
    }
  });
const GraftAskHitSchema = z
  .object({
    kind: z.enum(["concept", "symbol", "caller", "callee"]),
    title: z.string().min(1).max(2_048),
    pointer: GraftAskPointerSchema,
    snippet: BoundedTextSchema,
    relation: z.string().min(1).max(128).optional(),
    related: z.array(z.string().min(1).max(4_096)).max(10_000).optional(),
    score: z.number(),
    code: BoundedTextSchema.optional(),
    scope: z.string().max(2_048).optional(),
  })
  .loose();
const GraftAskSchema = z
  .object({
    query: z.string().max(4_096),
    mode: z.enum(["structural", "lexical", "empty"]),
    subject: z.string().max(4_096).optional(),
    hits: z.array(GraftAskHitSchema).max(25_000),
    note: BoundedTextSchema.optional(),
    saved: GraftSavingsSchema.optional(),
    coverage: z.number().min(0).max(1).optional(),
    coverageStrong: z.number().min(0).max(1).optional(),
  })
  .loose();

const GraftGrepSymbolSchema = z
  .object({
    id: z.string().min(1).max(4_096),
    name: z.string().min(1).max(1_024),
    kind: z.string().min(1).max(128),
    path: RepositoryRelativePathSchema,
    span: GraftSpanSchema,
  })
  .loose();
const GraftGrepSchema = z
  .object({
    pattern: z.string().max(4_096),
    filesSearched: z.number().int().nonnegative(),
    totalHits: z.number().int().nonnegative(),
    groups: z
      .array(
        z
          .object({
            symbol: GraftGrepSymbolSchema.nullable(),
            path: RepositoryRelativePathSchema,
            inDegree: z.number().int().nonnegative(),
            hits: z
              .array(
                z
                  .object({
                    line: z.number().int().positive(),
                    text: z.string().max(1_024),
                  })
                  .loose(),
              )
              .max(25_000),
          })
          .loose(),
      )
      .max(25_000),
    truncated: z.union([
      z.boolean(),
      z
        .object({
          files: z.number().int().nonnegative(),
          hits: z.number().int().nonnegative(),
        })
        .loose(),
    ]),
    saved: GraftSavingsSchema.optional(),
  })
  .loose();
const GraftSkeletonSchema = z
  .object({
    file: RepositoryRelativePathSchema,
    entries: z
      .array(
        z
          .object({
            name: z.string().min(1).max(1_024),
            kind: z.string().min(1).max(128),
            span: GraftSpanSchema,
            signature: z.string().max(8_192).nullable(),
            summary: BoundedTextSchema.optional(),
          })
          .loose(),
      )
      .max(25_000),
    note: BoundedTextSchema.optional(),
    saved: GraftSavingsSchema.optional(),
  })
  .loose();

type GraftSymbol = z.infer<typeof GraftSymbolSchema>;

export interface GraftAdapterStatus {
  readonly schema: "callflow/adapter-status-v1";
  readonly state: "ready" | "stale" | "incompatible" | "unavailable" | "failed";
  readonly compatible: boolean;
  readonly fresh: boolean;
  readonly repository: RepositoryRevision;
  readonly adapter: AdapterRevision;
  readonly detail: string;
}

export interface DiscoveredGraphDraft {
  readonly repository: RepositoryRevision;
  readonly adapter: AdapterRevision;
  readonly evidence: DiscoveredEvidenceDraft[];
  readonly nodes: DiscoveredNodeDraft[];
  readonly edges: DiscoveredEdgeDraft[];
  readonly warnings: GraphWarning[];
  readonly extraction: EvidenceReferenceSlice;
  readonly runtimeEvidence: EvidenceReferenceSlice;
}

export interface GraftAdapterOptions {
  readonly graftExecutable?: string;
  readonly ripgrepExecutable?: string;
  readonly runner?: ProcessRunner;
  readonly repositoryPolicy?: RepositoryPolicy;
}

export interface DiscoverDraftOptions {
  readonly anchors: readonly WorkflowAnchor[];
  readonly exclusions?: readonly string[];
  readonly depth: number;
  readonly maximumNodes: number;
  readonly signal?: AbortSignal;
}

export type GraftReadCommand = "map" | "ask" | "grep" | "skeleton";

export interface GraftReadRequest {
  readonly command: GraftReadCommand;
  readonly value?: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

function safeKey(prefix: string, value: string): string {
  return `${prefix}_${sha256(value).slice("sha256:".length, 33)}`;
}

export function utf8ByteOffsetToSourceColumn(text: string, byteOffset: number): number {
  if (!Number.isInteger(byteOffset) || byteOffset < 0) {
    throw new CallFlowError("invalid_output", "ripgrep returned an invalid UTF-8 byte offset.");
  }
  let consumedBytes = 0;
  let consumedCodeUnits = 0;
  for (const character of text) {
    if (consumedBytes === byteOffset) return consumedCodeUnits + 1;
    consumedBytes += Buffer.byteLength(character, "utf8");
    consumedCodeUnits += character.length;
    if (consumedBytes > byteOffset) {
      throw new CallFlowError(
        "invalid_output",
        "ripgrep returned an offset inside a UTF-8 character.",
      );
    }
  }
  if (consumedBytes === byteOffset) return consumedCodeUnits + 1;
  throw new CallFlowError("invalid_output", "ripgrep returned an out-of-range byte offset.");
}

type CompiledExclusion =
  | { readonly type: "exact"; readonly value: string }
  | { readonly type: "prefix"; readonly value: string }
  | { readonly type: "basename-suffix"; readonly value: string };

function compileExclusions(patterns: readonly string[]): readonly CompiledExclusion[] {
  return patterns.map((rawPattern) => {
    const pattern = rawPattern.trim();
    if (pattern.endsWith("/**") && !pattern.slice(0, -3).includes("*")) {
      const prefix = pattern.slice(0, -3);
      if (RepositoryRelativePathSchema.safeParse(prefix).success) {
        return { type: "prefix", value: prefix };
      }
    } else if (pattern.startsWith("**/*")) {
      const suffix = pattern.slice(4);
      if (
        suffix.length > 0 &&
        !suffix.includes("*") &&
        !suffix.includes("/") &&
        !suffix.includes("\\") &&
        !suffix.includes("\0")
      ) {
        return { type: "basename-suffix", value: suffix };
      }
    } else if (!pattern.includes("*") && RepositoryRelativePathSchema.safeParse(pattern).success) {
      return { type: "exact", value: pattern };
    }
    throw new CallFlowError(
      "invalid_manifest",
      `Unsupported safe path exclusion: ${pattern.slice(0, 120)}.`,
    );
  });
}

function matchesCompiledExclusion(
  repositoryPath: string,
  exclusions: readonly CompiledExclusion[],
): boolean {
  return exclusions.some((exclusion) => {
    if (exclusion.type === "exact") return repositoryPath === exclusion.value;
    if (exclusion.type === "prefix") {
      return repositoryPath === exclusion.value || repositoryPath.startsWith(`${exclusion.value}/`);
    }
    const slash = repositoryPath.lastIndexOf("/");
    const basename = slash < 0 ? repositoryPath : repositoryPath.slice(slash + 1);
    return basename.endsWith(exclusion.value);
  });
}

export function isExcludedRepositoryPath(
  repositoryPath: string,
  patterns: readonly string[],
): boolean {
  const path = RepositoryRelativePathSchema.parse(repositoryPath);
  return matchesCompiledExclusion(path, compileExclusions(patterns));
}

export function isGraftGraphReady(section: z.infer<typeof GraftFreshnessSectionSchema>): boolean {
  return (
    section.ok &&
    section.missing !== true &&
    (section.added?.length ?? 0) === 0 &&
    (section.removed?.length ?? 0) === 0 &&
    (section.changed?.length ?? 0) === 0 &&
    (section.stale?.length ?? 0) === 0
  );
}

export function parseGraftSpan(span: string): {
  start: { line: number; column: number };
  end: { line: number; column: number };
} {
  const match = /^L(\d+)(?:-L?(\d+))?$/.exec(span);
  if (!match?.[1]) throw new CallFlowError("invalid_output", "Graft returned an invalid span.");
  const startLine = Number.parseInt(match[1], 10);
  const endLine = Number.parseInt(match[2] ?? match[1], 10);
  return {
    start: { line: startLine, column: 1 },
    // Graft 0.18 reports line-only spans. The contract records that explicitly
    // as a bounded open end; disclosure clamps it to the actual line length.
    end: { line: endLine, column: 10_000_000 },
  };
}

function nodeKind(kind: string): "package" | "class" | "function" {
  if (kind === "class" || kind === "interface" || kind === "struct") return "class";
  if (kind === "package" || kind === "module" || kind === "namespace") return "package";
  return "function";
}

function anchorsForSymbol(
  anchors: readonly WorkflowAnchor[],
  symbol: GraftSymbol,
): readonly WorkflowAnchor[] {
  return anchors.filter((anchor) => {
    if (anchor.selector.type === "symbol") {
      return (
        anchor.selector.value === symbol.name || symbol.id.endsWith(`#${anchor.selector.value}`)
      );
    }
    if (anchor.selector.type === "path") return anchor.selector.path === symbol.path;
    return false;
  });
}

function isTraversalBoundary(anchor: WorkflowAnchor): boolean {
  return (
    anchor.nodeKind === "terminal" ||
    anchor.role === "sink" ||
    anchor.role === "table" ||
    anchor.role === "queue" ||
    anchor.role === "external-integration"
  );
}

function parseJson<T>(schema: z.ZodType<T>, stdout: string, producer: string): T {
  let candidate: unknown;
  try {
    candidate = JSON.parse(stdout);
  } catch {
    throw new CallFlowError("invalid_output", `${producer} returned malformed JSON.`);
  }
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    throw new CallFlowError("invalid_output", `${producer} returned an unsupported JSON shape.`);
  }
  return parsed.data;
}

export function parseGraftReadResponse(command: GraftReadCommand, stdout: string): unknown {
  switch (command) {
    case "map":
      return parseJson(GraftMapSchema, stdout, "Graft map");
    case "ask":
      return parseJson(GraftAskSchema, stdout, "Graft ask");
    case "grep":
      return parseJson(GraftGrepSchema, stdout, "Graft grep");
    case "skeleton":
      return parseJson(GraftSkeletonSchema, stdout, "Graft skeleton");
  }
}

function throwIfIndexFingerprintAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new CallFlowError("aborted", "The Graft index fingerprint was cancelled.", true);
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

/**
 * Hash the exact structural index consumed by Graft 0.18 traversal commands.
 *
 * CallFlow intentionally does not hash `graft check` output: two different
 * fresh wiring graphs can produce the same status document. The fixed default
 * index path is safe because CallFlow never passes `--dir` or GRAFT_DIR to its
 * constrained Graft subprocess environment.
 */
export async function fingerprintGraftIndex(
  repository: RepositoryContext,
  signal?: AbortSignal,
): Promise<`sha256:${string}` | undefined> {
  const graftDirectory = resolve(repository.root, "graft");
  const graphDirectory = resolve(graftDirectory, ".graph");
  const indexPath = resolve(repository.root, GRAFT_INDEX_RELATIVE_PATH);
  if (!isWithinRoot(repository.root, indexPath)) {
    throw new CallFlowError("path_denied", "The Graft index path escapes the repository.");
  }

  let indexIdentity: Awaited<ReturnType<typeof lstat>>;
  try {
    for (const directory of [graftDirectory, graphDirectory]) {
      throwIfIndexFingerprintAborted(signal);
      const details = await lstat(directory);
      if (!details.isDirectory() || details.isSymbolicLink()) {
        throw new CallFlowError("path_denied", "The Graft index directory is unsafe.");
      }
    }
    throwIfIndexFingerprintAborted(signal);
    indexIdentity = await lstat(indexPath);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return undefined;
    if (error instanceof CallFlowError) throw error;
    throw new CallFlowError("adapter_failed", "The Graft index identity is unavailable.", true);
  }
  if (
    !indexIdentity.isFile() ||
    indexIdentity.isSymbolicLink() ||
    indexIdentity.size < 1 ||
    indexIdentity.size > MAX_GRAFT_INDEX_BYTES
  ) {
    throw new CallFlowError("adapter_failed", "The Graft index exceeds its safe read boundary.");
  }

  throwIfIndexFingerprintAborted(signal);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(indexPath);
  } catch {
    throw new CallFlowError("adapter_failed", "The Graft index path changed before opening.", true);
  }
  if (!isWithinRoot(repository.root, canonicalPath)) {
    throw new CallFlowError("path_denied", "The Graft index resolves outside the repository.");
  }

  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(canonicalPath, constants.O_RDONLY | noFollow).catch(() => {
    throw new CallFlowError("adapter_failed", "The Graft index could not be opened safely.", true);
  });
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.dev !== indexIdentity.dev ||
      before.ino !== indexIdentity.ino ||
      before.size !== indexIdentity.size
    ) {
      throw new CallFlowError("adapter_failed", "The Graft index changed before hashing.", true);
    }

    const digest = createHash("sha256");
    digest.update("callflow:graft-index-v1\0", "utf8");
    const buffer = Buffer.allocUnsafe(GRAFT_INDEX_CHUNK_BYTES);
    let position = 0;
    while (position < before.size) {
      throwIfIndexFingerprintAborted(signal);
      const requestedBytes = Math.min(buffer.byteLength, before.size - position);
      const { bytesRead } = await handle.read(buffer, 0, requestedBytes, position);
      if (bytesRead < 1) {
        throw new CallFlowError("adapter_failed", "The Graft index changed while hashing.", true);
      }
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    throwIfIndexFingerprintAborted(signal);
    const after = await handle.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new CallFlowError("adapter_failed", "The Graft index changed while hashing.", true);
    }
    const currentPath = await realpath(indexPath).catch(() => undefined);
    if (currentPath !== canonicalPath || !isWithinRoot(repository.root, currentPath)) {
      throw new CallFlowError(
        "adapter_failed",
        "The Graft index path changed while hashing.",
        true,
      );
    }
    return `sha256:${digest.digest("hex")}`;
  } finally {
    await handle.close();
  }
}

export class GraftAdapter {
  readonly #graftExecutable: string | undefined;
  readonly #ripgrepExecutable: string | undefined;
  readonly #runner: ProcessRunner;
  readonly #repositoryPolicy: RepositoryPolicy;

  constructor(options: GraftAdapterOptions = {}) {
    this.#graftExecutable = options.graftExecutable;
    this.#ripgrepExecutable = options.ripgrepExecutable;
    this.#runner = options.runner ?? runBoundedProcess;
    this.#repositoryPolicy =
      options.repositoryPolicy ?? new RepositoryPolicy({ runner: this.#runner });
  }

  async status(repositoryPath: string, signal?: AbortSignal): Promise<GraftAdapterStatus> {
    const repository = await this.#repositoryPolicy.resolveRepository(repositoryPath, signal);
    return await this.statusForRepository(repository, signal);
  }

  async build(
    repositoryPath: string,
    lsp = false,
    signal?: AbortSignal,
  ): Promise<GraftAdapterStatus> {
    const repository = await this.#repositoryPolicy.resolveRepository(repositoryPath, signal);
    const executable = this.#graftExecutable ?? (await resolveExecutable(GRAFT_CANDIDATES));
    const versionResult = await this.#runner({
      executable,
      args: ["--version"],
      cwd: repository.root,
      ...(signal ? { signal } : {}),
      maximumOutputBytes: 4_096,
    });
    if (
      versionResult.exitCode !== 0 ||
      !SUPPORTED_GRAFT_VERSION.test(versionResult.stdout.trim())
    ) {
      throw new CallFlowError("adapter_incompatible", "CallFlow requires Graft 0.18.x.");
    }
    const buildResult = await this.#runner({
      executable,
      args: [
        "build",
        "--no-gitignore",
        "--no-ignore",
        ...(lsp ? ["--lsp"] : []),
        "--",
        repository.root,
      ],
      cwd: repository.root,
      ...(signal ? { signal } : {}),
      maximumOutputBytes: MAX_GRAFT_JSON_BYTES,
    });
    if (buildResult.exitCode !== 0) {
      throw new CallFlowError("adapter_failed", "Graft could not build its local index.", true);
    }
    return await this.statusForRepository(repository, signal);
  }

  async readJson(repositoryPath: string, request: GraftReadRequest): Promise<unknown> {
    const repository = await this.#repositoryPolicy.resolveRepository(
      repositoryPath,
      request.signal,
    );
    const status = await this.statusForRepository(repository, request.signal);
    if (status.state !== "ready") {
      throw new CallFlowError("adapter_stale", status.detail, status.state !== "incompatible");
    }
    const executable = this.#graftExecutable ?? (await resolveExecutable(GRAFT_CANDIDATES));
    const args: string[] = [request.command];
    if (request.command === "ask") {
      if (!request.value) throw new CallFlowError("invalid_input", "Graft ask requires a query.");
      args.push(
        "--limit",
        String(request.limit ?? 8),
        "--json",
        "--no-refresh",
        "--",
        request.value,
      );
    } else if (request.command === "grep") {
      if (!request.value)
        throw new CallFlowError("invalid_input", "Graft grep requires a pattern.");
      args.push("--fixed", "--json", "--no-refresh", "--", request.value);
    } else if (request.command === "skeleton") {
      if (!request.value)
        throw new CallFlowError("invalid_input", "Graft skeleton requires a file.");
      const parsedPath = RepositoryRelativePathSchema.safeParse(request.value);
      if (!parsedPath.success) {
        throw new CallFlowError(
          "invalid_input",
          "Graft skeleton requires a repository-relative path.",
        );
      }
      args.push("--json", "--no-refresh", "--", parsedPath.data);
    } else {
      args.push("--json", "--no-refresh", "--");
    }
    args.push(repository.root);
    const result = await this.#runner({
      executable,
      args,
      cwd: repository.root,
      ...(request.signal ? { signal: request.signal } : {}),
      maximumOutputBytes: MAX_GRAFT_JSON_BYTES,
    });
    if (result.exitCode !== 0) {
      throw new CallFlowError("adapter_failed", `Graft ${request.command} failed.`, true);
    }
    return parseGraftReadResponse(request.command, result.stdout);
  }

  async statusForRepository(
    repository: RepositoryContext,
    signal?: AbortSignal,
  ): Promise<GraftAdapterStatus> {
    let executable: string;
    try {
      executable = this.#graftExecutable ?? (await resolveExecutable(GRAFT_CANDIDATES));
    } catch {
      return {
        schema: "callflow/adapter-status-v1",
        state: "unavailable",
        compatible: false,
        fresh: false,
        repository: repository.revision,
        adapter: { name: "graft", version: "unavailable", indexRevision: "unavailable" },
        detail: "Graft is not installed at a trusted executable path.",
      };
    }
    const versionResult = await this.#runner({
      executable,
      args: ["--version"],
      cwd: repository.root,
      ...(signal ? { signal } : {}),
      maximumOutputBytes: 4_096,
    });
    const version = versionResult.stdout.trim();
    if (versionResult.exitCode !== 0 || !SUPPORTED_GRAFT_VERSION.test(version)) {
      return {
        schema: "callflow/adapter-status-v1",
        state: "incompatible",
        compatible: false,
        fresh: false,
        repository: repository.revision,
        adapter: {
          name: "graft",
          version: version || "unknown",
          indexRevision: "unavailable",
        },
        detail: "CallFlow requires Graft 0.18.x.",
      };
    }
    const check = await this.#runner({
      executable,
      // Graft 0.18 `check` is intrinsically read-only and does not accept the
      // `--no-refresh` flag supported by traversal/read commands.
      args: ["check", "--json", "--", repository.root],
      cwd: repository.root,
      ...(signal ? { signal } : {}),
      maximumOutputBytes: MAX_GRAFT_JSON_BYTES,
    });
    let freshness: z.infer<typeof GraftCheckSchema>;
    try {
      freshness = parseJson(GraftCheckSchema, check.stdout, "Graft");
    } catch {
      return {
        schema: "callflow/adapter-status-v1",
        state: "failed",
        compatible: true,
        fresh: false,
        repository: repository.revision,
        adapter: { name: "graft", version, indexRevision: "failed" },
        detail:
          check.exitCode === 0
            ? "Graft returned an unsupported graph-index response."
            : "Graft could not inspect its graph index.",
      };
    }
    // Graft 0.18 can exit nonzero to report index drift while still returning
    // a valid check document. Static traversal readiness depends only on the
    // graph index itself. Context coverage and pending semantic summaries are
    // not prerequisites for callers/callees extraction.
    let indexRevision: `sha256:${string}` | undefined;
    try {
      indexRevision = await fingerprintGraftIndex(repository, signal);
    } catch (error: unknown) {
      const failure = asCallFlowError(error);
      if (failure.code === "aborted") throw failure;
      return {
        schema: "callflow/adapter-status-v1",
        state: "failed",
        compatible: true,
        fresh: false,
        repository: repository.revision,
        adapter: { name: "graft", version, indexRevision: "failed" },
        detail: "Graft is available, but its structural index could not be fingerprinted safely.",
      };
    }
    const fresh = isGraftGraphReady(freshness.graph) && indexRevision !== undefined;
    return {
      schema: "callflow/adapter-status-v1",
      state: fresh ? "ready" : "stale",
      compatible: true,
      fresh,
      repository: repository.revision,
      adapter: { name: "graft", version, indexRevision: indexRevision ?? "unavailable" },
      detail: fresh
        ? "Graft 0.18.x is available and its graph index is fresh."
        : indexRevision === undefined
          ? "Graft is available, but its structural graph index is missing."
          : "Graft is available, but its graph index is stale.",
    };
  }

  async discoverDraft(
    repository: RepositoryContext,
    options: DiscoverDraftOptions,
  ): Promise<DiscoveredGraphDraft> {
    const exclusionPatterns = options.exclusions ?? [];
    const exclusions = compileExclusions(exclusionPatterns);
    const isExcluded = (path: string): boolean => matchesCompiledExclusion(path, exclusions);
    const status = await this.statusForRepository(repository, options.signal);
    if (status.state !== "ready") {
      return await this.#discoverSourceLiterals(repository, status, options);
    }
    const executable = this.#graftExecutable ?? (await resolveExecutable(GRAFT_CANDIDATES));
    const symbols = new Map<string, { symbol: GraftSymbol; ambiguous: boolean }>();
    const calls = new Map<
      string,
      {
        source: string;
        target: string;
        path: string;
        span: string;
        occurrence: number;
      }
    >();
    const stagesBySymbol = new Map<string, Set<string>>();
    const warnings: GraphWarning[] = [];
    let nodeLimitReached = false;
    let queryFailed = false;
    const queue: {
      query: string;
      expectedId?: string;
      remainingDepth: number;
      anchorId?: string;
      stageId?: string;
    }[] = [];
    for (const anchor of options.anchors) {
      if (anchor.selector.type !== "symbol") continue;
      queue.push({
        query: anchor.selector.value,
        remainingDepth: isTraversalBoundary(anchor) ? 0 : options.depth,
        anchorId: anchor.id,
        ...(anchor.stageId ? { stageId: anchor.stageId } : {}),
      });
    }
    const queried = new Set<string>();
    while (queue.length > 0 && symbols.size < options.maximumNodes) {
      const next = queue.shift();
      if (!next) break;
      const queryIdentity = `${next.expectedId ?? next.query}:${next.stageId ?? ""}:${String(next.remainingDepth)}`;
      if (queried.has(queryIdentity)) continue;
      queried.add(queryIdentity);
      let result: ProcessResult;
      try {
        result = await this.#runner({
          executable,
          args: [
            "callers",
            "--direction",
            "out",
            "--depth",
            "1",
            "--json",
            "--no-refresh",
            "--",
            next.query,
            repository.root,
          ],
          cwd: repository.root,
          ...(options.signal ? { signal: options.signal } : {}),
          maximumOutputBytes: MAX_GRAFT_JSON_BYTES,
        });
      } catch (error: unknown) {
        const failure = asCallFlowError(error);
        queryFailed = true;
        warnings.push({
          code: "graft-query-failed",
          message: `Graft could not extract a requested symbol (${failure.code}).`,
          retryable: failure.retryable,
          ...(next.anchorId ? { relatedIds: [next.anchorId] } : {}),
        });
        continue;
      }
      if (result.exitCode !== 0) {
        queryFailed = true;
        warnings.push({
          code: "graft-query-failed",
          message: `Graft could not resolve a requested symbol at depth ${String(options.depth - next.remainingDepth)}.`,
          retryable: true,
          ...(next.anchorId ? { relatedIds: [next.anchorId] } : {}),
        });
        continue;
      }
      let response: z.infer<typeof GraftCallersSchema>;
      try {
        response = parseJson(GraftCallersSchema, result.stdout, "Graft");
      } catch {
        queryFailed = true;
        warnings.push({
          code: "graft-query-failed",
          message: "Graft returned a schema-invalid callers response.",
          retryable: false,
          ...(next.anchorId ? { relatedIds: [next.anchorId] } : {}),
        });
        continue;
      }
      const matchingResponses = (
        next.expectedId
          ? response.matches.filter((match) => match.symbol.id === next.expectedId)
          : response.matches
      ).sort((left, right) => compareStableStrings(left.symbol.id, right.symbol.id));
      const ambiguous = matchingResponses.length > 1;
      for (const match of matchingResponses) {
        if (isExcluded(match.symbol.path)) continue;
        if (symbols.size >= options.maximumNodes && !symbols.has(match.symbol.id)) {
          nodeLimitReached = true;
          continue;
        }
        symbols.set(match.symbol.id, { symbol: match.symbol, ambiguous });
        if (next.stageId) {
          const stages = stagesBySymbol.get(match.symbol.id) ?? new Set<string>();
          stages.add(next.stageId);
          stagesBySymbol.set(match.symbol.id, stages);
        }
        if (next.remainingDepth === 0) continue;
        const orderedHits = [...match.hits].sort((left, right) =>
          compareStableStrings(
            `${left.id}\0${left.relation}\0${String(left.depth)}\0${left.path}\0${left.span}`,
            `${right.id}\0${right.relation}\0${String(right.depth)}\0${right.path}\0${right.span}`,
          ),
        );
        const relationshipOccurrences = new Map<string, number>();
        for (const hit of orderedHits) {
          if (isExcluded(hit.path)) continue;
          if (symbols.size >= options.maximumNodes && !symbols.has(hit.id)) {
            nodeLimitReached = true;
            continue;
          }
          symbols.set(hit.id, { symbol: hit, ambiguous: false });
          if (next.stageId) {
            const stages = stagesBySymbol.get(hit.id) ?? new Set<string>();
            stages.add(next.stageId);
            stagesBySymbol.set(hit.id, stages);
          }
          if (hit.relation === "calls" && hit.depth === 1) {
            const relationshipIdentity = `${match.symbol.id}\0${hit.id}\0${hit.path}\0${hit.span}`;
            const occurrence = (relationshipOccurrences.get(relationshipIdentity) ?? 0) + 1;
            relationshipOccurrences.set(relationshipIdentity, occurrence);
            calls.set(`${relationshipIdentity}\0${String(occurrence)}`, {
              source: match.symbol.id,
              target: hit.id,
              path: hit.path,
              span: hit.span,
              occurrence,
            });
            const hitIsBoundary = anchorsForSymbol(options.anchors, hit).some(isTraversalBoundary);
            if (next.remainingDepth > 1 && !hitIsBoundary) {
              queue.push({
                query: hit.name,
                expectedId: hit.id,
                remainingDepth: next.remainingDepth - 1,
                ...(next.stageId ? { stageId: next.stageId } : {}),
              });
            }
          }
        }
      }
    }

    if (queue.length > 0 && symbols.size >= options.maximumNodes) nodeLimitReached = true;

    const evidence: DiscoveredEvidenceDraft[] = [];
    const nodes: DiscoveredNodeDraft[] = [];
    const assignedAnchors = new Set<string>();
    for (const { symbol, ambiguous } of [...symbols.values()]
      .sort((left, right) => compareStableStrings(left.symbol.id, right.symbol.id))
      .slice(0, options.maximumNodes)) {
      const nodeKey = safeKey("node", symbol.id);
      const evidenceKey = safeKey("evidence", symbol.id);
      let digest: `sha256:${string}`;
      let state: "exact" | "ambiguous" | "stale" = ambiguous ? "ambiguous" : "exact";
      let details: string | undefined;
      try {
        digest = sha256(
          await this.#repositoryPolicy.readSource(repository.root, symbol.path, options.signal),
        );
      } catch (error: unknown) {
        const failure = asCallFlowError(error);
        if (failure.code === "aborted") throw failure;
        digest = sha256(`${symbol.id}:${repository.revision.commit}`);
        state = "stale";
        details = "The indexed source file is no longer readable at the recorded path.";
      }
      evidence.push({
        key: evidenceKey,
        kind: "graft-exact",
        state,
        revision: repository.revision.commit,
        source: {
          type: "source-span",
          path: symbol.path,
          ...parseGraftSpan(symbol.span),
          symbol: symbol.id,
        },
        contentDigest: digest,
        producer: { name: "graft", version: status.adapter.version },
        ...(details ? { details } : {}),
      });
      const matchingAnchors = anchorsForSymbol(options.anchors, symbol);
      const candidateAnchor = matchingAnchors.find(
        (candidate) => !assignedAnchors.has(candidate.id),
      );
      const anchor =
        candidateAnchor && !assignedAnchors.has(candidateAnchor.id) ? candidateAnchor : undefined;
      if (anchor) assignedAnchors.add(anchor.id);
      const explicitStages = new Set(
        matchingAnchors.flatMap((candidate) => candidate.stageId ?? []),
      );
      const propagatedStages = stagesBySymbol.get(symbol.id) ?? new Set<string>();
      const resolvedStageId =
        explicitStages.size === 1
          ? [...explicitStages][0]
          : explicitStages.size === 0 && propagatedStages.size === 1
            ? [...propagatedStages][0]
            : undefined;
      if (explicitStages.size > 1 || (explicitStages.size === 0 && propagatedStages.size > 1)) {
        warnings.push({
          code: "stage-conflict",
          message: `Conflicting workflow origins left ${symbol.name.slice(0, 120)} ungrouped.`,
          retryable: false,
        });
      }
      nodes.push({
        key: nodeKey,
        ...(anchor ? { anchorId: anchor.id } : {}),
        kind: anchor?.nodeKind ?? nodeKind(symbol.kind),
        label: symbol.name,
        level: "L1",
        ...(resolvedStageId ? { stageId: resolvedStageId } : {}),
        qualifiedName: symbol.id,
        evidenceKeys: [evidenceKey],
        attributes: { graftKind: symbol.kind },
      });
    }

    const retainedSymbols = new Set(
      [...symbols.keys()].filter((id) => nodes.some((node) => node.key === safeKey("node", id))),
    );
    const edges: DiscoveredEdgeDraft[] = [];
    for (const call of [...calls.values()].sort((left, right) =>
      compareStableStrings(
        `${left.source}\0${left.target}\0${left.path}\0${left.span}\0${String(left.occurrence).padStart(8, "0")}`,
        `${right.source}\0${right.target}\0${right.path}\0${right.span}\0${String(right.occurrence).padStart(8, "0")}`,
      ),
    )) {
      if (!retainedSymbols.has(call.source) || !retainedSymbols.has(call.target)) continue;
      const relationshipIdentity = `${call.source}\0${call.target}\0${call.path}\0${call.span}\0${String(call.occurrence)}`;
      const relationshipEvidenceKey = safeKey("relation-evidence", relationshipIdentity);
      evidence.push({
        key: relationshipEvidenceKey,
        kind: "graft-exact",
        state: "exact",
        revision: repository.revision.commit,
        source: {
          type: "external-reference",
          system: "Graft 0.18 graph",
          reference: `callers-relation:${sha256(relationshipIdentity)}`,
        },
        contentDigest: sha256(`calls\0${relationshipIdentity}`),
        producer: { name: "graft", version: status.adapter.version },
        details:
          "Graft reported this exact symbol-to-symbol call relationship; Graft 0.18 does not expose its callsite span.",
      });
      edges.push({
        key: safeKey("edge", `${relationshipIdentity}\0direct-call`),
        sourceKey: safeKey("node", call.source),
        targetKey: safeKey("node", call.target),
        kind: "direct-call",
        assertion: "static-possible",
        evidenceKeys: [relationshipEvidenceKey],
      });
    }
    if (edges.length > 0) {
      warnings.push({
        code: "callsite-span-unavailable",
        message:
          "Graft 0.18 reports exact symbol relationships but does not expose callsite spans.",
        retryable: false,
      });
    }
    if (nodeLimitReached) {
      warnings.push({
        code: "node-limit",
        message: `Discovery was limited to ${String(options.maximumNodes)} nodes.`,
        retryable: false,
      });
    }
    return {
      repository: repository.revision,
      adapter: status.adapter,
      evidence,
      nodes,
      edges,
      warnings,
      extraction: queryFailed
        ? { status: "failed", code: "graft-query-failed", retryable: true }
        : { status: "succeeded", items: evidence.map((item) => item.key) },
      runtimeEvidence: {
        status: "unavailable",
        reason: "Runtime evidence is disabled in CallFlow v1.",
      },
    };
  }

  async #discoverSourceLiterals(
    repository: RepositoryContext,
    status: GraftAdapterStatus,
    options: DiscoverDraftOptions,
  ): Promise<DiscoveredGraphDraft> {
    let executable: string;
    try {
      executable = this.#ripgrepExecutable ?? (await resolveExecutable(RIPGREP_CANDIDATES));
    } catch {
      return {
        repository: repository.revision,
        adapter: status.adapter,
        evidence: [],
        nodes: [],
        edges: [],
        warnings: [
          {
            code: "adapter-unavailable",
            message: `${status.detail} Fixed-string fallback search is also unavailable.`,
            retryable: true,
          },
        ],
        extraction: {
          status: "unavailable",
          reason: "Graft and fixed-string fallback extraction are unavailable.",
        },
        runtimeEvidence: {
          status: "unavailable",
          reason: "Runtime evidence is disabled in CallFlow v1.",
        },
      };
    }
    const evidence: DiscoveredEvidenceDraft[] = [];
    const nodes: DiscoveredNodeDraft[] = [];
    const seen = new Set<string>();
    const assignedAnchors = new Set<string>();
    let nodeLimitReached = false;
    let fallbackFailure: EvidenceReferenceSlice | undefined;
    for (const anchor of options.anchors) {
      const query =
        anchor.selector.type === "symbol" || anchor.selector.type === "text"
          ? anchor.selector.type === "symbol"
            ? anchor.selector.value
            : anchor.selector.query
          : undefined;
      if (!query) continue;
      let result: ProcessResult;
      try {
        result = await this.#runner({
          executable,
          args: [
            "--json",
            "--line-number",
            "--column",
            "--fixed-strings",
            "--sort",
            "path",
            "--max-count",
            "20",
            "--glob",
            "!graft/**",
            "--glob",
            "!*.generated.json",
            "--",
            query,
            repository.root,
          ],
          cwd: repository.root,
          ...(options.signal ? { signal: options.signal } : {}),
          maximumOutputBytes: 2 * 1024 * 1024,
        });
      } catch (error: unknown) {
        const failure = asCallFlowError(error);
        const unavailable = failure.code === "unavailable" || failure.code === "process_failed";
        const nextFailure: EvidenceReferenceSlice = unavailable
          ? { status: "unavailable", reason: "Fixed-string extraction is unavailable." }
          : { status: "failed", code: "source-literal-query-failed", retryable: failure.retryable };
        if (!fallbackFailure || nextFailure.status === "failed") fallbackFailure = nextFailure;
        continue;
      }
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        fallbackFailure = {
          status: "failed",
          code: "source-literal-query-failed",
          retryable: true,
        };
        continue;
      }
      const matches: {
        readonly path: string;
        readonly line: number;
        readonly startByte: number;
        readonly endByte: number;
        readonly startColumn: number;
        readonly endColumn: number;
      }[] = [];
      try {
        for (const line of result.stdout.split("\n")) {
          if (!line) continue;
          const event = parseJson(RipgrepEventSchema, line, "ripgrep");
          if (event.type !== "match") continue;
          const parsedData = RipgrepMatchDataSchema.safeParse(event.data);
          if (!parsedData.success) {
            throw new CallFlowError(
              "invalid_output",
              "ripgrep returned an unsupported match shape.",
            );
          }
          const match = parsedData.data;
          const rawPath = match.path.text;
          const candidatePath = rawPath.startsWith(repository.root)
            ? relative(repository.root, rawPath).split("\\").join("/")
            : rawPath.split("\\").join("/");
          const pathResult = RepositoryRelativePathSchema.safeParse(candidatePath);
          if (!pathResult.success) {
            throw new CallFlowError(
              "invalid_output",
              "ripgrep returned a path outside the repository.",
            );
          }
          // Generated CallFlow snapshots are replaceable outputs, not repository
          // source. Excluding them here also keeps repeated refreshes byte-stable
          // when the source-literal fallback is active.
          if (pathResult.data.endsWith(".generated.json")) continue;
          if (isExcludedRepositoryPath(pathResult.data, options.exclusions ?? [])) continue;
          const submatch = match.submatches[0];
          if (!submatch) continue;
          const startColumn = utf8ByteOffsetToSourceColumn(match.lines.text, submatch.start);
          const endColumn = utf8ByteOffsetToSourceColumn(match.lines.text, submatch.end);
          matches.push({
            path: pathResult.data,
            line: match.line_number,
            startByte: submatch.start,
            endByte: submatch.end,
            startColumn,
            endColumn,
          });
        }
      } catch {
        fallbackFailure = {
          status: "failed",
          code: "source-literal-query-failed",
          retryable: false,
        };
        continue;
      }
      matches.sort((left, right) =>
        compareStableStrings(
          `${left.path}\0${String(left.line).padStart(10, "0")}\0${String(left.startByte).padStart(10, "0")}\0${String(left.endByte).padStart(10, "0")}`,
          `${right.path}\0${String(right.line).padStart(10, "0")}\0${String(right.startByte).padStart(10, "0")}\0${String(right.endByte).padStart(10, "0")}`,
        ),
      );
      for (const match of matches) {
        const identity = `${anchor.id}:${match.path}:${String(match.line)}:${String(match.startByte)}`;
        if (seen.has(identity)) continue;
        if (nodes.length >= options.maximumNodes) {
          nodeLimitReached = true;
          continue;
        }
        seen.add(identity);
        const evidenceKey = safeKey("evidence", identity);
        evidence.push({
          key: evidenceKey,
          kind: "source-literal",
          state: "exact",
          revision: repository.revision.commit,
          source: {
            type: "source-span",
            path: match.path,
            start: { line: match.line, column: match.startColumn },
            end: { line: match.line, column: match.endColumn },
            symbol: query,
          },
          contentDigest: sha256(
            await this.#repositoryPolicy.readSource(repository.root, match.path, options.signal),
          ),
          producer: { name: "source-literal", version: "1" },
          details:
            "A fixed-string match identifies this anchor but does not assert a call relationship.",
        });
        const mapsAnchor = !assignedAnchors.has(anchor.id);
        if (mapsAnchor) assignedAnchors.add(anchor.id);
        nodes.push({
          key: safeKey("node", identity),
          ...(mapsAnchor ? { anchorId: anchor.id } : {}),
          kind: anchor.nodeKind,
          label: anchor.label,
          level: "L1",
          ...(anchor.stageId ? { stageId: anchor.stageId } : {}),
          qualifiedName: query,
          evidenceKeys: [evidenceKey],
          attributes: { line: match.line },
        });
      }
    }
    return {
      repository: repository.revision,
      adapter: {
        name: "source-literal",
        version: "1",
        indexRevision: status.adapter.indexRevision,
      },
      evidence,
      nodes,
      edges: [],
      warnings: [
        {
          code: `graft-${status.state}`,
          message: `${status.detail} Fallback results contain anchors only and no synthesized call edges.`,
          retryable: status.state !== "incompatible",
        },
        ...(nodeLimitReached
          ? [
              {
                code: "node-limit",
                message: `Discovery was limited to ${String(options.maximumNodes)} nodes; narrow the selected anchors.`,
                retryable: false,
              },
            ]
          : []),
      ],
      extraction: fallbackFailure ?? {
        status: "succeeded",
        items: evidence.map((item) => item.key),
      },
      runtimeEvidence: {
        status: "unavailable",
        reason: "Runtime evidence is disabled in CallFlow v1.",
      },
    };
  }
}

export function safeAdapterFailure(error: unknown): GraphWarning {
  const failure = asCallFlowError(error);
  return {
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
  };
}

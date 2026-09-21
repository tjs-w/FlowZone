import { dirname, resolve } from "node:path";

import {
  GraphQuerySchema,
  GraphSnapshotSchema,
  MAX_NORMAL_EXPANSION_NODES,
  MAX_VISIBLE_NODES,
  WorkflowManifestSchema,
  type GraphQuery,
  type GraphSnapshot,
  type WorkflowManifest,
} from "@callflow/contracts";
import {
  buildGraphFromManifest,
  diffGraphSnapshots,
  exportHtml,
  exportMarkdown,
  exportMermaid,
  exportSvg,
  queryGraph,
  sanitizeGraphSnapshot,
  sanitizeExportBundle,
  sanitizeRepositoryIdentity,
  stableId,
} from "@callflow/core";

import { CallFlowError } from "./errors.js";
import { GraftAdapter, type GraftAdapterStatus } from "./graft.js";
import { generatedSnapshotPath, readBoundedJsonFile } from "./io.js";
import { RepositoryPolicy } from "./repository.js";

export type ExportFormat = "markdown" | "graph-json" | "bundle-json" | "mermaid" | "svg" | "html";

export interface DiscoverWorkflowRequest {
  readonly repositoryPath: string;
  readonly entries: readonly string[];
  readonly sink?: string;
  readonly name?: string;
  readonly depth?: number;
  readonly maximumNodes?: number;
  readonly signal?: AbortSignal;
}

export interface DiscoveredWorkflow {
  readonly manifest: WorkflowManifest;
  readonly snapshot: GraphSnapshot;
}

export interface CallFlowServiceOptions {
  readonly adapter?: GraftAdapter;
  readonly repositoryPolicy?: RepositoryPolicy;
}

export type CallFlowExtractionStatus = "succeeded" | "failed" | "unavailable";

export function graphExtractionStatus(snapshot: GraphSnapshot): CallFlowExtractionStatus {
  return snapshot.extraction?.status ?? "unavailable";
}

export function graphHasCompleteExtraction(snapshot: GraphSnapshot): boolean {
  return snapshot.adapter.name === "graft" && graphExtractionStatus(snapshot) === "succeeded";
}

export function graphHasHealthyEvidence(snapshot: GraphSnapshot): boolean {
  if (!graphHasCompleteExtraction(snapshot)) return false;
  return snapshot.evidence.every(
    (record) =>
      record.state !== "stale" && record.state !== "failed" && record.state !== "unavailable",
  );
}

function boundedDepth(value: number | undefined): number {
  if (value === undefined) return 2;
  if (!Number.isInteger(value) || value < 1 || value > 8) {
    throw new CallFlowError("invalid_input", "Discovery depth must be between 1 and 8.");
  }
  return value;
}

function boundedNodes(value: number | undefined): number {
  if (value === undefined) return 30;
  if (!Number.isInteger(value) || value < 1 || value > MAX_VISIBLE_NODES) {
    throw new CallFlowError(
      "invalid_input",
      `Discovery must contain between 1 and ${String(MAX_VISIBLE_NODES)} nodes.`,
    );
  }
  return value;
}

function boundedSymbol(value: string, field: string): string {
  const symbol = value.trim();
  if (!symbol || symbol.length > 1_024 || symbol.includes("\0") || /[\r\n]/.test(symbol)) {
    throw new CallFlowError("invalid_input", `The ${field} symbol is invalid.`);
  }
  return symbol;
}

function manifestForRequest(
  request: DiscoverWorkflowRequest,
  repositoryIdentity: string,
): WorkflowManifest {
  if (request.entries.length < 1 || request.entries.length > 16) {
    throw new CallFlowError("invalid_input", "Provide between 1 and 16 entry symbols.");
  }
  const entries = request.entries.map((entry) => boundedSymbol(entry, "entry"));
  const sink = request.sink ? boundedSymbol(request.sink, "sink") : undefined;
  const requestedName = request.name?.trim();
  const discoveryBounds = {
    depth: boundedDepth(request.depth),
    maximumNodes: boundedNodes(request.maximumNodes),
  };
  const identity = { repositoryIdentity, entries, sink: sink ?? "", discoveryBounds };
  const manifestId = stableId("manifest", identity);
  const anchors = [
    ...entries.map((entry, index) => ({
      id: `entry-${String(index + 1)}`,
      label: entry.slice(0, 240),
      role: "entry" as const,
      nodeKind: "function" as const,
      selector: { type: "symbol" as const, value: entry },
      stageId: "workflow",
    })),
    ...(sink
      ? [
          {
            id: "sink-1",
            label: sink.slice(0, 240),
            role: "sink" as const,
            nodeKind: "function" as const,
            selector: { type: "symbol" as const, value: sink },
            stageId: "workflow",
          },
        ]
      : []),
  ];
  return WorkflowManifestSchema.parse({
    schemaVersion: "callflow/workflow-manifest-v1",
    id: manifestId,
    name: (requestedName && requestedName.length > 0
      ? requestedName
      : `Workflow from ${entries[0]}`
    ).slice(0, 240),
    repository: { identity: repositoryIdentity },
    anchors,
    stages: [{ id: "workflow", label: "Workflow", order: 0 }],
    exclusions: [],
    acceptedSemanticLinks: [],
    discoveryBounds,
    presentation: { direction: "RIGHT", defaultOverlay: "none" },
  });
}

function repositoryPathFromManifest(manifest: WorkflowManifest, manifestPath?: string): string {
  if (manifest.repository.identity.startsWith("local:")) {
    return manifest.repository.identity.slice("local:".length);
  }
  if (manifestPath) return resolve(dirname(manifestPath));
  throw new CallFlowError(
    "invalid_manifest",
    "The manifest does not contain a local repository locator.",
  );
}

export class CallFlowService {
  readonly #adapter: GraftAdapter;
  readonly #repositoryPolicy: RepositoryPolicy;

  constructor(options: CallFlowServiceOptions = {}) {
    this.#repositoryPolicy = options.repositoryPolicy ?? new RepositoryPolicy();
    this.#adapter =
      options.adapter ?? new GraftAdapter({ repositoryPolicy: this.#repositoryPolicy });
  }

  async adapterStatus(repositoryPath: string, signal?: AbortSignal): Promise<GraftAdapterStatus> {
    return await this.#adapter.status(repositoryPath, signal);
  }

  async buildAdapter(
    repositoryPath: string,
    lsp = false,
    signal?: AbortSignal,
  ): Promise<GraftAdapterStatus> {
    return await this.#adapter.build(repositoryPath, lsp, signal);
  }

  async discover(request: DiscoverWorkflowRequest): Promise<DiscoveredWorkflow> {
    const repository = await this.#repositoryPolicy.resolveRepository(
      request.repositoryPath,
      request.signal,
    );
    const manifest = manifestForRequest(request, `local:${repository.root}`);
    return await this.discoverManifest(
      manifest,
      repository.root,
      boundedDepth(request.depth),
      boundedNodes(request.maximumNodes),
      request.signal,
    );
  }

  async discoverManifest(
    manifestValue: WorkflowManifest,
    repositoryPath?: string,
    depth?: number,
    maximumNodes?: number,
    signal?: AbortSignal,
  ): Promise<DiscoveredWorkflow> {
    const manifest = WorkflowManifestSchema.parse(manifestValue);
    const repository = await this.#repositoryPolicy.resolveRepository(
      repositoryPath ?? repositoryPathFromManifest(manifest),
      signal,
    );
    const draft = await this.#adapter.discoverDraft(repository, {
      anchors: manifest.anchors,
      exclusions: manifest.exclusions,
      depth: boundedDepth(depth ?? manifest.discoveryBounds?.depth),
      maximumNodes: boundedNodes(maximumNodes ?? manifest.discoveryBounds?.maximumNodes),
      ...(signal ? { signal } : {}),
    });
    const snapshot = buildGraphFromManifest(manifest, draft);
    return { manifest, snapshot };
  }

  async refreshManifestPath(
    manifestPath: string,
    signal?: AbortSignal,
  ): Promise<DiscoveredWorkflow> {
    const manifest = WorkflowManifestSchema.parse(await readBoundedJsonFile(manifestPath));
    return await this.discoverManifest(
      manifest,
      repositoryPathFromManifest(manifest, manifestPath),
      manifest.discoveryBounds?.depth ?? 2,
      manifest.discoveryBounds?.maximumNodes ?? MAX_NORMAL_EXPANSION_NODES,
      signal,
    );
  }

  async loadManifest(path: string): Promise<WorkflowManifest> {
    return WorkflowManifestSchema.parse(await readBoundedJsonFile(path));
  }

  async loadSnapshot(path: string): Promise<GraphSnapshot> {
    return GraphSnapshotSchema.parse(await readBoundedJsonFile(path));
  }

  async loadGeneratedSnapshot(manifestPath: string): Promise<GraphSnapshot> {
    return await this.loadSnapshot(generatedSnapshotPath(manifestPath));
  }

  query(snapshot: GraphSnapshot, query: GraphQuery) {
    return queryGraph(snapshot, GraphQuerySchema.parse(query));
  }

  diff(before: GraphSnapshot, after?: GraphSnapshot, unavailableReason?: string) {
    return diffGraphSnapshots(
      before,
      after,
      unavailableReason === undefined ? {} : { unavailableReason },
    );
  }

  export(snapshot: GraphSnapshot, format: ExportFormat): string {
    const parsed = GraphSnapshotSchema.parse(snapshot);
    if (format === "graph-json") {
      return JSON.stringify(sanitizeGraphSnapshot(parsed), undefined, 2);
    }
    switch (format) {
      case "bundle-json":
        return JSON.stringify(sanitizeExportBundle(parsed), undefined, 2);
      case "markdown":
        return exportMarkdown(parsed);
      case "mermaid":
        return exportMermaid(parsed);
      case "svg":
        return exportSvg(parsed);
      case "html":
        return exportHtml(parsed);
    }
  }

  generatedSnapshotPath(manifestPath: string): string {
    return generatedSnapshotPath(manifestPath);
  }
}

export function publicRepositoryIdentity(snapshot: GraphSnapshot): string {
  return sanitizeRepositoryIdentity(snapshot.repository.identity);
}

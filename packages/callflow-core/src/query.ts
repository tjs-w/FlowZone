import {
  GraphQuerySchema,
  GraphSnapshotSchema,
  MAX_VISIBLE_EDGES,
  MAX_VISIBLE_NODES,
  type EdgeKind,
  type GraphDirection,
  type GraphEdge,
  type GraphNode,
  type GraphQuery,
  type GraphSnapshot,
} from "@callflow/contracts";

import { compareStableStrings } from "./stable-id";

export interface TraversalOptions {
  readonly direction?: GraphDirection;
  readonly maxDepth?: number;
  readonly limit?: number;
  readonly edgeKinds?: readonly EdgeKind[];
}

export interface TraversalResult {
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly depths: ReadonlyMap<string, number>;
  readonly truncated: boolean;
}

export interface GraphPath {
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
}

export interface GraphQueryResult {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly totalMatchedNodes: number;
  readonly totalMatchedEdges: number;
  readonly truncated: boolean;
}

export type HiddenNodeReason =
  | "text-filter"
  | "kind-filter"
  | "level-filter"
  | "stage-filter"
  | "evidence-filter"
  | "anchor-distance"
  | "collapsed"
  | "node-limit";
export type HiddenEdgeReason = "kind-filter" | "endpoint-hidden" | "edge-limit";

export interface VisibilityOptions {
  readonly query?: GraphQuery;
  readonly collapsedNodeIds?: readonly string[];
  readonly pinnedNodeIds?: readonly string[];
  readonly maxNodes?: number;
  readonly maxEdges?: number;
}

export interface VisibilityResult {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly visibleNodeIds: ReadonlySet<string>;
  readonly visibleEdgeIds: ReadonlySet<string>;
  readonly hidden: {
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly nodeReasons: Readonly<Record<HiddenNodeReason, number>>;
    readonly edgeReasons: Readonly<Record<HiddenEdgeReason, number>>;
  };
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  return Math.max(0, Math.min(maximum, Math.trunc(value)));
}

function sortedEdges(snapshot: GraphSnapshot): GraphEdge[] {
  return [...snapshot.edges].sort((left, right) => compareStableStrings(left.id, right.id));
}

interface AdjacentStep {
  readonly nodeId: string;
  readonly edgeId: string;
}

function graphAdjacency(
  snapshot: GraphSnapshot,
  direction: GraphDirection,
  allowedEdgeKinds: ReadonlySet<EdgeKind> | undefined,
): ReadonlyMap<string, readonly AdjacentStep[]> {
  const adjacency = new Map<string, AdjacentStep[]>();
  const add = (nodeId: string, step: AdjacentStep): void => {
    const existing = adjacency.get(nodeId);
    if (existing === undefined) adjacency.set(nodeId, [step]);
    else existing.push(step);
  };
  for (const edge of sortedEdges(snapshot)) {
    if (allowedEdgeKinds !== undefined && !allowedEdgeKinds.has(edge.kind)) continue;
    if (direction === "out" || direction === "both") {
      add(edge.source, { nodeId: edge.target, edgeId: edge.id });
    }
    if (direction === "in" || (direction === "both" && edge.source !== edge.target)) {
      add(edge.target, { nodeId: edge.source, edgeId: edge.id });
    }
  }
  return adjacency;
}

export function traverseGraph(
  snapshotValue: GraphSnapshot,
  startNodeIds: readonly string[],
  options: TraversalOptions = {},
): TraversalResult {
  const snapshot = GraphSnapshotSchema.parse(snapshotValue);
  const direction = options.direction ?? "out";
  const maxDepth = boundedInteger(options.maxDepth, 1, 32);
  const limit = boundedInteger(options.limit, MAX_VISIBLE_NODES, MAX_VISIBLE_NODES);
  const allowedEdgeKinds = options.edgeKinds === undefined ? undefined : new Set(options.edgeKinds);
  const existingNodeIds = new Set(snapshot.nodes.map((node) => node.id));
  const depths = new Map<string, number>();
  const queue: string[] = [];
  const validStartIds = sortedUnique(startNodeIds).filter((nodeId) => existingNodeIds.has(nodeId));
  for (const nodeId of validStartIds.slice(0, limit)) {
    depths.set(nodeId, 0);
    queue.push(nodeId);
  }

  const includedEdgeIds = new Set<string>();
  let truncated = validStartIds.length > limit;
  const adjacency = graphAdjacency(snapshot, direction, allowedEdgeKinds);
  for (const current of queue) {
    const depth = depths.get(current) ?? 0;
    if (depth >= maxDepth) continue;
    for (const step of adjacency.get(current) ?? []) {
      if (!depths.has(step.nodeId)) {
        if (depths.size >= limit) {
          truncated = true;
          continue;
        }
        depths.set(step.nodeId, depth + 1);
        queue.push(step.nodeId);
      }
      if ((depths.get(step.nodeId) ?? maxDepth + 1) <= maxDepth) includedEdgeIds.add(step.edgeId);
    }
  }

  return {
    nodeIds: [...depths.keys()],
    edgeIds: [...includedEdgeIds].sort(compareStableStrings),
    depths,
    truncated,
  };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStableStrings);
}

export function findPath(
  snapshotValue: GraphSnapshot,
  sourceId: string,
  targetId: string,
  options: TraversalOptions = {},
): GraphPath | null {
  const snapshot = GraphSnapshotSchema.parse(snapshotValue);
  const nodeIds = new Set(snapshot.nodes.map((node) => node.id));
  if (!nodeIds.has(sourceId) || !nodeIds.has(targetId)) return null;
  if (sourceId === targetId) return { nodeIds: [sourceId], edgeIds: [] };

  const direction = options.direction ?? "out";
  const maxDepth = boundedInteger(options.maxDepth, 32, 32);
  const limit = boundedInteger(options.limit, MAX_VISIBLE_NODES, MAX_VISIBLE_NODES);
  const allowedEdgeKinds = options.edgeKinds === undefined ? undefined : new Set(options.edgeKinds);
  const queue: string[] = [sourceId];
  const depths = new Map<string, number>([[sourceId, 0]]);
  const previous = new Map<string, { readonly nodeId: string; readonly edgeId: string }>();
  const adjacency = graphAdjacency(snapshot, direction, allowedEdgeKinds);

  for (const current of queue) {
    const depth = depths.get(current) ?? 0;
    if (depth >= maxDepth) continue;
    for (const step of adjacency.get(current) ?? []) {
      if (depths.has(step.nodeId)) continue;
      if (depths.size >= limit) return null;
      depths.set(step.nodeId, depth + 1);
      previous.set(step.nodeId, { nodeId: current, edgeId: step.edgeId });
      if (step.nodeId === targetId) {
        const pathNodeIds = [targetId];
        const pathEdgeIds: string[] = [];
        let pathCursor = targetId;
        while (pathCursor !== sourceId) {
          const step = previous.get(pathCursor);
          if (step === undefined) return null;
          pathEdgeIds.push(step.edgeId);
          pathNodeIds.push(step.nodeId);
          pathCursor = step.nodeId;
        }
        return { nodeIds: pathNodeIds.reverse(), edgeIds: pathEdgeIds.reverse() };
      }
      queue.push(step.nodeId);
    }
  }
  return null;
}

function nodeEvidenceStates(snapshot: GraphSnapshot): ReadonlyMap<string, ReadonlySet<string>> {
  const evidenceStateById = new Map(
    snapshot.evidence.map((evidence) => [evidence.id, evidence.state]),
  );
  return new Map(
    snapshot.nodes.map((node) => [
      node.id,
      new Set(node.evidenceIds.flatMap((id) => evidenceStateById.get(id) ?? [])),
    ]),
  );
}

function textMatches(node: GraphNode, normalizedQuery: string | undefined): boolean {
  if (normalizedQuery === undefined || normalizedQuery.length === 0) return true;
  return [node.label, node.qualifiedName, node.signature, node.summary]
    .filter((value): value is string => value !== undefined)
    .some((value) => value.toLowerCase().includes(normalizedQuery));
}

function baseNodeReason(
  node: GraphNode,
  query: GraphQuery,
  evidenceStates: ReadonlyMap<string, ReadonlySet<string>>,
  reachableIds: ReadonlySet<string> | undefined,
): Exclude<HiddenNodeReason, "collapsed" | "node-limit"> | undefined {
  const normalizedQuery = query.text?.toLowerCase();
  if (!textMatches(node, normalizedQuery)) return "text-filter";
  if (query.nodeKinds !== undefined && !query.nodeKinds.includes(node.kind)) return "kind-filter";
  if (query.levels !== undefined && !query.levels.includes(node.level)) return "level-filter";
  if (
    query.stageIds !== undefined &&
    !query.stageIds.includes(node.stageId ?? "") &&
    !query.stageIds.includes(node.id)
  ) {
    return "stage-filter";
  }
  if (
    query.evidenceStates !== undefined &&
    !query.evidenceStates.some((state) => evidenceStates.get(node.id)?.has(state) === true)
  ) {
    return "evidence-filter";
  }
  if (reachableIds !== undefined && !reachableIds.has(node.id)) return "anchor-distance";
  return undefined;
}

export function queryGraph(
  snapshotValue: GraphSnapshot,
  queryValue: GraphQuery = {},
): GraphQueryResult {
  const snapshot = GraphSnapshotSchema.parse(snapshotValue);
  const query = GraphQuerySchema.parse(queryValue);
  const evidenceStates = nodeEvidenceStates(snapshot);
  const reachableIds =
    query.anchorNodeIds === undefined
      ? undefined
      : new Set(
          traverseGraph(snapshot, query.anchorNodeIds, {
            direction: query.direction ?? "both",
            maxDepth: query.maxDepth ?? 1,
            limit: MAX_VISIBLE_NODES,
            ...(query.edgeKinds === undefined ? {} : { edgeKinds: query.edgeKinds }),
          }).nodeIds,
        );
  const matchingNodes = [...snapshot.nodes]
    .sort((left, right) => compareStableStrings(left.id, right.id))
    .filter((node) => baseNodeReason(node, query, evidenceStates, reachableIds) === undefined);
  const limit = query.limit ?? MAX_VISIBLE_NODES;
  const nodes = matchingNodes.slice(0, limit);
  const selectedNodeIds = new Set(nodes.map((node) => node.id));
  const matchingEdges = sortedEdges(snapshot).filter(
    (edge) =>
      selectedNodeIds.has(edge.source) &&
      selectedNodeIds.has(edge.target) &&
      (query.edgeKinds === undefined || query.edgeKinds.includes(edge.kind)),
  );
  const edges = matchingEdges.slice(0, MAX_VISIBLE_EDGES);
  return {
    nodes,
    edges,
    totalMatchedNodes: matchingNodes.length,
    totalMatchedEdges: matchingEdges.length,
    truncated: matchingNodes.length > nodes.length || matchingEdges.length > edges.length,
  };
}

function hasCollapsedAncestor(
  node: GraphNode,
  nodeById: ReadonlyMap<string, GraphNode>,
  collapsedIds: ReadonlySet<string>,
): boolean {
  const visited = new Set<string>();
  let parentId = node.parentId ?? node.stageId;
  while (parentId !== undefined && !visited.has(parentId)) {
    if (collapsedIds.has(parentId)) return true;
    visited.add(parentId);
    const parent = nodeById.get(parentId);
    parentId = parent?.parentId ?? parent?.stageId;
  }
  return false;
}

function emptyNodeReasons(): Record<HiddenNodeReason, number> {
  return {
    "text-filter": 0,
    "kind-filter": 0,
    "level-filter": 0,
    "stage-filter": 0,
    "evidence-filter": 0,
    "anchor-distance": 0,
    collapsed: 0,
    "node-limit": 0,
  };
}

function emptyEdgeReasons(): Record<HiddenEdgeReason, number> {
  return { "kind-filter": 0, "endpoint-hidden": 0, "edge-limit": 0 };
}

export function computeVisibility(
  snapshotValue: GraphSnapshot,
  options: VisibilityOptions = {},
): VisibilityResult {
  const snapshot = GraphSnapshotSchema.parse(snapshotValue);
  const query = GraphQuerySchema.parse(options.query ?? {});
  const maxNodes = boundedInteger(options.maxNodes, MAX_VISIBLE_NODES, MAX_VISIBLE_NODES);
  const maxEdges = boundedInteger(options.maxEdges, MAX_VISIBLE_EDGES, MAX_VISIBLE_EDGES);
  const collapsedIds = new Set(options.collapsedNodeIds ?? []);
  const pinnedIds = new Set(options.pinnedNodeIds ?? []);
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const evidenceStates = nodeEvidenceStates(snapshot);
  const reachableIds =
    query.anchorNodeIds === undefined
      ? undefined
      : new Set(
          traverseGraph(snapshot, query.anchorNodeIds, {
            direction: query.direction ?? "both",
            maxDepth: query.maxDepth ?? 1,
            limit: MAX_VISIBLE_NODES,
            ...(query.edgeKinds === undefined ? {} : { edgeKinds: query.edgeKinds }),
          }).nodeIds,
        );
  const nodeReasons = emptyNodeReasons();
  const candidateNodes: GraphNode[] = [];

  for (const node of [...snapshot.nodes].sort((left, right) =>
    compareStableStrings(left.id, right.id),
  )) {
    const reason = baseNodeReason(node, query, evidenceStates, reachableIds);
    if (reason !== undefined) {
      nodeReasons[reason] += 1;
      continue;
    }
    if (!pinnedIds.has(node.id) && hasCollapsedAncestor(node, nodeById, collapsedIds)) {
      nodeReasons.collapsed += 1;
      continue;
    }
    candidateNodes.push(node);
  }

  const nodes = candidateNodes
    .sort(
      (left, right) =>
        Number(pinnedIds.has(right.id)) - Number(pinnedIds.has(left.id)) ||
        compareStableStrings(left.id, right.id),
    )
    .slice(0, maxNodes);
  nodeReasons["node-limit"] = candidateNodes.length - nodes.length;
  const visibleNodeIds = new Set(nodes.map((node) => node.id));
  const edgeReasons = emptyEdgeReasons();
  const candidateEdges: GraphEdge[] = [];
  for (const edge of sortedEdges(snapshot)) {
    if (query.edgeKinds !== undefined && !query.edgeKinds.includes(edge.kind)) {
      edgeReasons["kind-filter"] += 1;
      continue;
    }
    if (!visibleNodeIds.has(edge.source) || !visibleNodeIds.has(edge.target)) {
      edgeReasons["endpoint-hidden"] += 1;
      continue;
    }
    candidateEdges.push(edge);
  }
  const edges = candidateEdges.slice(0, maxEdges);
  edgeReasons["edge-limit"] = candidateEdges.length - edges.length;
  const visibleEdgeIds = new Set(edges.map((edge) => edge.id));

  return {
    nodes,
    edges,
    visibleNodeIds,
    visibleEdgeIds,
    hidden: {
      nodeCount: snapshot.nodes.length - nodes.length,
      edgeCount: snapshot.edges.length - edges.length,
      nodeReasons,
      edgeReasons,
    },
  };
}

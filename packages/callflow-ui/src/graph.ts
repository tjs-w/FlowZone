export interface UiGraphNode {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly level: string;
  readonly stageId?: string | undefined;
  readonly qualifiedName?: string | undefined;
  readonly signature?: string | undefined;
  readonly evidenceIds: readonly string[];
  readonly attributes?: Readonly<Record<string, unknown>> | undefined;
}

export interface UiGraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: string;
  readonly assertion: string;
  readonly evidenceIds: readonly string[];
  readonly label?: string | undefined;
  readonly condition?: string | undefined;
  readonly attributes?: Readonly<Record<string, unknown>> | undefined;
}

export interface UiEvidence {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly revision: string;
  readonly source?: Readonly<Record<string, unknown>> | undefined;
  readonly contentDigest: string;
  readonly producer: Readonly<Record<string, unknown>>;
  readonly summary?: string | undefined;
}

export type GraphDirection = "callers" | "callees" | "both";
export type CallFlowDiffStatus = "current" | "changed" | "broken" | "unverified";

const DIFF_STATUSES = new Set<CallFlowDiffStatus>(["current", "changed", "broken", "unverified"]);

/** Reads a sanitized diff marker without trusting arbitrary graph attributes. */
export function graphDiffStatus(
  attributes?: Readonly<Record<string, unknown>>,
): CallFlowDiffStatus {
  const value = attributes?.["diffStatus"] ?? attributes?.["changeStatus"];
  return typeof value === "string" && DIFF_STATUSES.has(value as CallFlowDiffStatus)
    ? (value as CallFlowDiffStatus)
    : "current";
}

export function relatedNodeIds(
  edges: readonly UiGraphEdge[],
  nodeId: string,
  direction: GraphDirection,
): ReadonlySet<string> {
  const related = new Set([nodeId]);
  for (const edge of edges) {
    if ((direction === "callees" || direction === "both") && edge.source === nodeId) {
      related.add(edge.target);
    }
    if ((direction === "callers" || direction === "both") && edge.target === nodeId) {
      related.add(edge.source);
    }
  }
  return related;
}

export function shortestDirectedPath(
  edges: readonly UiGraphEdge[],
  fromNodeId: string,
  toNodeId: string,
  maxDepth = 20,
): readonly string[] {
  if (fromNodeId === toNodeId) return [fromNodeId];
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = outgoing.get(edge.source) ?? [];
    targets.push(edge.target);
    outgoing.set(edge.source, targets);
  }
  const queue: { readonly id: string; readonly path: readonly string[] }[] = [
    { id: fromNodeId, path: [fromNodeId] },
  ];
  const visited = new Set([fromNodeId]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.path.length > maxDepth) continue;
    for (const target of outgoing.get(current.id) ?? []) {
      if (visited.has(target)) continue;
      const path = [...current.path, target];
      if (target === toNodeId) return path;
      visited.add(target);
      queue.push({ id: target, path });
    }
  }
  return [];
}

export function graphSearch(
  nodes: readonly UiGraphNode[],
  query: string,
  limit = 50,
): readonly string[] {
  const needle = query.normalize("NFKC").trim().toLocaleLowerCase().slice(0, 200);
  if (!needle) return [];
  return nodes
    .filter((node) =>
      [node.label, node.qualifiedName, node.signature, node.kind]
        .filter((value): value is string => typeof value === "string")
        .some((value) => value.normalize("NFKC").toLocaleLowerCase().includes(needle)),
    )
    .slice(0, Math.max(1, Math.min(limit, 50)))
    .map((node) => node.id);
}

export function stageSiblings(nodes: readonly UiGraphNode[], node: UiGraphNode): readonly string[] {
  if (!node.stageId) return [];
  return nodes
    .filter((candidate) => candidate.stageId === node.stageId && candidate.id !== node.id)
    .map((candidate) => candidate.id);
}

export function edgeMatchesOverlay(
  kind: string,
  overlay: string,
  diffStatus: CallFlowDiffStatus = "current",
): boolean {
  if (overlay === "flow" || overlay === "evidence") return true;
  if (overlay === "change") return diffStatus !== "current";
  if (overlay === "data") {
    return ["state-read", "state-write", "async-handoff", "poll", "claim"].includes(kind);
  }
  if (overlay === "failure") return kind === "failure-exit";
  if (overlay === "retry") return kind === "retry" || kind === "poll";
  if (overlay === "transaction") {
    return kind === "transaction-enter" || kind === "transaction-commit";
  }
  return true;
}

import {
  GraphBuildInputSchema,
  GraphSnapshotSchema,
  WorkflowManifestSchema,
  type DiscoveredNodeDraft,
  type EvidenceRecord,
  type GraphBuildInput,
  type GraphEdge,
  type GraphNode,
  type GraphSnapshot,
  type WorkflowAnchor,
  type WorkflowManifest,
} from "@callflow/contracts";

import { compareStableStrings, digestOf, stableId } from "./stable-id";

export class GraphBuildError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "GraphBuildError";
    this.code = code;
  }
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStableStrings);
}

function assertUniqueKeys(values: readonly { readonly key: string }[], kind: string): void {
  const keys = new Set<string>();
  for (const value of values) {
    if (keys.has(value.key)) {
      throw new GraphBuildError("duplicate_key", `Duplicate ${kind} key: ${value.key}.`);
    }
    keys.add(value.key);
  }
}

function selectorIdentity(anchor: WorkflowAnchor): string {
  switch (anchor.selector.type) {
    case "symbol":
      return `symbol:${anchor.selector.value}`;
    case "path":
      return `path:${anchor.selector.path}`;
    case "text":
      return `text:${anchor.selector.query}`;
    case "external":
      return `external:${anchor.selector.system}:${anchor.selector.reference}`;
  }
}

function manifestEvidence(
  manifest: WorkflowManifest,
  input: GraphBuildInput,
  reference: string,
  content: unknown,
  details?: string,
): EvidenceRecord {
  const base = {
    kind: "human-curated" as const,
    state: "exact" as const,
    revision: input.repository.commit,
    source: {
      type: "external-reference" as const,
      system: "callflow-manifest",
      reference: `${manifest.id}#${reference}`,
    },
    contentDigest: digestOf(content),
    producer: { name: "callflow-core", version: "0.1.0" },
    ...(details === undefined ? {} : { details }),
  };
  return {
    id: stableId("evidence", {
      repositoryIdentity: input.repository.identity,
      producer: base.producer.name,
      manifestId: manifest.id,
      reference,
    }),
    ...base,
  };
}

function discoveredNodeId(
  repositoryIdentity: string,
  draft: DiscoveredNodeDraft,
  evidenceIds: readonly string[],
): string {
  return stableId("node", {
    repositoryIdentity,
    kind: draft.kind,
    qualifiedSymbol: draft.qualifiedName ?? `adapter-key:${draft.key}`,
    signature: draft.signature ?? "",
    evidenceIds: sortedUnique(evidenceIds),
  });
}

function resolveEvidenceIds(
  keys: readonly string[],
  evidenceIdByKey: ReadonlyMap<string, string>,
  owner: string,
): string[] {
  const ids = keys.map((key) => {
    const id = evidenceIdByKey.get(key);
    if (id === undefined) {
      throw new GraphBuildError(
        "unknown_evidence",
        `${owner} references unknown evidence key: ${key}.`,
      );
    }
    return id;
  });
  return sortedUnique(ids);
}

function compareNodesByStageOrder(
  left: GraphNode,
  right: GraphNode,
  stageOrderByNodeId: ReadonlyMap<string, number>,
): number {
  const leftStageOrder = stageOrderByNodeId.get(
    left.kind === "stage" ? left.id : (left.stageId ?? ""),
  );
  const rightStageOrder = stageOrderByNodeId.get(
    right.kind === "stage" ? right.id : (right.stageId ?? ""),
  );
  const stageComparison =
    (leftStageOrder ?? Number.MAX_SAFE_INTEGER) - (rightStageOrder ?? Number.MAX_SAFE_INTEGER);
  if (stageComparison !== 0) return stageComparison;

  const levelRank = { L0: 0, L1: 1, L2: 2 } as const;
  const levelComparison = levelRank[left.level] - levelRank[right.level];
  if (levelComparison !== 0) return levelComparison;

  return (
    compareStableStrings(left.qualifiedName ?? left.label, right.qualifiedName ?? right.label) ||
    compareStableStrings(left.kind, right.kind) ||
    compareStableStrings(left.id, right.id)
  );
}

/**
 * Builds a content-addressed snapshot. Input order never influences IDs or serialized array order.
 * Human manifest intent is preserved as evidence; adapter data cannot silently replace it.
 */
export function buildGraphFromManifest(
  manifestValue: WorkflowManifest,
  inputValue: GraphBuildInput,
): GraphSnapshot {
  const manifest = WorkflowManifestSchema.parse(manifestValue);
  const input = GraphBuildInputSchema.parse(inputValue);
  assertUniqueKeys(input.evidence, "evidence");
  assertUniqueKeys(input.nodes, "node");

  const evidenceById = new Map<string, EvidenceRecord>();
  const evidenceIdByKey = new Map<string, string>();

  for (const draft of [...input.evidence].sort((left, right) =>
    compareStableStrings(left.key, right.key),
  )) {
    const { key, ...recordWithoutId } = draft;
    // The adapter key is the evidence identity. Mutable observation state such
    // as commit, digest, confidence, details, and producer version belongs in
    // the evidence record, but must not churn every dependent node and edge ID.
    const id = stableId("evidence", {
      repositoryIdentity: input.repository.identity,
      producer: recordWithoutId.producer.name,
      kind: recordWithoutId.kind,
      key,
    });
    evidenceIdByKey.set(key, id);
    if (!evidenceById.has(id)) evidenceById.set(id, { id, ...recordWithoutId });
  }

  const nodesById = new Map<string, GraphNode>();
  const nodeIdByKey = new Map<string, string>();
  const stageNodeIdByManifestId = new Map<string, string>();
  const anchorNodeIdByManifestId = new Map<string, string>();

  for (const stage of [...manifest.stages].sort(
    (left, right) => left.order - right.order || compareStableStrings(left.id, right.id),
  )) {
    const evidence = manifestEvidence(manifest, input, `stage:${stage.id}`, stage);
    evidenceById.set(evidence.id, evidence);
    const id = stableId("node", {
      repositoryIdentity: input.repository.identity,
      qualifiedSymbol: `manifest-stage:${manifest.id}:${stage.id}`,
      signature: "",
      evidenceIds: [evidence.id],
    });
    stageNodeIdByManifestId.set(stage.id, id);
    nodeIdByKey.set(`stage:${stage.id}`, id);
    nodesById.set(id, {
      id,
      kind: "stage",
      label: stage.label,
      level: "L0",
      ...(stage.description === undefined ? {} : { summary: stage.description }),
      evidenceIds: [evidence.id],
      attributes: { order: stage.order, manifestStageId: stage.id },
    });
  }

  const deferredParents = new Map<string, string>();
  for (const draft of [...input.nodes].sort((left, right) =>
    compareStableStrings(left.key, right.key),
  )) {
    const evidenceIds = resolveEvidenceIds(
      draft.evidenceKeys,
      evidenceIdByKey,
      `Node ${draft.key}`,
    );
    const id = discoveredNodeId(input.repository.identity, draft, evidenceIds);
    nodeIdByKey.set(draft.key, id);

    if (draft.anchorId !== undefined) {
      if (anchorNodeIdByManifestId.has(draft.anchorId)) {
        throw new GraphBuildError(
          "duplicate_anchor_mapping",
          `More than one discovered node maps to anchor: ${draft.anchorId}.`,
        );
      }
      if (!manifest.anchors.some((anchor) => anchor.id === draft.anchorId)) {
        throw new GraphBuildError(
          "unknown_anchor",
          `Node ${draft.key} maps to unknown anchor: ${draft.anchorId}.`,
        );
      }
      anchorNodeIdByManifestId.set(draft.anchorId, id);
      nodeIdByKey.set(`anchor:${draft.anchorId}`, id);
      nodeIdByKey.set(draft.anchorId, id);
    }

    const stageId =
      draft.stageId === undefined ? undefined : stageNodeIdByManifestId.get(draft.stageId);
    if (draft.stageId !== undefined && stageId === undefined) {
      throw new GraphBuildError(
        "unknown_stage",
        `Node ${draft.key} references unknown manifest stage: ${draft.stageId}.`,
      );
    }

    if (!nodesById.has(id)) {
      nodesById.set(id, {
        id,
        kind: draft.kind,
        label: draft.label,
        level: draft.level,
        ...(stageId === undefined ? {} : { stageId }),
        ...(draft.qualifiedName === undefined ? {} : { qualifiedName: draft.qualifiedName }),
        ...(draft.signature === undefined ? {} : { signature: draft.signature }),
        ...(draft.summary === undefined ? {} : { summary: draft.summary }),
        evidenceIds,
        ...(draft.attributes === undefined ? {} : { attributes: draft.attributes }),
      });
      if (draft.parentKey !== undefined) deferredParents.set(id, draft.parentKey);
    }
  }

  for (const anchor of [...manifest.anchors].sort((left, right) =>
    compareStableStrings(left.id, right.id),
  )) {
    if (anchorNodeIdByManifestId.has(anchor.id)) continue;
    const evidence = manifestEvidence(manifest, input, `anchor:${anchor.id}`, anchor);
    evidenceById.set(evidence.id, evidence);
    const id = stableId("node", {
      repositoryIdentity: input.repository.identity,
      kind: anchor.nodeKind,
      qualifiedSymbol: selectorIdentity(anchor),
      signature: "",
      evidenceIds: [evidence.id],
    });
    const stageId =
      anchor.stageId === undefined ? undefined : stageNodeIdByManifestId.get(anchor.stageId);
    anchorNodeIdByManifestId.set(anchor.id, id);
    nodeIdByKey.set(`anchor:${anchor.id}`, id);
    nodeIdByKey.set(anchor.id, id);
    nodesById.set(id, {
      id,
      kind: anchor.nodeKind,
      label: anchor.label,
      level: "L1",
      ...(stageId === undefined ? {} : { stageId }),
      ...(anchor.selector.type === "symbol" ? { qualifiedName: anchor.selector.value } : {}),
      ...(anchor.description === undefined ? {} : { summary: anchor.description }),
      evidenceIds: [evidence.id],
      attributes: { anchorId: anchor.id, anchorRole: anchor.role },
    });
  }

  for (const [nodeId, parentKey] of deferredParents) {
    const parentId = nodeIdByKey.get(parentKey);
    if (parentId === undefined) {
      throw new GraphBuildError(
        "unknown_parent",
        `Node ${nodeId} references unknown parent key: ${parentKey}.`,
      );
    }
    if (parentId === nodeId) {
      throw new GraphBuildError("self_parent", `Node ${nodeId} cannot be its own parent.`);
    }
    const node = nodesById.get(nodeId);
    if (node !== undefined) nodesById.set(nodeId, { ...node, parentId });
  }

  const edgesById = new Map<string, GraphEdge>();
  for (const draft of [...input.edges].sort((left, right) =>
    compareStableStrings(
      `${left.sourceKey}\0${left.targetKey}\0${left.kind}\0${left.key ?? ""}`,
      `${right.sourceKey}\0${right.targetKey}\0${right.kind}\0${right.key ?? ""}`,
    ),
  )) {
    const source = nodeIdByKey.get(draft.sourceKey);
    const target = nodeIdByKey.get(draft.targetKey);
    if (source === undefined || target === undefined) {
      throw new GraphBuildError(
        "unknown_endpoint",
        `Edge ${draft.key ?? `${draft.sourceKey}->${draft.targetKey}`} references an unknown node key.`,
      );
    }
    const evidenceIds = resolveEvidenceIds(
      draft.evidenceKeys,
      evidenceIdByKey,
      `Edge ${draft.key ?? `${draft.sourceKey}->${draft.targetKey}`}`,
    );
    const id = stableId("edge", {
      repositoryIdentity: input.repository.identity,
      source,
      target,
      kind: draft.kind,
      assertion: draft.assertion,
      evidenceIds,
      condition: draft.condition ?? "",
    });
    if (!edgesById.has(id)) {
      edgesById.set(id, {
        id,
        source,
        target,
        kind: draft.kind,
        assertion: draft.assertion,
        evidenceIds,
        ...(draft.label === undefined ? {} : { label: draft.label }),
        ...(draft.condition === undefined ? {} : { condition: draft.condition }),
        ...(draft.attributes === undefined ? {} : { attributes: draft.attributes }),
      });
    }
  }

  const acceptedRelationships = [
    ...manifest.acceptedSemanticLinks,
    ...(manifest.acceptedRelationships ?? []),
  ];
  for (const link of acceptedRelationships.sort((left, right) =>
    compareStableStrings(
      `${left.sourceAnchorId}\0${left.targetAnchorId}\0${left.kind}\0${left.label ?? ""}`,
      `${right.sourceAnchorId}\0${right.targetAnchorId}\0${right.kind}\0${right.label ?? ""}`,
    ),
  )) {
    const source = anchorNodeIdByManifestId.get(link.sourceAnchorId);
    const target = anchorNodeIdByManifestId.get(link.targetAnchorId);
    if (source === undefined || target === undefined) {
      throw new GraphBuildError(
        "unknown_semantic_endpoint",
        "Semantic link endpoints did not resolve.",
      );
    }
    const evidence = manifestEvidence(
      manifest,
      input,
      `accepted-relationship:${link.kind}:${link.sourceAnchorId}:${link.targetAnchorId}`,
      link,
      link.rationale,
    );
    evidenceById.set(evidence.id, evidence);
    const id = stableId("edge", {
      repositoryIdentity: input.repository.identity,
      source,
      target,
      kind: link.kind,
      assertion: "curated-workflow",
      evidenceIds: [evidence.id],
    });
    edgesById.set(id, {
      id,
      source,
      target,
      kind: link.kind,
      assertion: "curated-workflow",
      evidenceIds: [evidence.id],
      ...(link.label === undefined ? {} : { label: link.label }),
    });
  }

  const orderedStageNodeIds = [...manifest.stages]
    .sort((left, right) => left.order - right.order || compareStableStrings(left.id, right.id))
    .map((stage) => {
      const stageNodeId = stageNodeIdByManifestId.get(stage.id);
      if (stageNodeId === undefined) {
        throw new GraphBuildError(
          "missing_stage",
          `Stage ${stage.id} did not produce a graph node.`,
        );
      }
      return stageNodeId;
    });
  const stageOrderByNodeId = new Map(
    orderedStageNodeIds.map((stageNodeId, index) => [stageNodeId, index] as const),
  );
  const nodes = [...nodesById.values()].sort((left, right) =>
    compareNodesByStageOrder(left, right, stageOrderByNodeId),
  );
  const edges = [...edgesById.values()].sort((left, right) =>
    compareStableStrings(left.id, right.id),
  );
  const evidence = [...evidenceById.values()].sort((left, right) =>
    compareStableStrings(left.id, right.id),
  );
  const warnings = [...input.warnings].sort(
    (left, right) =>
      compareStableStrings(left.code, right.code) ||
      compareStableStrings(left.message, right.message),
  );
  const extraction =
    input.extraction?.status === "succeeded"
      ? {
          status: "succeeded" as const,
          items: resolveEvidenceIds(input.extraction.items, evidenceIdByKey, "Extraction slice"),
        }
      : (input.extraction ?? {
          status: "unavailable" as const,
          reason: "Extraction status was not reported by the adapter.",
        });
  const runtimeEvidence =
    input.runtimeEvidence?.status === "succeeded"
      ? {
          status: "succeeded" as const,
          items: resolveEvidenceIds(
            input.runtimeEvidence.items,
            evidenceIdByKey,
            "Runtime evidence slice",
          ),
        }
      : (input.runtimeEvidence ?? {
          status: "unavailable" as const,
          reason: "Runtime evidence is unavailable in CallFlow v1.",
        });
  const presentation = {
    schemaVersion: "callflow/graph-presentation-v1" as const,
    direction: manifest.presentation.direction,
    defaultOverlay: manifest.presentation.defaultOverlay,
  };
  const layoutHints = {
    schemaVersion: "callflow/graph-layout-hints-v1" as const,
    stageOrder: orderedStageNodeIds,
  };
  const id = stableId("graph", {
    workflowManifestId: manifest.id,
    repository: input.repository,
    adapter: input.adapter,
    nodes,
    edges,
    evidence,
    warnings,
    presentation,
    layoutHints,
    extraction,
    runtimeEvidence,
  });

  return GraphSnapshotSchema.parse({
    schemaVersion: "callflow/graph-snapshot-v1",
    id,
    workflowManifestId: manifest.id,
    repository: input.repository,
    adapter: input.adapter,
    nodes,
    edges,
    evidence,
    warnings,
    presentation,
    layoutHints,
    extraction,
    runtimeEvidence,
  });
}

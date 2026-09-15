import {
  GraphDiffSchema,
  GraphSnapshotSchema,
  type DiffStatus,
  type EvidenceRecord,
  type GraphDiff,
  type GraphDiffEntry,
  type GraphEdge,
  type GraphNode,
  type GraphSnapshot,
} from "@callflow/contracts";

import { compareStableStrings, digestOf, stableId } from "./stable-id";

type DiffableEntity = GraphNode | GraphEdge | EvidenceRecord;

function isEvidenceUnverified(evidence: EvidenceRecord): boolean {
  return evidence.state !== "exact";
}

function entityHasUnverifiedEvidence(
  entity: GraphNode | GraphEdge,
  evidenceById: ReadonlyMap<string, EvidenceRecord>,
): boolean {
  return entity.evidenceIds.some((id) => {
    const evidence = evidenceById.get(id);
    return evidence === undefined || isEvidenceUnverified(evidence);
  });
}

function entityType(entity: DiffableEntity): GraphDiffEntry["entity"] {
  if ("state" in entity) return "evidence";
  if ("source" in entity) return "edge";
  return entity.kind === "stage" ? "stage" : "node";
}

function comparisonStatus(
  before: DiffableEntity | undefined,
  after: DiffableEntity | undefined,
  baseEvidenceById: ReadonlyMap<string, EvidenceRecord>,
  targetEvidenceById: ReadonlyMap<string, EvidenceRecord>,
  correlatedBySharedEvidence = false,
): { readonly status: DiffStatus; readonly reason: string } {
  if (after === undefined) return { status: "broken", reason: "Missing from target graph." };
  if (before === undefined) {
    if (
      ("state" in after && isEvidenceUnverified(after)) ||
      (!("state" in after) && entityHasUnverifiedEvidence(after, targetEvidenceById))
    ) {
      return { status: "unverified", reason: "Added with non-exact or unavailable evidence." };
    }
    return { status: "changed", reason: "Added in target graph." };
  }
  if (
    ("state" in after && isEvidenceUnverified(after)) ||
    (!("state" in after) && entityHasUnverifiedEvidence(after, targetEvidenceById))
  ) {
    return { status: "unverified", reason: "Target evidence is not exact." };
  }
  if (correlatedBySharedEvidence && before.id !== after.id) {
    return {
      status: "changed",
      reason: "Identity changed; correlated by unique shared evidence.",
    };
  }
  if (digestOf(before) !== digestOf(after))
    return { status: "changed", reason: "Content changed." };
  if (!("state" in after)) {
    const changedEvidence = after.evidenceIds.some((id) => {
      const baseEvidence = baseEvidenceById.get(id);
      const targetEvidence = targetEvidenceById.get(id);
      return (
        baseEvidence === undefined ||
        targetEvidence === undefined ||
        digestOf(baseEvidence) !== digestOf(targetEvidence)
      );
    });
    if (changedEvidence) {
      return { status: "changed", reason: "Referenced evidence changed." };
    }
  }
  return { status: "current", reason: "Content and evidence are unchanged." };
}

interface EntityPair<T extends DiffableEntity> {
  readonly before?: T;
  readonly after?: T;
  readonly correlatedBySharedEvidence?: boolean;
}

interface ExactPairing<T extends DiffableEntity> {
  readonly pairs: readonly EntityPair<T>[];
  readonly unmatchedBefore: readonly T[];
  readonly unmatchedAfter: readonly T[];
}

function pairExactIds<T extends DiffableEntity>(
  baseValues: readonly T[],
  targetValues: readonly T[],
): ExactPairing<T> {
  const beforeById = new Map(baseValues.map((value) => [value.id, value]));
  const afterById = new Map(targetValues.map((value) => [value.id, value]));
  const sharedIds = [...beforeById.keys()]
    .filter((id) => afterById.has(id))
    .sort(compareStableStrings);
  const pairs = sharedIds.map((id) => {
    const before = beforeById.get(id);
    const after = afterById.get(id);
    if (before === undefined || after === undefined) {
      throw new TypeError("Exact-ID diff pairing lost a shared entity.");
    }
    return { before, after };
  });
  return {
    pairs,
    unmatchedBefore: baseValues
      .filter((value) => !afterById.has(value.id))
      .sort((left, right) => compareStableStrings(left.id, right.id)),
    unmatchedAfter: targetValues
      .filter((value) => !beforeById.has(value.id))
      .sort((left, right) => compareStableStrings(left.id, right.id)),
  };
}

function hasSharedEvidence(before: GraphNode | GraphEdge, after: GraphNode | GraphEdge): boolean {
  const afterEvidenceIds = new Set(after.evidenceIds);
  return before.evidenceIds.some((id) => afterEvidenceIds.has(id));
}

interface UniqueCorrelation<T extends GraphNode | GraphEdge> {
  readonly pairs: readonly EntityPair<T>[];
  readonly unmatchedBefore: readonly T[];
  readonly unmatchedAfter: readonly T[];
}

/**
 * Correlates only mutual one-to-one candidates. Ambiguous fanout is deliberately
 * left as add/remove entries rather than guessing that two entities are renames.
 */
function correlateUniqueSharedEvidence<T extends GraphNode | GraphEdge>(
  baseValues: readonly T[],
  targetValues: readonly T[],
  compatible: (before: T, after: T) => boolean,
): UniqueCorrelation<T> {
  const targetsByBaseId = new Map<string, readonly T[]>();
  const basesByTargetId = new Map<string, readonly T[]>();
  for (const before of baseValues) {
    targetsByBaseId.set(
      before.id,
      targetValues.filter((after) => compatible(before, after) && hasSharedEvidence(before, after)),
    );
  }
  for (const after of targetValues) {
    basesByTargetId.set(
      after.id,
      baseValues.filter((before) => compatible(before, after) && hasSharedEvidence(before, after)),
    );
  }

  const pairedBeforeIds = new Set<string>();
  const pairedAfterIds = new Set<string>();
  const pairs: EntityPair<T>[] = [];
  for (const before of [...baseValues].sort((left, right) =>
    compareStableStrings(left.id, right.id),
  )) {
    const targets = targetsByBaseId.get(before.id) ?? [];
    if (targets.length !== 1) continue;
    const after = targets[0];
    if (after === undefined || (basesByTargetId.get(after.id) ?? []).length !== 1) continue;
    pairedBeforeIds.add(before.id);
    pairedAfterIds.add(after.id);
    pairs.push({ before, after, correlatedBySharedEvidence: true });
  }

  return {
    pairs,
    unmatchedBefore: baseValues.filter((value) => !pairedBeforeIds.has(value.id)),
    unmatchedAfter: targetValues.filter((value) => !pairedAfterIds.has(value.id)),
  };
}

function entriesForPairs<T extends DiffableEntity>(
  pairs: readonly EntityPair<T>[],
  baseEvidenceById: ReadonlyMap<string, EvidenceRecord>,
  targetEvidenceById: ReadonlyMap<string, EvidenceRecord>,
): GraphDiffEntry[] {
  return pairs.map((pair) => {
    const { before, after } = pair;
    const result = comparisonStatus(
      before,
      after,
      baseEvidenceById,
      targetEvidenceById,
      pair.correlatedBySharedEvidence,
    );
    const exemplar = after ?? before;
    if (exemplar === undefined) throw new TypeError("A diff entry must have a source entity.");
    const id = after?.id ?? exemplar.id;
    return {
      entity: entityType(exemplar),
      id,
      ...(before !== undefined && after !== undefined && before.id !== after.id
        ? { beforeId: before.id, afterId: after.id }
        : {}),
      status: result.status,
      reason: result.reason,
      ...(before === undefined ? {} : { beforeDigest: digestOf(before) }),
      ...(after === undefined ? {} : { afterDigest: digestOf(after) }),
    };
  });
}

function compareGraphs(
  base: GraphSnapshot,
  target: GraphSnapshot,
  baseEvidenceById: ReadonlyMap<string, EvidenceRecord>,
  targetEvidenceById: ReadonlyMap<string, EvidenceRecord>,
): GraphDiffEntry[] {
  const exactNodes = pairExactIds(base.nodes, target.nodes);
  const correlatedNodes = correlateUniqueSharedEvidence(
    exactNodes.unmatchedBefore,
    exactNodes.unmatchedAfter,
    (before, after) =>
      before.kind !== "stage" &&
      before.kind === after.kind &&
      before.level === after.level &&
      before.stageId === after.stageId,
  );
  const nodeIdRemap = new Map<string, string>();
  for (const pair of [...exactNodes.pairs, ...correlatedNodes.pairs]) {
    if (pair.before !== undefined && pair.after !== undefined) {
      nodeIdRemap.set(pair.before.id, pair.after.id);
    }
  }

  const exactEdges = pairExactIds(base.edges, target.edges);
  const correlatedEdges = correlateUniqueSharedEvidence(
    exactEdges.unmatchedBefore,
    exactEdges.unmatchedAfter,
    (before, after) =>
      (nodeIdRemap.get(before.source) ?? before.source) === after.source &&
      (nodeIdRemap.get(before.target) ?? before.target) === after.target &&
      before.kind === after.kind &&
      before.assertion === after.assertion,
  );
  const exactEvidence = pairExactIds(base.evidence, target.evidence);

  const completePairs = <T extends DiffableEntity>(
    exact: ExactPairing<T>,
    correlated?: UniqueCorrelation<Extract<T, GraphNode | GraphEdge>>,
  ): EntityPair<T>[] => {
    const unmatchedBefore = correlated?.unmatchedBefore ?? exact.unmatchedBefore;
    const unmatchedAfter = correlated?.unmatchedAfter ?? exact.unmatchedAfter;
    return [
      ...exact.pairs,
      ...((correlated?.pairs ?? []) as readonly EntityPair<T>[]),
      ...unmatchedBefore.map((before) => ({ before })),
      ...unmatchedAfter.map((after) => ({ after })),
    ];
  };

  return [
    ...entriesForPairs(
      completePairs(exactNodes, correlatedNodes),
      baseEvidenceById,
      targetEvidenceById,
    ),
    ...entriesForPairs(
      completePairs(exactEdges, correlatedEdges),
      baseEvidenceById,
      targetEvidenceById,
    ),
    ...entriesForPairs(completePairs(exactEvidence), baseEvidenceById, targetEvidenceById),
  ].sort(
    (left, right) =>
      compareStableStrings(left.entity, right.entity) || compareStableStrings(left.id, right.id),
  );
}

function unavailableEntries(base: GraphSnapshot, reason: string): GraphDiffEntry[] {
  const allEntities: DiffableEntity[] = [...base.nodes, ...base.edges, ...base.evidence];
  return allEntities
    .sort((left, right) => compareStableStrings(left.id, right.id))
    .map((entity) => ({
      entity: entityType(entity),
      id: entity.id,
      status: "unverified",
      reason,
      beforeDigest: digestOf(entity),
    }));
}

function summarize(entries: readonly GraphDiffEntry[]): GraphDiff["summary"] {
  const summary = { current: 0, changed: 0, broken: 0, unverified: 0 };
  for (const entry of entries) summary[entry.status] += 1;
  return summary;
}

export interface GraphDiffOptions {
  readonly unavailableReason?: string;
}

export function diffGraphSnapshots(
  baseValue: GraphSnapshot,
  targetValue?: GraphSnapshot,
  options: GraphDiffOptions = {},
): GraphDiff {
  const base = GraphSnapshotSchema.parse(baseValue);
  const target = targetValue === undefined ? undefined : GraphSnapshotSchema.parse(targetValue);
  if (target !== undefined && target.workflowManifestId !== base.workflowManifestId) {
    throw new TypeError("Graph snapshots must belong to the same workflow manifest.");
  }

  const entries =
    target === undefined
      ? unavailableEntries(base, options.unavailableReason ?? "Target graph is unavailable.")
      : target.extraction?.status !== "succeeded"
        ? unavailableEntries(
            base,
            target.extraction?.status === "failed"
              ? `Target extraction failed (${target.extraction.code}).`
              : (target.extraction?.reason ?? "Target extraction status is unavailable."),
          )
        : compareGraphs(
            base,
            target,
            new Map(base.evidence.map((record) => [record.id, record])),
            new Map(target.evidence.map((record) => [record.id, record])),
          );
  const summary = summarize(entries);
  const id = stableId("diff", {
    baseGraphId: base.id,
    targetGraphId: target?.id ?? null,
    entries,
  });
  return GraphDiffSchema.parse({
    schemaVersion: "callflow/graph-diff-v1",
    id,
    workflowManifestId: base.workflowManifestId,
    baseGraphId: base.id,
    ...(target === undefined ? {} : { targetGraphId: target.id }),
    baseRepository: base.repository,
    ...(target === undefined ? {} : { targetRepository: target.repository }),
    entries,
    summary,
    warnings:
      target === undefined
        ? [
            {
              code: "target_unavailable",
              message: options.unavailableReason ?? "Target graph is unavailable.",
              retryable: true,
            },
          ]
        : target.extraction?.status !== "succeeded"
          ? [
              ...target.warnings,
              {
                code: "target_extraction_unavailable",
                message:
                  target.extraction?.status === "failed"
                    ? `Target extraction failed (${target.extraction.code}).`
                    : (target.extraction?.reason ?? "Target extraction status is unavailable."),
                retryable: target.extraction?.status === "failed" && target.extraction.retryable,
              },
            ]
          : [...target.warnings],
  });
}

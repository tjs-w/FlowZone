import { z } from "zod";

export const WORKFLOW_MANIFEST_SCHEMA = "callflow/workflow-manifest-v1" as const;
export const GRAPH_SNAPSHOT_SCHEMA = "callflow/graph-snapshot-v1" as const;
export const GRAPH_DIFF_SCHEMA = "callflow/graph-diff-v1" as const;
export const EXPORT_BUNDLE_SCHEMA = "callflow/export-bundle-v1" as const;
export const GRAPH_PRESENTATION_SCHEMA = "callflow/graph-presentation-v1" as const;
export const GRAPH_LAYOUT_HINTS_SCHEMA = "callflow/graph-layout-hints-v1" as const;
export const CALLFLOW_UI_PAYLOAD_SCHEMA = "callflow/ui-payload-v1" as const;
export const CALLFLOW_SOURCE_SCHEMA = "callflow/source-v1" as const;

export const MAX_GRAPH_NODES = 10_000;
export const MAX_GRAPH_EDGES = 25_000;
export const MAX_GRAPH_EVIDENCE = 50_000;
export const MAX_VISIBLE_NODES = 250;
export const MAX_VISIBLE_EDGES = 600;
export const MAX_NORMAL_EXPANSION_NODES = 25;
export const MAX_INITIAL_GRAPH_BYTES = 8 * 1024 * 1024;
export const MAX_SOURCE_EXCERPT_BYTES = 24 * 1024;

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Expected a bounded opaque identifier.");
const LabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .regex(/^[^\0\r\n]+$/);
const DescriptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine((value) => !value.includes("\0"), "Text cannot contain NUL bytes.");
const RevisionSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^[^\0\r\n]+$/);
const TimestampSchema = z.iso.datetime({ offset: true });

export const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const RepositoryRelativePathSchema = z
  .string()
  .min(1)
  .max(2_048)
  .superRefine((value, context) => {
    if (
      value.includes("\0") ||
      value.includes("\\") ||
      value.startsWith("/") ||
      /^[A-Za-z]:/.test(value) ||
      value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      context.addIssue({
        code: "custom",
        message: "Expected a normalized repository-relative POSIX path.",
      });
    }
  });

const AttributeKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^(?!__proto__$|prototype$|constructor$)[A-Za-z][A-Za-z0-9_.-]*$/);
export const AttributeValueSchema = z.union([z.string().max(1_024), z.number(), z.boolean()]);
export const AttributesSchema = z
  .record(AttributeKeySchema, AttributeValueSchema)
  .superRefine((value, context) => {
    if (Object.keys(value).length > 32) {
      context.addIssue({ code: "custom", message: "At most 32 attributes are allowed." });
    }
  });

export const NodeKindSchema = z.enum([
  "stage",
  "package",
  "class",
  "function",
  "condition",
  "transaction",
  "database",
  "table",
  "queue",
  "message",
  "external-system",
  "terminal",
]);
export type NodeKind = z.infer<typeof NodeKindSchema>;

export const GraphLevelSchema = z.enum(["L0", "L1", "L2"]);
export type GraphLevel = z.infer<typeof GraphLevelSchema>;

export const EdgeKindSchema = z.enum([
  "direct-call",
  "conditional-call",
  "async-handoff",
  "poll",
  "claim",
  "state-read",
  "state-write",
  "transaction-enter",
  "transaction-commit",
  "retry",
  "failure-exit",
  "semantic-link",
]);
export type EdgeKind = z.infer<typeof EdgeKindSchema>;

export const EdgeAssertionSchema = z.enum([
  "static-possible",
  "curated-workflow",
  "ai-inferred",
  "runtime-observed",
]);
export type EdgeAssertion = z.infer<typeof EdgeAssertionSchema>;

export const EvidenceKindSchema = z.enum([
  "graft-exact",
  "source-literal",
  "human-curated",
  "ai-inferred",
  "runtime-observed",
]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const EvidenceStateSchema = z.enum(["exact", "ambiguous", "stale", "failed", "unavailable"]);
export type EvidenceState = z.infer<typeof EvidenceStateSchema>;

export const DiffStatusSchema = z.enum(["current", "changed", "broken", "unverified"]);
export type DiffStatus = z.infer<typeof DiffStatusSchema>;

export const GraphOverlaySchema = z.enum([
  "none",
  "data",
  "failure",
  "retry",
  "transaction",
  "change",
]);
export type GraphOverlay = z.infer<typeof GraphOverlaySchema>;

export const SourcePositionSchema = z
  .object({
    line: z.number().int().positive().max(10_000_000),
    column: z.number().int().positive().max(10_000_000),
  })
  .strict();

export const EvidenceSourceSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("source-span"),
      path: RepositoryRelativePathSchema,
      start: SourcePositionSchema,
      end: SourcePositionSchema,
      symbol: z.string().trim().min(1).max(1_024).optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.end.line < value.start.line ||
        (value.end.line === value.start.line && value.end.column < value.start.column)
      ) {
        context.addIssue({
          code: "custom",
          message: "The source span end must not precede its start.",
          path: ["end"],
        });
      }
    }),
  z
    .object({
      type: z.literal("external-reference"),
      system: LabelSchema,
      reference: z.string().trim().min(1).max(2_048),
    })
    .strict(),
]);
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

export const EvidenceProducerSchema = z
  .object({
    name: IdentifierSchema,
    version: z.string().trim().min(1).max(128),
  })
  .strict();

const EvidenceRecordFields = {
  id: IdentifierSchema,
  kind: EvidenceKindSchema,
  state: EvidenceStateSchema,
  revision: RevisionSchema,
  source: EvidenceSourceSchema,
  contentDigest: Sha256DigestSchema,
  producer: EvidenceProducerSchema,
  details: DescriptionSchema.optional(),
  attributes: AttributesSchema.optional(),
} as const;

export const EvidenceRecordSchema = z.object(EvidenceRecordFields).strict();
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

export type EvidenceSlice<T> =
  | { readonly status: "succeeded"; readonly items: readonly T[] }
  | { readonly status: "failed"; readonly code: string; readonly retryable: boolean }
  | { readonly status: "unavailable"; readonly reason: string };

export function EvidenceSliceSchema<T extends z.ZodType>(itemSchema: T) {
  return z.discriminatedUnion("status", [
    z.object({ status: z.literal("succeeded"), items: z.array(itemSchema).max(50_000) }).strict(),
    z
      .object({
        status: z.literal("failed"),
        code: IdentifierSchema,
        retryable: z.boolean(),
      })
      .strict(),
    z
      .object({
        status: z.literal("unavailable"),
        reason: DescriptionSchema,
      })
      .strict(),
  ]);
}

/** Compact persisted acquisition state; succeeded with [] is a healthy empty result. */
export const EvidenceReferenceSliceSchema = EvidenceSliceSchema(IdentifierSchema).superRefine(
  (value, context) => {
    if (value.status !== "succeeded") return;
    if (new Set(value.items).size !== value.items.length) {
      context.addIssue({ code: "custom", message: "Evidence slice references must be unique." });
    }
  },
);
export type EvidenceReferenceSlice = z.infer<typeof EvidenceReferenceSliceSchema>;

export const RepositoryReferenceSchema = z
  .object({
    identity: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .regex(/^[^\0\r\n]+$/),
  })
  .strict();

export const RepositoryRevisionSchema = z
  .object({
    identity: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .regex(/^[^\0\r\n]+$/),
    commit: RevisionSchema,
    dirtyDigest: Sha256DigestSchema,
  })
  .strict();
export type RepositoryRevision = z.infer<typeof RepositoryRevisionSchema>;

export const AdapterRevisionSchema = z
  .object({
    name: IdentifierSchema,
    version: z.string().trim().min(1).max(128),
    indexRevision: RevisionSchema,
  })
  .strict();
export type AdapterRevision = z.infer<typeof AdapterRevisionSchema>;

export const AnchorRoleSchema = z.enum([
  "entry",
  "sink",
  "route",
  "table",
  "queue",
  "external-integration",
]);

export const AnchorSelectorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("symbol"), value: z.string().trim().min(1).max(1_024) }).strict(),
  z.object({ type: z.literal("path"), path: RepositoryRelativePathSchema }).strict(),
  z
    .object({
      type: z.literal("text"),
      query: z.string().min(1).max(512),
      fixed: z.literal(true),
    })
    .strict(),
  z
    .object({
      type: z.literal("external"),
      system: LabelSchema,
      reference: z.string().trim().min(1).max(2_048),
    })
    .strict(),
]);

export const WorkflowStageSchema = z
  .object({
    id: IdentifierSchema,
    label: LabelSchema,
    order: z.number().int().nonnegative().max(10_000),
    description: DescriptionSchema.optional(),
  })
  .strict();
export type WorkflowStage = z.infer<typeof WorkflowStageSchema>;

export const WorkflowAnchorSchema = z
  .object({
    id: IdentifierSchema,
    label: LabelSchema,
    role: AnchorRoleSchema,
    nodeKind: NodeKindSchema,
    selector: AnchorSelectorSchema,
    stageId: IdentifierSchema.optional(),
    description: DescriptionSchema.optional(),
  })
  .strict()
  .refine((value) => value.nodeKind !== "stage", {
    message: "Workflow anchors cannot create L0 stage nodes; declare stages separately.",
    path: ["nodeKind"],
  });
export type WorkflowAnchor = z.infer<typeof WorkflowAnchorSchema>;

export const AcceptedSemanticLinkSchema = z
  .object({
    sourceAnchorId: IdentifierSchema,
    targetAnchorId: IdentifierSchema,
    kind: z.literal("semantic-link"),
    label: LabelSchema.optional(),
    rationale: DescriptionSchema,
  })
  .strict();

export const CuratedRelationshipKindSchema = z.enum([
  "async-handoff",
  "poll",
  "claim",
  "state-read",
  "state-write",
  "transaction-enter",
  "transaction-commit",
  "retry",
  "failure-exit",
  "semantic-link",
]);

export const AcceptedRelationshipSchema = z
  .object({
    sourceAnchorId: IdentifierSchema,
    targetAnchorId: IdentifierSchema,
    kind: CuratedRelationshipKindSchema,
    label: LabelSchema.optional(),
    rationale: DescriptionSchema,
  })
  .strict();
export type AcceptedRelationship = z.infer<typeof AcceptedRelationshipSchema>;

export const WorkflowManifestSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_MANIFEST_SCHEMA),
    id: IdentifierSchema,
    name: LabelSchema,
    description: DescriptionSchema.optional(),
    repository: RepositoryReferenceSchema,
    anchors: z.array(WorkflowAnchorSchema).min(1).max(128),
    stages: z.array(WorkflowStageSchema).max(64),
    exclusions: z.array(z.string().trim().min(1).max(512)).max(128),
    acceptedSemanticLinks: z.array(AcceptedSemanticLinkSchema).max(256),
    acceptedRelationships: z.array(AcceptedRelationshipSchema).max(256).optional(),
    discoveryBounds: z
      .object({
        depth: z.number().int().min(1).max(8),
        maximumNodes: z.number().int().min(1).max(MAX_VISIBLE_NODES),
      })
      .strict()
      .optional(),
    presentation: z
      .object({
        direction: z.literal("RIGHT"),
        defaultOverlay: GraphOverlaySchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const stageIds = new Set<string>();
    const stageOrders = new Set<number>();
    for (const [index, stage] of value.stages.entries()) {
      if (stageIds.has(stage.id)) {
        context.addIssue({
          code: "custom",
          message: "Stage IDs must be unique.",
          path: ["stages", index, "id"],
        });
      }
      stageIds.add(stage.id);
      if (stageOrders.has(stage.order)) {
        context.addIssue({
          code: "custom",
          message: "Stage order values must be unique.",
          path: ["stages", index, "order"],
        });
      }
      stageOrders.add(stage.order);
    }

    const anchorIds = new Set<string>();
    for (const [index, anchor] of value.anchors.entries()) {
      if (anchorIds.has(anchor.id)) {
        context.addIssue({
          code: "custom",
          message: "Anchor IDs must be unique.",
          path: ["anchors", index, "id"],
        });
      }
      anchorIds.add(anchor.id);
      if (anchor.stageId !== undefined && !stageIds.has(anchor.stageId)) {
        context.addIssue({
          code: "custom",
          message: "Anchor stageId must reference a declared stage.",
          path: ["anchors", index, "stageId"],
        });
      }
    }

    const relationships = [...value.acceptedSemanticLinks, ...(value.acceptedRelationships ?? [])];
    const relationshipIdentities = new Set<string>();
    for (const [index, link] of relationships.entries()) {
      if (!anchorIds.has(link.sourceAnchorId) || !anchorIds.has(link.targetAnchorId)) {
        context.addIssue({
          code: "custom",
          message: "Accepted relationships must reference declared anchors.",
          path:
            index < value.acceptedSemanticLinks.length
              ? ["acceptedSemanticLinks", index]
              : ["acceptedRelationships", index - value.acceptedSemanticLinks.length],
        });
      }
      const identity = `${link.sourceAnchorId}\0${link.targetAnchorId}\0${link.kind}`;
      if (relationshipIdentities.has(identity)) {
        context.addIssue({
          code: "custom",
          message: "Accepted relationships must have unique endpoints and kinds.",
          path:
            index < value.acceptedSemanticLinks.length
              ? ["acceptedSemanticLinks", index]
              : ["acceptedRelationships", index - value.acceptedSemanticLinks.length],
        });
      }
      relationshipIdentities.add(identity);
    }
  });
export type WorkflowManifest = z.infer<typeof WorkflowManifestSchema>;

export const GraphNodeSchema = z
  .object({
    id: IdentifierSchema,
    kind: NodeKindSchema,
    label: LabelSchema,
    level: GraphLevelSchema,
    parentId: IdentifierSchema.optional(),
    stageId: IdentifierSchema.optional(),
    qualifiedName: z.string().trim().min(1).max(1_024).optional(),
    signature: z.string().trim().min(1).max(2_048).optional(),
    summary: DescriptionSchema.optional(),
    evidenceIds: z.array(IdentifierSchema).min(1).max(256),
    attributes: AttributesSchema.optional(),
  })
  .strict();
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z
  .object({
    id: IdentifierSchema,
    source: IdentifierSchema,
    target: IdentifierSchema,
    kind: EdgeKindSchema,
    assertion: EdgeAssertionSchema,
    evidenceIds: z.array(IdentifierSchema).min(1).max(256),
    label: LabelSchema.optional(),
    condition: DescriptionSchema.optional(),
    attributes: AttributesSchema.optional(),
  })
  .strict();
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const GraphWarningSchema = z
  .object({
    code: IdentifierSchema,
    message: DescriptionSchema,
    retryable: z.boolean(),
    relatedIds: z.array(IdentifierSchema).max(64).optional(),
  })
  .strict();
export type GraphWarning = z.infer<typeof GraphWarningSchema>;

export const GraphPresentationSchema = z
  .object({
    schemaVersion: z.literal(GRAPH_PRESENTATION_SCHEMA),
    direction: z.literal("RIGHT"),
    defaultOverlay: GraphOverlaySchema,
  })
  .strict();
export type GraphPresentation = z.infer<typeof GraphPresentationSchema>;

export const GraphLayoutHintsSchema = z
  .object({
    schemaVersion: z.literal(GRAPH_LAYOUT_HINTS_SCHEMA),
    stageOrder: z.array(IdentifierSchema).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.stageOrder).size !== value.stageOrder.length) {
      context.addIssue({ code: "custom", message: "Layout stageOrder IDs must be unique." });
    }
  });
export type GraphLayoutHints = z.infer<typeof GraphLayoutHintsSchema>;

export const GraphSnapshotSchema = z
  .object({
    schemaVersion: z.literal(GRAPH_SNAPSHOT_SCHEMA),
    id: IdentifierSchema,
    workflowManifestId: IdentifierSchema,
    repository: RepositoryRevisionSchema,
    adapter: AdapterRevisionSchema,
    nodes: z.array(GraphNodeSchema).max(MAX_GRAPH_NODES),
    edges: z.array(GraphEdgeSchema).max(MAX_GRAPH_EDGES),
    evidence: z.array(EvidenceRecordSchema).max(MAX_GRAPH_EVIDENCE),
    warnings: z.array(GraphWarningSchema).max(512),
    presentation: GraphPresentationSchema,
    layoutHints: GraphLayoutHintsSchema,
    extraction: EvidenceReferenceSliceSchema.optional(),
    runtimeEvidence: EvidenceReferenceSliceSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const evidenceById = new Map(value.evidence.map((record) => [record.id, record]));
    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();
    const evidenceIds = new Set<string>();

    for (const [index, record] of value.evidence.entries()) {
      if (evidenceIds.has(record.id)) {
        context.addIssue({
          code: "custom",
          message: "Evidence IDs must be unique.",
          path: ["evidence", index, "id"],
        });
      }
      evidenceIds.add(record.id);
    }
    for (const [field, slice] of [
      ["extraction", value.extraction],
      ["runtimeEvidence", value.runtimeEvidence],
    ] as const) {
      if (slice?.status !== "succeeded") continue;
      for (const [index, evidenceId] of slice.items.entries()) {
        if (!evidenceIds.has(evidenceId)) {
          context.addIssue({
            code: "custom",
            message: `${field} items must reference graph evidence.`,
            path: [field, "items", index],
          });
        }
      }
    }

    const nodeById = new Map(value.nodes.map((node) => [node.id, node]));
    for (const [index, node] of value.nodes.entries()) {
      if (nodeIds.has(node.id)) {
        context.addIssue({
          code: "custom",
          message: "Node IDs must be unique.",
          path: ["nodes", index, "id"],
        });
      }
      nodeIds.add(node.id);
      if (node.kind === "stage" && node.level !== "L0") {
        context.addIssue({
          code: "custom",
          message: "Stage nodes must use level L0.",
          path: ["nodes", index, "level"],
        });
      }
      for (const evidenceId of node.evidenceIds) {
        if (!evidenceById.has(evidenceId)) {
          context.addIssue({
            code: "custom",
            message: "Node evidenceIds must reference graph evidence.",
            path: ["nodes", index, "evidenceIds"],
          });
        }
      }
    }

    const stageNodeIds = value.nodes.filter((node) => node.kind === "stage").map((node) => node.id);
    if (
      value.layoutHints.stageOrder.length !== stageNodeIds.length ||
      value.layoutHints.stageOrder.some((id) => !stageNodeIds.includes(id))
    ) {
      context.addIssue({
        code: "custom",
        message: "layoutHints.stageOrder must contain every L0 stage node exactly once.",
        path: ["layoutHints", "stageOrder"],
      });
    }

    for (const [index, node] of value.nodes.entries()) {
      if (node.parentId !== undefined && !nodeIds.has(node.parentId)) {
        context.addIssue({
          code: "custom",
          message: "parentId must reference a graph node.",
          path: ["nodes", index, "parentId"],
        });
      }
      if (node.parentId === node.id) {
        context.addIssue({
          code: "custom",
          message: "A node cannot be its own parent.",
          path: ["nodes", index, "parentId"],
        });
      }
      if (node.stageId !== undefined) {
        const stage = nodeById.get(node.stageId);
        if (stage?.kind !== "stage") {
          context.addIssue({
            code: "custom",
            message: "stageId must reference an L0 stage node.",
            path: ["nodes", index, "stageId"],
          });
        }
      }
    }

    const completelyVisited = new Set<string>();
    for (const [index, node] of value.nodes.entries()) {
      if (completelyVisited.has(node.id)) continue;
      const currentChain = new Set<string>();
      let current: (typeof value.nodes)[number] | undefined = node;
      while (current !== undefined && !completelyVisited.has(current.id)) {
        if (currentChain.has(current.id)) {
          context.addIssue({
            code: "custom",
            message: "Node parent relationships must be acyclic.",
            path: ["nodes", index, "parentId"],
          });
          break;
        }
        currentChain.add(current.id);
        current = current.parentId === undefined ? undefined : nodeById.get(current.parentId);
      }
      for (const nodeId of currentChain) completelyVisited.add(nodeId);
    }

    for (const [index, edge] of value.edges.entries()) {
      if (edgeIds.has(edge.id)) {
        context.addIssue({
          code: "custom",
          message: "Edge IDs must be unique.",
          path: ["edges", index, "id"],
        });
      }
      edgeIds.add(edge.id);
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
        context.addIssue({
          code: "custom",
          message: "Edge endpoints must reference graph nodes.",
          path: ["edges", index],
        });
      }
      const referencedEvidence = edge.evidenceIds.map((id) => evidenceById.get(id));
      if (referencedEvidence.some((record) => record === undefined)) {
        context.addIssue({
          code: "custom",
          message: "Edge evidenceIds must reference graph evidence.",
          path: ["edges", index, "evidenceIds"],
        });
      }
      const hasAiEvidence = referencedEvidence.some((record) => record?.kind === "ai-inferred");
      const hasRuntimeEvidence = referencedEvidence.some(
        (record) => record?.kind === "runtime-observed",
      );
      const hasStaticEvidence = referencedEvidence.some((record) => record?.kind === "graft-exact");
      const hasCuratedEvidence = referencedEvidence.some(
        (record) => record?.kind === "human-curated",
      );
      if (edge.kind !== "semantic-link" && hasAiEvidence) {
        context.addIssue({
          code: "custom",
          message: "AI-inferred evidence cannot support a static or operational edge.",
          path: ["edges", index, "evidenceIds"],
        });
      }
      if (edge.assertion === "ai-inferred" && edge.kind !== "semantic-link") {
        context.addIssue({
          code: "custom",
          message: "AI-inferred edges must be semantic-link edges.",
          path: ["edges", index, "kind"],
        });
      }
      if (edge.assertion === "ai-inferred" && !hasAiEvidence) {
        context.addIssue({
          code: "custom",
          message: "AI-inferred semantic links must cite AI-inferred evidence.",
          path: ["edges", index, "evidenceIds"],
        });
      }
      if (hasAiEvidence && edge.assertion !== "ai-inferred") {
        context.addIssue({
          code: "custom",
          message: "AI-inferred evidence requires an ai-inferred assertion.",
          path: ["edges", index, "assertion"],
        });
      }
      if (edge.assertion === "static-possible" && !hasStaticEvidence) {
        context.addIssue({
          code: "custom",
          message: "Static-possible edges require Graft static evidence.",
          path: ["edges", index, "evidenceIds"],
        });
      }
      if (edge.assertion === "curated-workflow" && !hasCuratedEvidence) {
        context.addIssue({
          code: "custom",
          message: "Curated-workflow edges require human-curated evidence.",
          path: ["edges", index, "evidenceIds"],
        });
      }
      if (edge.assertion === "runtime-observed" && !hasRuntimeEvidence) {
        context.addIssue({
          code: "custom",
          message: "Runtime-observed edges require runtime evidence.",
          path: ["edges", index, "evidenceIds"],
        });
      }
      if (edge.assertion !== "runtime-observed" && hasRuntimeEvidence) {
        context.addIssue({
          code: "custom",
          message: "Runtime evidence requires a runtime-observed assertion.",
          path: ["edges", index, "assertion"],
        });
      }
    }
  });
export type GraphSnapshot = z.infer<typeof GraphSnapshotSchema>;

export function validateGraphSnapshot(value: unknown): GraphSnapshot {
  return GraphSnapshotSchema.parse(value);
}

export const DiffEntitySchema = z.enum(["stage", "node", "edge", "evidence"]);
export const GraphDiffEntrySchema = z
  .object({
    entity: DiffEntitySchema,
    id: IdentifierSchema,
    beforeId: IdentifierSchema.optional(),
    afterId: IdentifierSchema.optional(),
    status: DiffStatusSchema,
    reason: z.string().trim().min(1).max(512),
    beforeDigest: Sha256DigestSchema.optional(),
    afterDigest: Sha256DigestSchema.optional(),
  })
  .strict();
export type GraphDiffEntry = z.infer<typeof GraphDiffEntrySchema>;

export const DiffSummarySchema = z
  .object({
    current: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
    broken: z.number().int().nonnegative(),
    unverified: z.number().int().nonnegative(),
  })
  .strict();

export const GraphDiffSchema = z
  .object({
    schemaVersion: z.literal(GRAPH_DIFF_SCHEMA),
    id: IdentifierSchema,
    workflowManifestId: IdentifierSchema,
    baseGraphId: IdentifierSchema,
    targetGraphId: IdentifierSchema.optional(),
    baseRepository: RepositoryRevisionSchema,
    targetRepository: RepositoryRevisionSchema.optional(),
    entries: z
      .array(GraphDiffEntrySchema)
      .max(2 * (MAX_GRAPH_NODES + MAX_GRAPH_EDGES + MAX_GRAPH_EVIDENCE)),
    summary: DiffSummarySchema,
    warnings: z.array(GraphWarningSchema).max(512),
  })
  .strict();
export type GraphDiff = z.infer<typeof GraphDiffSchema>;

export const ExportRepositorySchema = z
  .object({
    identity: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .regex(/^[^\0\r\n]+$/),
    commit: RevisionSchema,
  })
  .strict();

export const ExportBundleSchema = z
  .object({
    schemaVersion: z.literal(EXPORT_BUNDLE_SCHEMA),
    graphId: IdentifierSchema,
    workflowManifestId: IdentifierSchema,
    repository: ExportRepositorySchema,
    adapter: AdapterRevisionSchema,
    nodes: z.array(GraphNodeSchema).max(MAX_GRAPH_NODES),
    edges: z.array(GraphEdgeSchema).max(MAX_GRAPH_EDGES),
    evidence: z.array(EvidenceRecordSchema).max(MAX_GRAPH_EVIDENCE),
    warnings: z.array(GraphWarningSchema).max(512),
    presentation: GraphPresentationSchema,
    layoutHints: GraphLayoutHintsSchema,
    extraction: EvidenceReferenceSliceSchema.optional(),
    runtimeEvidence: EvidenceReferenceSliceSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const stageNodeIds = value.nodes.filter((node) => node.kind === "stage").map((node) => node.id);
    if (
      value.layoutHints.stageOrder.length !== stageNodeIds.length ||
      value.layoutHints.stageOrder.some((id) => !stageNodeIds.includes(id))
    ) {
      context.addIssue({
        code: "custom",
        message: "layoutHints.stageOrder must contain every exported stage node exactly once.",
        path: ["layoutHints", "stageOrder"],
      });
    }
  });
export type ExportBundle = z.infer<typeof ExportBundleSchema>;

export const DiscoveredEvidenceDraftSchema = z
  .object({
    key: IdentifierSchema,
    kind: EvidenceKindSchema,
    state: EvidenceStateSchema,
    revision: RevisionSchema,
    source: EvidenceSourceSchema,
    contentDigest: Sha256DigestSchema,
    producer: EvidenceProducerSchema,
    details: DescriptionSchema.optional(),
    attributes: AttributesSchema.optional(),
  })
  .strict();
export type DiscoveredEvidenceDraft = z.infer<typeof DiscoveredEvidenceDraftSchema>;

export const DiscoveredNodeDraftSchema = z
  .object({
    key: IdentifierSchema,
    anchorId: IdentifierSchema.optional(),
    kind: NodeKindSchema,
    label: LabelSchema,
    level: z.enum(["L1", "L2"]),
    parentKey: IdentifierSchema.optional(),
    stageId: IdentifierSchema.optional(),
    qualifiedName: z.string().trim().min(1).max(1_024).optional(),
    signature: z.string().trim().min(1).max(2_048).optional(),
    summary: DescriptionSchema.optional(),
    evidenceKeys: z.array(IdentifierSchema).min(1).max(256),
    attributes: AttributesSchema.optional(),
  })
  .strict()
  .refine((value) => value.kind !== "stage", {
    message: "Adapter node drafts cannot create L0 stage nodes.",
    path: ["kind"],
  });
export type DiscoveredNodeDraft = z.infer<typeof DiscoveredNodeDraftSchema>;

export const DiscoveredEdgeDraftSchema = z
  .object({
    key: IdentifierSchema.optional(),
    sourceKey: IdentifierSchema,
    targetKey: IdentifierSchema,
    kind: EdgeKindSchema,
    assertion: EdgeAssertionSchema,
    evidenceKeys: z.array(IdentifierSchema).min(1).max(256),
    label: LabelSchema.optional(),
    condition: DescriptionSchema.optional(),
    attributes: AttributesSchema.optional(),
  })
  .strict();
export type DiscoveredEdgeDraft = z.infer<typeof DiscoveredEdgeDraftSchema>;

export const GraphBuildInputSchema = z
  .object({
    repository: RepositoryRevisionSchema,
    adapter: AdapterRevisionSchema,
    evidence: z.array(DiscoveredEvidenceDraftSchema).max(MAX_GRAPH_EVIDENCE),
    nodes: z.array(DiscoveredNodeDraftSchema).max(MAX_GRAPH_NODES),
    edges: z.array(DiscoveredEdgeDraftSchema).max(MAX_GRAPH_EDGES),
    warnings: z.array(GraphWarningSchema).max(512),
    extraction: EvidenceReferenceSliceSchema.optional(),
    runtimeEvidence: EvidenceReferenceSliceSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const evidenceKeys = new Set(value.evidence.map((record) => record.key));
    for (const [field, slice] of [
      ["extraction", value.extraction],
      ["runtimeEvidence", value.runtimeEvidence],
    ] as const) {
      if (slice?.status !== "succeeded") continue;
      for (const [index, evidenceKey] of slice.items.entries()) {
        if (!evidenceKeys.has(evidenceKey)) {
          context.addIssue({
            code: "custom",
            message: `${field} items must reference discovered evidence keys.`,
            path: [field, "items", index],
          });
        }
      }
    }
  });
export type GraphBuildInput = z.infer<typeof GraphBuildInputSchema>;

export const GraphDirectionSchema = z.enum(["out", "in", "both"]);
export type GraphDirection = z.infer<typeof GraphDirectionSchema>;

export const GraphQuerySchema = z
  .object({
    text: z.string().trim().max(512).optional(),
    nodeKinds: z.array(NodeKindSchema).max(NodeKindSchema.options.length).optional(),
    edgeKinds: z.array(EdgeKindSchema).max(EdgeKindSchema.options.length).optional(),
    evidenceStates: z.array(EvidenceStateSchema).max(EvidenceStateSchema.options.length).optional(),
    levels: z.array(GraphLevelSchema).max(GraphLevelSchema.options.length).optional(),
    stageIds: z.array(IdentifierSchema).max(64).optional(),
    anchorNodeIds: z.array(IdentifierSchema).max(64).optional(),
    direction: GraphDirectionSchema.optional(),
    maxDepth: z.number().int().nonnegative().max(32).optional(),
    limit: z.number().int().positive().max(MAX_VISIBLE_NODES).optional(),
  })
  .strict();
export type GraphQuery = z.infer<typeof GraphQuerySchema>;

export const CallFlowCapabilitySchema = z
  .object({
    token: z
      .string()
      .min(32)
      .max(512)
      .regex(/^[A-Za-z0-9._~+/=-]+$/),
    expiresAt: TimestampSchema,
    repositoryRevision: RevisionSchema,
    graphRevision: IdentifierSchema,
    sourceByteBudget: z
      .number()
      .int()
      .nonnegative()
      .max(8 * 1024 * 1024),
  })
  .strict();
export type CallFlowCapability = z.infer<typeof CallFlowCapabilitySchema>;

export const CallFlowUiPayloadSchema = z
  .object({
    schema: z.literal(CALLFLOW_UI_PAYLOAD_SCHEMA),
    sessionId: IdentifierSchema,
    capability: CallFlowCapabilitySchema,
    snapshot: GraphSnapshotSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.capability.graphRevision !== value.snapshot.id) {
      context.addIssue({
        code: "custom",
        message: "Capability graphRevision must match the enclosed snapshot.",
        path: ["capability", "graphRevision"],
      });
    }
    if (value.capability.repositoryRevision !== value.snapshot.repository.commit) {
      context.addIssue({
        code: "custom",
        message: "Capability repositoryRevision must match the enclosed snapshot.",
        path: ["capability", "repositoryRevision"],
      });
    }
  });
export type CallFlowUiPayload = z.infer<typeof CallFlowUiPayloadSchema>;

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x80) bytes += 1;
    else if (codeUnit < 0x800) bytes += 2;
    else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

export const CallFlowSourceExcerptSchema = z
  .object({
    schema: z.literal(CALLFLOW_SOURCE_SCHEMA),
    evidenceId: IdentifierSchema,
    path: RepositoryRelativePathSchema,
    startLine: z.number().int().positive().max(10_000_000),
    endLine: z.number().int().positive().max(10_000_000),
    content: z.string().max(MAX_SOURCE_EXCERPT_BYTES),
    truncated: z.boolean(),
    remainingByteBudget: z
      .number()
      .int()
      .nonnegative()
      .max(8 * 1024 * 1024),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endLine < value.startLine) {
      context.addIssue({
        code: "custom",
        message: "endLine must not precede startLine.",
        path: ["endLine"],
      });
    }
    if (utf8ByteLength(value.content) > MAX_SOURCE_EXCERPT_BYTES) {
      context.addIssue({
        code: "custom",
        message: `Source excerpts are limited to ${MAX_SOURCE_EXCERPT_BYTES} UTF-8 bytes.`,
        path: ["content"],
      });
    }
  });
export type CallFlowSourceExcerpt = z.infer<typeof CallFlowSourceExcerptSchema>;

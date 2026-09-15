import { describe, expect, test } from "bun:test";

import {
  CallFlowCapabilityUpdateSchema,
  CallFlowLayoutResultSchema,
  CallFlowNodeListResultSchema,
  CallFlowSourceExcerptSchema,
  CallFlowSourcePublicResultSchema,
  CallFlowUiPayloadSchema,
  EdgeAssertionSchema,
  EdgeKindSchema,
  EvidenceKindSchema,
  EvidenceSliceSchema,
  EvidenceStateSchema,
  GraphSnapshotSchema,
  NodeKindSchema,
  WorkflowManifestSchema,
  type GraphSnapshot,
} from "../src/index.js";

const digest = `sha256:${"a".repeat(64)}`;

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected test fixture value.");
  return value;
}

function validSnapshot(): GraphSnapshot {
  return {
    schemaVersion: "callflow/graph-snapshot-v1",
    id: "graph-1",
    workflowManifestId: "workflow-1",
    repository: { identity: "example/repository", commit: "abc123", dirtyDigest: digest },
    adapter: { name: "graft", version: "0.18.0", indexRevision: "index-1" },
    nodes: [
      {
        id: "node-1",
        kind: "function",
        label: "handle",
        level: "L1",
        evidenceIds: ["evidence-1"],
      },
      {
        id: "node-2",
        kind: "function",
        label: "store",
        level: "L1",
        evidenceIds: ["evidence-1"],
      },
    ],
    edges: [
      {
        id: "edge-1",
        source: "node-1",
        target: "node-2",
        kind: "direct-call",
        assertion: "static-possible",
        evidenceIds: ["evidence-1"],
      },
    ],
    evidence: [
      {
        id: "evidence-1",
        kind: "graft-exact",
        state: "exact",
        revision: "abc123",
        source: {
          type: "source-span",
          path: "src/handler.ts",
          start: { line: 10, column: 1 },
          end: { line: 12, column: 2 },
        },
        contentDigest: digest,
        producer: { name: "graft", version: "0.18.0" },
      },
    ],
    warnings: [],
    presentation: {
      schemaVersion: "callflow/graph-presentation-v1",
      direction: "RIGHT",
      defaultOverlay: "none",
    },
    layoutHints: {
      schemaVersion: "callflow/graph-layout-hints-v1",
      stageOrder: [],
    },
    extraction: { status: "succeeded", items: ["evidence-1"] },
    runtimeEvidence: {
      status: "unavailable",
      reason: "Runtime evidence is unavailable in CallFlow v1.",
    },
  };
}

describe("CallFlow versioned contracts", () => {
  test("locks the exact v1 enum vocabulary", () => {
    expect(NodeKindSchema.options).toEqual([
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
    expect(EdgeKindSchema.options).toContainAllValues([
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
    expect(EdgeAssertionSchema.options).toEqual([
      "static-possible",
      "curated-workflow",
      "ai-inferred",
      "runtime-observed",
    ]);
    expect(EvidenceKindSchema.options).toEqual([
      "graft-exact",
      "source-literal",
      "human-curated",
      "ai-inferred",
      "runtime-observed",
    ]);
    expect(EvidenceStateSchema.options).toEqual([
      "exact",
      "ambiguous",
      "stale",
      "failed",
      "unavailable",
    ]);
  });

  test("keeps failed and unavailable evidence distinct from a healthy empty result", () => {
    const schema = EvidenceSliceSchema(GraphSnapshotSchema);
    expect(schema.parse({ status: "succeeded", items: [] })).toEqual({
      status: "succeeded",
      items: [],
    });
    expect(schema.parse({ status: "failed", code: "timeout", retryable: true })).toEqual({
      status: "failed",
      code: "timeout",
      retryable: true,
    });
    expect(schema.parse({ status: "unavailable", reason: "Graft index is missing." })).toEqual({
      status: "unavailable",
      reason: "Graft index is missing.",
    });
  });

  test("shares strict bounded helper contracts across server and browser", () => {
    expect(
      CallFlowCapabilityUpdateSchema.safeParse({
        schema: "callflow/capability-update-v1",
        sessionId: "session-1",
        capability: {
          token: "a".repeat(32),
          expiresAt: "2099-01-01T00:00:00.000Z",
          repositoryRevision: "commit-1",
          graphRevision: "graph-1",
          sourceByteBudget: 1_024,
        },
      }).success,
    ).toBe(true);
    expect(CallFlowNodeListResultSchema.safeParse({ nodeIds: ["node-1", "node-1"] }).success).toBe(
      false,
    );
    expect(
      CallFlowLayoutResultSchema.safeParse({
        schema: "callflow/layout-v1",
        graphRevision: "graph-1",
        engine: "elk",
        positions: [{ nodeId: "node-1", x: Number.POSITIVE_INFINITY, y: 0 }],
      }).success,
    ).toBe(false);
    expect(
      CallFlowSourcePublicResultSchema.safeParse({
        schema: "callflow/source-v1",
        evidenceId: "evidence-1",
        path: "src/handler.ts",
        startLine: 12,
        endLine: 10,
        truncated: false,
        remainingByteBudget: 1_024,
      }).success,
    ).toBe(false);
  });

  test("validates strict manifests and repository-relative anchors", () => {
    const manifest = {
      schemaVersion: "callflow/workflow-manifest-v1",
      id: "write-flow",
      name: "Write flow",
      repository: { identity: "example/repository" },
      anchors: [
        {
          id: "entry",
          label: "Handler",
          role: "entry",
          nodeKind: "function",
          selector: { type: "symbol", value: "handle" },
          stageId: "request",
        },
      ],
      stages: [{ id: "request", label: "Request", order: 0 }],
      exclusions: [],
      acceptedSemanticLinks: [],
      acceptedRelationships: [
        {
          sourceAnchorId: "entry",
          targetAnchorId: "entry",
          kind: "async-handoff",
          rationale: "A reviewed asynchronous handoff.",
        },
      ],
      discoveryBounds: { depth: 3, maximumNodes: 75 },
      presentation: { direction: "RIGHT", defaultOverlay: "none" },
    } as const;
    expect(WorkflowManifestSchema.safeParse(manifest).success).toBe(true);
    expect(
      WorkflowManifestSchema.safeParse({
        ...manifest,
        anchors: [{ ...manifest.anchors[0], selector: { type: "path", path: "../secret" } }],
      }).success,
    ).toBe(false);
    expect(WorkflowManifestSchema.safeParse({ ...manifest, unexpected: true }).success).toBe(false);
    expect(
      WorkflowManifestSchema.safeParse({
        ...manifest,
        discoveryBounds: { depth: 0, maximumNodes: 251 },
      }).success,
    ).toBe(false);
    expect(
      WorkflowManifestSchema.safeParse({
        ...manifest,
        stages: [...manifest.stages, { id: "duplicate-order", label: "Duplicate order", order: 0 }],
      }).success,
    ).toBe(false);
    expect(
      WorkflowManifestSchema.safeParse({
        ...manifest,
        acceptedRelationships: [{ ...manifest.acceptedRelationships[0], kind: "direct-call" }],
      }).success,
    ).toBe(false);
    expect(
      WorkflowManifestSchema.safeParse({
        ...manifest,
        acceptedSemanticLinks: [
          {
            ...manifest.acceptedRelationships[0],
            kind: "semantic-link",
          },
        ],
        acceptedRelationships: [
          {
            ...manifest.acceptedRelationships[0],
            kind: "semantic-link",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      WorkflowManifestSchema.safeParse({
        ...manifest,
        schemaVersion: "callflow/workflow-manifest-v2",
      }).success,
    ).toBe(false);
  });
});

describe("CallFlow graph invariants", () => {
  test("requires resolvable evidence for every node and edge", () => {
    const parsed = GraphSnapshotSchema.parse(validSnapshot());
    expect(parsed.extraction).toEqual({ status: "succeeded", items: ["evidence-1"] });
    expect(parsed.runtimeEvidence?.status).toBe("unavailable");
    const snapshot = validSnapshot();
    snapshot.nodes[0] = { ...required(snapshot.nodes[0]), evidenceIds: ["missing"] };
    expect(GraphSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  test("requires versioned presentation and complete deterministic stage layout hints", () => {
    const snapshot = validSnapshot();
    snapshot.nodes.unshift({
      id: "stage-1",
      kind: "stage",
      label: "Request",
      level: "L0",
      evidenceIds: ["evidence-1"],
    });
    snapshot.layoutHints.stageOrder = ["stage-1"];
    expect(GraphSnapshotSchema.safeParse(snapshot).success).toBe(true);

    expect(GraphSnapshotSchema.safeParse({ ...snapshot, presentation: undefined }).success).toBe(
      false,
    );
    expect(
      GraphSnapshotSchema.safeParse({
        ...snapshot,
        layoutHints: { ...snapshot.layoutHints, stageOrder: [] },
      }).success,
    ).toBe(false);
    expect(
      GraphSnapshotSchema.safeParse({
        ...snapshot,
        presentation: { ...snapshot.presentation, schemaVersion: "callflow/graph-presentation-v2" },
      }).success,
    ).toBe(false);
  });

  test("never permits AI evidence to support a static edge", () => {
    const snapshot = validSnapshot();
    snapshot.evidence[0] = { ...required(snapshot.evidence[0]), kind: "ai-inferred" };
    expect(GraphSnapshotSchema.safeParse(snapshot).success).toBe(false);

    snapshot.edges[0] = {
      ...required(snapshot.edges[0]),
      kind: "semantic-link",
      assertion: "ai-inferred",
    };
    expect(GraphSnapshotSchema.safeParse(snapshot).success).toBe(true);

    snapshot.edges[0] = {
      ...required(snapshot.edges[0]),
      kind: "semantic-link",
      assertion: "static-possible",
    };
    expect(GraphSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  test("does not let source-literal anchor evidence synthesize relationships", () => {
    const snapshot = validSnapshot();
    snapshot.evidence[0] = { ...required(snapshot.evidence[0]), kind: "source-literal" };
    expect(GraphSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  test("binds private UI capabilities to graph and repository revisions", () => {
    const snapshot = validSnapshot();
    const payload = {
      schema: "callflow/ui-payload-v1",
      sessionId: "session-1",
      capability: {
        token: "x".repeat(32),
        expiresAt: "2026-09-15T12:00:00.000Z",
        repositoryRevision: snapshot.repository.commit,
        graphRevision: snapshot.id,
        sourceByteBudget: 24 * 1024,
      },
      snapshot,
    } as const;
    expect(CallFlowUiPayloadSchema.safeParse(payload).success).toBe(true);
    expect(
      CallFlowUiPayloadSchema.safeParse({
        ...payload,
        capability: { ...payload.capability, graphRevision: "different" },
      }).success,
    ).toBe(false);
  });

  test("bounds source excerpts by UTF-8 bytes and ordered lines", () => {
    const excerpt = {
      schema: "callflow/source-v1",
      evidenceId: "evidence-1",
      path: "src/handler.ts",
      startLine: 2,
      endLine: 3,
      content: "return value;",
      truncated: false,
      remainingByteBudget: 1_024,
    } as const;
    expect(CallFlowSourceExcerptSchema.safeParse(excerpt).success).toBe(true);
    expect(
      CallFlowSourceExcerptSchema.safeParse({ ...excerpt, content: "🙂".repeat(7_000) }).success,
    ).toBe(false);
    expect(CallFlowSourceExcerptSchema.safeParse({ ...excerpt, endLine: 1 }).success).toBe(false);
  });
});

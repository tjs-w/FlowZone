import { describe, expect, test } from "bun:test";

import {
  metadataCapabilityUpdate,
  metadataPayload,
  parseBootstrapPayloadText,
  parseLayoutResult,
  parseNodeListResult,
  parseSourceExcerpt,
} from "../src/payload";

const digest = `sha256:${"1".repeat(64)}`;
const payload = {
  schema: "callflow/ui-payload-v1",
  sessionId: "session-1",
  capability: {
    token: "a".repeat(32),
    expiresAt: "2099-01-01T00:00:00.000Z",
    repositoryRevision: "commit-1",
    graphRevision: "graph-1",
    sourceByteBudget: 24_576,
  },
  snapshot: {
    schemaVersion: "callflow/graph-snapshot-v1",
    id: "graph-1",
    workflowManifestId: "manifest-1",
    repository: { identity: "fixture", commit: "commit-1", dirtyDigest: digest },
    adapter: { name: "fixture", version: "1.0.0", indexRevision: "index-1" },
    nodes: [
      {
        id: "stage-1",
        kind: "stage",
        label: "Receive",
        level: "L0",
        evidenceIds: ["evidence-1"],
      },
    ],
    edges: [],
    evidence: [
      {
        id: "evidence-1",
        kind: "human-curated",
        state: "exact",
        revision: "commit-1",
        source: { type: "external-reference", system: "Fixture", reference: "receive" },
        contentDigest: digest,
        producer: { name: "fixture", version: "1.0.0" },
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
      stageOrder: ["stage-1"],
    },
  },
} as const;

describe("CallFlow browser payload boundaries", () => {
  test("accepts the typed FlowZone envelope and legacy private graph metadata", () => {
    expect(
      metadataPayload({
        _meta: {
          flowzone: {
            schema: "flowzone/ui-v1",
            plugin: "callflow",
            action: "discover",
            view: "workflow",
            payload,
          },
        },
      })?.snapshot.id,
    ).toBe("graph-1");
    expect(metadataPayload({ _meta: { callflowGraph: payload } })?.snapshot.id).toBe("graph-1");
    expect(metadataPayload({ structuredContent: { callflowGraph: payload } })).toBeUndefined();
    expect(
      metadataPayload({
        _meta: {
          flowzone: {
            schema: "flowzone/ui-v1",
            plugin: "dyna",
            action: "discover",
            view: "workflow",
            payload,
          },
        },
      }),
    ).toBeUndefined();
    expect(
      metadataPayload({
        _meta: {
          callflowGraph: {
            ...payload,
            capability: { ...payload.capability, graphRevision: "wrong-graph" },
          },
        },
      }),
    ).toBeUndefined();
  });

  test("accepts source text only from strict private metadata", () => {
    const source = {
      schema: "callflow/source-v1",
      evidenceId: "evidence-1",
      path: "src/worker.ts",
      startLine: 4,
      endLine: 7,
      content: "await processClaim();",
      truncated: false,
      remainingByteBudget: 12_000,
    } as const;
    expect(parseSourceExcerpt({ _meta: { callflowSource: source } })?.content).toBe(
      "await processClaim();",
    );
    expect(parseSourceExcerpt({ structuredContent: source })).toBeUndefined();
    expect(
      parseSourceExcerpt({ _meta: { callflowSource: { ...source, extra: true } } }),
    ).toBeUndefined();
  });

  test("accepts only strict compact capability updates from private metadata", () => {
    const capabilityUpdate = {
      schema: "callflow/capability-update-v1",
      sessionId: "session-1",
      capability: {
        ...payload.capability,
        token: "b".repeat(32),
        sourceByteBudget: 12_000,
      },
    } as const;
    expect(metadataCapabilityUpdate({ _meta: { callflowCapability: capabilityUpdate } })).toEqual(
      capabilityUpdate,
    );
    expect(
      metadataCapabilityUpdate({ structuredContent: { callflowCapability: capabilityUpdate } }),
    ).toBeUndefined();
    expect(
      metadataCapabilityUpdate({
        _meta: { callflowCapability: { ...capabilityUpdate, snapshot: payload.snapshot } },
      }),
    ).toBeUndefined();
  });

  test("bounds helper node lists", () => {
    expect(
      parseNodeListResult({
        structuredContent: { nodeIds: ["a", "b"], edgeIds: ["edge-a"], truncated: false },
      }),
    ).toEqual({ nodeIds: ["a", "b"], edgeIds: ["edge-a"], truncated: false });
    expect(parseNodeListResult({ structuredContent: { nodeIds: ["a", 2] } })).toBeUndefined();
    expect(parseNodeListResult({ structuredContent: { nodeIds: ["a", "a"] } })).toBeUndefined();
    expect(
      parseNodeListResult({ structuredContent: { nodeIds: ["a"], unexpected: true } }),
    ).toBeUndefined();
    expect(
      parseNodeListResult({
        structuredContent: { nodeIds: Array.from({ length: 251 }, (_, index) => `n-${index}`) },
      }),
    ).toBeUndefined();
  });

  test("strictly validates bounded server layout positions", () => {
    const result = {
      structuredContent: {
        schema: "callflow/layout-v1",
        graphRevision: "graph-1",
        engine: "elk",
        positions: [{ nodeId: "stage-1", x: 120, y: 40 }],
      },
    };
    expect(parseLayoutResult(result)?.positions[0]).toEqual({ nodeId: "stage-1", x: 120, y: 40 });
    expect(
      parseLayoutResult({
        structuredContent: {
          ...result.structuredContent,
          positions: [{ nodeId: "stage-1", x: Number.POSITIVE_INFINITY, y: 0 }],
        },
      }),
    ).toBeUndefined();
    expect(
      parseLayoutResult({
        structuredContent: { ...result.structuredContent, unexpected: true },
      }),
    ).toBeUndefined();
  });

  test("accepts only a strict source-disabled standalone bootstrap envelope", () => {
    const standalone = {
      ...payload,
      capability: { ...payload.capability, sourceByteBudget: 0 },
    };
    expect(parseBootstrapPayloadText(JSON.stringify(standalone))?.snapshot.id).toBe("graph-1");
    expect(parseBootstrapPayloadText(JSON.stringify(payload))).toBeUndefined();
    expect(parseBootstrapPayloadText("{not-json")).toBeUndefined();
  });
});

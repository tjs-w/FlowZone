import { describe, expect, test } from "bun:test";

import { GraphSnapshotSchema, type GraphSnapshot } from "@callflow/contracts";

import { describeVisibleGraph, layoutSnapshotForVisible } from "../src/server.js";

function fixtureSnapshot(): GraphSnapshot {
  return GraphSnapshotSchema.parse({
    schemaVersion: "callflow/graph-snapshot-v1",
    id: "fixture-graph",
    workflowManifestId: "fixture-manifest",
    repository: {
      identity: "local:/Users/private/repository",
      commit: "fixture-commit",
      dirtyDigest: `sha256:${"0".repeat(64)}`,
    },
    adapter: { name: "graft", version: "0.18.0", indexRevision: "fixture-index" },
    nodes: [
      {
        id: "stage-node",
        kind: "stage",
        label: "Ingest stage",
        level: "L0",
        evidenceIds: ["stage-evidence"],
      },
      {
        id: "entry-node",
        kind: "function",
        label: "Run /Users/private/repository/secret.ts",
        level: "L1",
        stageId: "stage-node",
        evidenceIds: ["entry-evidence"],
      },
      {
        id: "sink-node",
        kind: "queue",
        label: "Publish result",
        level: "L1",
        evidenceIds: ["sink-evidence"],
      },
    ],
    edges: [
      {
        id: "handoff-edge",
        source: "entry-node",
        target: "sink-node",
        kind: "async-handoff",
        assertion: "curated-workflow",
        evidenceIds: ["edge-evidence"],
      },
    ],
    evidence: [
      ...["stage-evidence", "entry-evidence", "sink-evidence", "edge-evidence"].map((id) => ({
        id,
        kind: "human-curated" as const,
        state: id === "sink-evidence" ? ("ambiguous" as const) : ("exact" as const),
        revision: "fixture-commit",
        source: {
          type: "external-reference" as const,
          system: "fixture",
          reference: id,
        },
        contentDigest: `sha256:${"1".repeat(64)}`,
        producer: { name: "fixture", version: "1" },
      })),
    ],
    warnings: [],
    presentation: {
      schemaVersion: "callflow/graph-presentation-v1",
      direction: "RIGHT",
      defaultOverlay: "none",
    },
    layoutHints: {
      schemaVersion: "callflow/graph-layout-hints-v1",
      stageOrder: ["stage-node"],
    },
  });
}

describe("CallFlow bounded app helpers", () => {
  test("lays out only visible and pinned nodes with required stage parents", () => {
    const bounded = layoutSnapshotForVisible(fixtureSnapshot(), ["entry-node"], ["sink-node"]);

    expect(bounded.nodes.map((node) => node.id)).toEqual(["stage-node", "entry-node", "sink-node"]);
    expect(bounded.edges.map((edge) => edge.id)).toEqual(["handoff-edge"]);
    expect(bounded.layoutHints.stageOrder).toEqual(["stage-node"]);
    expect(bounded.evidence.map((record) => record.id)).toEqual([
      "stage-evidence",
      "entry-evidence",
      "sink-evidence",
      "edge-evidence",
    ]);
  });

  test("requires a preview instead of laying out more than 250 nodes", () => {
    const base = fixtureSnapshot();
    const oversized = GraphSnapshotSchema.parse({
      ...base,
      nodes: Array.from({ length: 251 }, (_, index) => ({
        id: `node-${String(index).padStart(3, "0")}`,
        kind: "function" as const,
        label: `Node ${String(index)}`,
        level: "L1" as const,
        evidenceIds: ["entry-evidence"],
      })),
      edges: [],
      layoutHints: { ...base.layoutHints, stageOrder: [] },
    });

    expect(() => layoutSnapshotForVisible(oversized)).toThrow("Layout preview required");
  });

  test("describes selected labels, stages, endpoints, and evidence states without paths", () => {
    const description = describeVisibleGraph(fixtureSnapshot(), ["entry-node", "sink-node"]);

    expect(description).toContain("Ingest stage");
    expect(description).toContain("Publish result");
    expect(description).toContain("entry-node -> sink-node");
    expect(description).toContain("evidence=ambiguous");
    expect(description).toContain("evidence=exact");
    expect(description).not.toContain("/Users/private");
    expect(Buffer.byteLength(description, "utf8")).toBeLessThanOrEqual(8_192);
  });
});

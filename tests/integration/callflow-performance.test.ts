import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

import { GraphSnapshotSchema, type GraphSnapshot } from "@callflow/contracts";
import { computeVisibility, queryGraph, traverseGraph } from "@callflow/core";
const workerPath = resolve(import.meta.dir, "../../server/dist/callflow-layout-worker.cjs");
const benchmarkPath = resolve(import.meta.dir, "../fixtures/callflow/layout-benchmark.mjs");

function graph(nodeCount: number): GraphSnapshot {
  return GraphSnapshotSchema.parse({
    schemaVersion: "callflow/graph-snapshot-v1",
    id: `performance-${String(nodeCount)}`,
    workflowManifestId: "performance",
    repository: {
      identity: "fixture:performance",
      commit: "fixture-commit",
      dirtyDigest: `sha256:${"0".repeat(64)}`,
    },
    adapter: { name: "fixture", version: "1", indexRevision: "fixture-index" },
    nodes: Array.from({ length: nodeCount }, (_, index) => ({
      id: `node-${String(index).padStart(3, "0")}`,
      kind: "function" as const,
      label: `Function ${String(index)}`,
      level: "L1" as const,
      evidenceIds: ["human-evidence"],
    })),
    edges: Array.from({ length: Math.max(0, nodeCount - 1) }, (_, index) => ({
      id: `edge-${String(index).padStart(3, "0")}`,
      source: `node-${String(index).padStart(3, "0")}`,
      target: `node-${String(index + 1).padStart(3, "0")}`,
      kind: "async-handoff" as const,
      assertion: "curated-workflow" as const,
      evidenceIds: ["human-evidence"],
    })),
    evidence: [
      {
        id: "human-evidence",
        kind: "human-curated",
        state: "exact",
        revision: "fixture-commit",
        source: {
          type: "external-reference",
          system: "CallFlow test",
          reference: "performance fixture",
        },
        contentDigest: `sha256:${"1".repeat(64)}`,
        producer: { name: "callflow-test", version: "1" },
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
  });
}

describe("CallFlow fixed performance budgets", () => {
  for (const [nodeCount, maximumMilliseconds] of [
    [30, 250],
    [250, 1_000],
  ] as const) {
    test(`lays out ${String(nodeCount)} nodes within ${String(maximumMilliseconds)} ms`, () => {
      const result = spawnSync("node", [benchmarkPath, workerPath, String(nodeCount)], {
        encoding: "utf8",
        timeout: 5_000,
      });
      expect(result.status).toBe(0);
      const measured = JSON.parse(result.stdout) as {
        layoutMilliseconds: number;
        roundTripMilliseconds: number;
        positionCount: number;
      };
      expect(measured.positionCount).toBe(nodeCount);
      expect(measured.layoutMilliseconds).toBeLessThanOrEqual(maximumMilliseconds);
    });
  }

  test("keeps local query, filtering, and warm expansion within their budgets", () => {
    const snapshot = graph(250);

    let started = performance.now();
    const queried = queryGraph(snapshot, { text: "Function", limit: 250 });
    const visible = computeVisibility(snapshot, {
      query: { text: "Function", limit: 250 },
      collapsedNodeIds: [],
      pinnedNodeIds: [],
    });
    const localElapsed = performance.now() - started;

    started = performance.now();
    const expanded = traverseGraph(snapshot, ["node-000"], {
      direction: "out",
      maxDepth: 25,
      limit: 25,
    });
    const expansionElapsed = performance.now() - started;

    expect(queried.nodes).toHaveLength(250);
    expect(visible.visibleNodeIds.size).toBe(250);
    expect(localElapsed).toBeLessThanOrEqual(100);
    expect(expanded.nodeIds.length).toBeLessThanOrEqual(25);
    expect(expansionElapsed).toBeLessThanOrEqual(1_500);
  });

  test("projects members inside stage-ordered layout groups", () => {
    const result = spawnSync("node", [benchmarkPath, workerPath, "6", "grouped"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(result.status).toBe(0);
    const measured = JSON.parse(result.stdout) as {
      positionCount: number;
      stageOrderPreserved: boolean;
      membersProjected: boolean;
    };
    expect(measured.positionCount).toBe(6);
    expect(measured.stageOrderPreserved).toBe(true);
    expect(measured.membersProjected).toBe(true);
  });
});

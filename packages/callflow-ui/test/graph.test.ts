import { describe, expect, test } from "bun:test";

import {
  edgeMatchesOverlay,
  graphDiffStatus,
  graphSearch,
  relatedNodeIds,
  shortestDirectedPath,
} from "../src/graph";

const edges = [
  {
    id: "ab",
    source: "a",
    target: "b",
    kind: "direct-call",
    assertion: "static-possible",
    evidenceIds: ["e1"],
  },
  {
    id: "bc",
    source: "b",
    target: "c",
    kind: "async-handoff",
    assertion: "curated-workflow",
    evidenceIds: ["e2"],
  },
  {
    id: "ca",
    source: "c",
    target: "a",
    kind: "retry",
    assertion: "static-possible",
    evidenceIds: ["e3"],
  },
] as const;

describe("CallFlow graph navigation", () => {
  test("finds callers and callees without losing the anchor", () => {
    expect([...relatedNodeIds(edges, "b", "callers")]).toEqual(["b", "a"]);
    expect([...relatedNodeIds(edges, "b", "callees")]).toEqual(["b", "c"]);
  });

  test("finds a bounded directed path through a cycle", () => {
    expect(shortestDirectedPath(edges, "a", "c")).toEqual(["a", "b", "c"]);
    expect(shortestDirectedPath(edges, "a", "missing")).toEqual([]);
  });

  test("uses fixed literal matching for search", () => {
    const nodes = [
      {
        id: "a",
        kind: "function",
        label: "Index [document]",
        level: "L1",
        evidenceIds: ["e1"],
      },
      {
        id: "b",
        kind: "queue",
        label: "Retry queue",
        level: "L1",
        evidenceIds: ["e2"],
      },
    ];
    expect(graphSearch(nodes, "[")).toEqual(["a"]);
  });

  test("highlights storage and asynchronous handoffs in the data overlay", () => {
    expect(edgeMatchesOverlay("state-write", "data")).toBe(true);
    expect(edgeMatchesOverlay("async-handoff", "data")).toBe(true);
    expect(edgeMatchesOverlay("direct-call", "data")).toBe(false);
  });

  test("uses validated change markers for the change-impact overlay", () => {
    expect(graphDiffStatus({ diffStatus: "broken" })).toBe("broken");
    expect(graphDiffStatus({ diffStatus: "invented" })).toBe("current");
    expect(edgeMatchesOverlay("direct-call", "change", "changed")).toBe(true);
    expect(edgeMatchesOverlay("direct-call", "change", "current")).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";

import {
  callFlowViewReducer,
  computeCallFlowVisibility,
  createCallFlowViewState,
  initialCallFlowNodeIds,
  INITIAL_VISIBLE_NODE_MAX,
  MAX_REVEAL_PER_ACTION,
  MAX_VISIBLE_NODES,
  nearestVisibleNodeId,
  viewportAnimationDuration,
} from "../src/state";

describe("CallFlow view state", () => {
  test("keeps navigation history and truncates the forward branch", () => {
    let state = createCallFlowViewState("rev-1");
    state = callFlowViewReducer(state, { type: "select", nodeId: "a" });
    state = callFlowViewReducer(state, { type: "select", nodeId: "b" });
    state = callFlowViewReducer(state, { type: "history-back" });
    expect(state.selectedNodeId).toBe("a");
    state = callFlowViewReducer(state, { type: "select", nodeId: "c" });
    expect(state.history).toEqual(["a", "c"]);
    expect(state.historyIndex).toBe(1);
  });

  test("keeps pinned children visible when their stage collapses", () => {
    let state = createCallFlowViewState("rev-1", ["stage", "pinned", "hidden"]);
    state = callFlowViewReducer(state, { type: "toggle-pin", nodeId: "pinned" });
    state = callFlowViewReducer(state, { type: "toggle-stage", stageId: "stage" });
    const visibility = computeCallFlowVisibility(
      [
        { id: "stage", kind: "stage" },
        { id: "pinned", kind: "function", stageId: "stage" },
        { id: "hidden", kind: "function", stageId: "stage" },
      ],
      state,
    );
    expect(visibility.visibleNodeIds).toEqual(new Set(["stage", "pinned"]));
    expect(visibility.hiddenReasons.collapsed).toBe(1);
  });

  test("preserves valid selection and pins when a graph revision changes", () => {
    let state = createCallFlowViewState("rev-1");
    state = callFlowViewReducer(state, { type: "select", nodeId: "kept" });
    state = callFlowViewReducer(state, { type: "toggle-pin", nodeId: "kept" });
    state = callFlowViewReducer(state, { type: "toggle-pin", nodeId: "removed" });
    state = callFlowViewReducer(state, {
      type: "hydrate",
      graphRevision: "rev-2",
      nodeIds: new Set(["kept"]),
      initialNodeIds: ["kept"],
    });
    expect(state.selectedNodeId).toBe("kept");
    expect([...state.pinnedNodeIds]).toEqual(["kept"]);
  });

  test("applies the hard visible-node limit while retaining pinned nodes", () => {
    const nodes = Array.from({ length: MAX_VISIBLE_NODES + 2 }, (_, index) => ({
      id: index === MAX_VISIBLE_NODES + 1 ? "last" : `node-${String(index)}`,
      kind: "function",
    }));
    let state = createCallFlowViewState(
      "rev-1",
      nodes.map((node) => node.id),
    );
    state = callFlowViewReducer(state, { type: "toggle-pin", nodeId: "last" });
    const visibility = computeCallFlowVisibility(nodes, state);
    expect(visibility.visibleNodeIds.has("last")).toBe(true);
    expect(visibility.visibleNodeIds.size).toBe(MAX_VISIBLE_NODES);
    expect(visibility.hiddenReasons.limit).toBe(2);
  });

  test("builds a deterministic 30-node overview with stages and anchors first", () => {
    const nodes = Array.from({ length: 40 }, (_, index) => ({
      id: `node-${String(index).padStart(2, "0")}`,
      kind: index === 39 ? "stage" : "function",
      ...(index === 38 ? { attributes: { anchorId: "sink" } } : {}),
    })).reverse();
    const initial = initialCallFlowNodeIds(nodes);
    expect(initial).toHaveLength(INITIAL_VISIBLE_NODE_MAX);
    expect(initial.slice(0, 2)).toEqual(["node-39", "node-38"]);
    expect(initial).toEqual(initialCallFlowNodeIds([...nodes].reverse()));
  });

  test("respects explicit stage order in the deterministic overview", () => {
    const nodes = [
      { id: "stage-a", kind: "stage" },
      { id: "stage-b", kind: "stage" },
      { id: "anchor", kind: "function", attributes: { anchorId: "entry" } },
    ];
    expect(initialCallFlowNodeIds(nodes, ["stage-b", "stage-a"])).toEqual([
      "stage-b",
      "stage-a",
      "anchor",
    ]);
  });

  test("reports node and evidence filters without allowing pins to bypass them", () => {
    const nodes = [
      { id: "stage", kind: "stage", evidenceState: "exact" },
      { id: "fn", kind: "function", stageId: "stage", evidenceState: "exact" },
      { id: "queue", kind: "queue", stageId: "stage", evidenceState: "ambiguous" },
    ];
    let state = createCallFlowViewState(
      "rev-1",
      nodes.map((node) => node.id),
    );
    state = callFlowViewReducer(state, { type: "toggle-pin", nodeId: "fn" });
    state = callFlowViewReducer(state, { type: "set-node-kind-filter", kind: "queue" });
    state = callFlowViewReducer(state, {
      type: "set-evidence-state-filter",
      state: "ambiguous",
    });
    const visibility = computeCallFlowVisibility(nodes, state);
    expect(visibility.visibleNodeIds).toEqual(new Set(["queue"]));
    expect(visibility.hiddenReasons["node-filter"]).toBe(1);
    expect(visibility.hiddenReasons["evidence-filter"]).toBe(1);
  });

  test("moves a hidden selection to its nearest visible stage", () => {
    const nodes = [
      { id: "stage", kind: "stage" },
      { id: "parent", kind: "function", stageId: "stage" },
      { id: "child", kind: "function", parentId: "parent", stageId: "stage" },
    ];
    expect(nearestVisibleNodeId("child", nodes, new Set(["stage"]))).toBe("stage");
    expect(nearestVisibleNodeId("child", nodes, new Set(["stage", "parent"]))).toBe("parent");
  });

  test("selects edges independently and restores the presentation overlay on reset", () => {
    let state = createCallFlowViewState("rev-1", ["a"], "change");
    state = callFlowViewReducer(state, { type: "select", nodeId: "a" });
    state = callFlowViewReducer(state, { type: "select-edge", edgeId: "edge-a" });
    expect(state.selectedNodeId).toBeUndefined();
    expect(state.selectedEdgeId).toBe("edge-a");
    state = callFlowViewReducer(state, {
      type: "reset",
      graphRevision: "rev-1",
      initialNodeIds: ["a"],
      defaultOverlay: "retry",
    });
    expect(state.overlay).toBe("retry");
    expect(state.selectedEdgeId).toBeUndefined();
  });

  test("reveals at most 25 additional nodes and preserves them across hydration", () => {
    let state = createCallFlowViewState("rev-1", ["initial"]);
    state = callFlowViewReducer(state, {
      type: "reveal",
      nodeIds: Array.from({ length: 30 }, (_, index) => `expanded-${String(index)}`),
    });
    expect(state.revealedNodeIds.size).toBe(1 + MAX_REVEAL_PER_ACTION);
    state = callFlowViewReducer(state, {
      type: "hydrate",
      graphRevision: "rev-2",
      nodeIds: new Set(["initial", "new-stage", ...state.revealedNodeIds]),
      initialNodeIds: ["new-stage"],
    });
    expect(state.revealedNodeIds.has("expanded-24")).toBe(true);
    expect(state.revealedNodeIds.has("expanded-25")).toBe(false);
    expect(state.revealedNodeIds.has("new-stage")).toBe(true);
  });

  test("previews large stage expansion before revealing bounded batches", () => {
    const memberIds = Array.from(
      { length: 30 },
      (_, index) => `member-${String(index).padStart(2, "0")}`,
    );
    let state = createCallFlowViewState("rev-1", ["stage", "selected"]);
    state = callFlowViewReducer(state, { type: "select", nodeId: "selected" });
    state = callFlowViewReducer(state, { type: "toggle-pin", nodeId: "selected" });
    state = callFlowViewReducer(state, { type: "toggle-stage", stageId: "stage" });

    state = callFlowViewReducer(state, { type: "expand-stage", stageId: "stage", memberIds });
    expect(state.stageExpansionPreview).toEqual({ stageId: "stage", remainingCount: 30 });
    expect(state.revealedNodeIds).toEqual(new Set(["stage", "selected"]));
    expect(state.collapsedStageIds.has("stage")).toBe(true);

    state = callFlowViewReducer(state, {
      type: "expand-stage",
      stageId: "stage",
      memberIds,
      confirmed: true,
    });
    expect(state.revealedNodeIds.size).toBe(2 + MAX_REVEAL_PER_ACTION);
    expect(state.revealedNodeIds.has("member-24")).toBe(true);
    expect(state.revealedNodeIds.has("member-25")).toBe(false);
    expect(state.stageExpansionPreview).toEqual({ stageId: "stage", remainingCount: 5 });
    expect(state.collapsedStageIds.has("stage")).toBe(false);
    expect(state.selectedNodeId).toBe("selected");
    expect(state.pinnedNodeIds.has("selected")).toBe(true);
    expect(state.history).toEqual(["selected"]);
  });

  test("expands a small stage without requiring a preview", () => {
    let state = createCallFlowViewState("rev-1", ["stage"]);
    state = callFlowViewReducer(state, {
      type: "expand-stage",
      stageId: "stage",
      memberIds: ["a", "b"],
    });
    expect(state.revealedNodeIds).toEqual(new Set(["stage", "a", "b"]));
    expect(state.stageExpansionPreview).toBeUndefined();
  });

  test("removes viewport animation when reduced motion is requested", () => {
    expect(viewportAnimationDuration(true)).toBe(0);
    expect(viewportAnimationDuration(false)).toBe(180);
  });
});

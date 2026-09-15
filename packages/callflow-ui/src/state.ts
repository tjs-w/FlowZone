export type CallFlowOverlay =
  "flow" | "data" | "evidence" | "failure" | "retry" | "transaction" | "change";

export interface CallFlowViewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface CallFlowStageExpansionPreview {
  readonly stageId: string;
  readonly remainingCount: number;
}

export interface CallFlowViewState {
  readonly graphRevision: string;
  readonly initialNodeIds: ReadonlySet<string>;
  readonly revealedNodeIds: ReadonlySet<string>;
  readonly query: string;
  readonly overlay: CallFlowOverlay;
  readonly nodeKindFilter: string;
  readonly evidenceStateFilter: string;
  readonly selectedNodeId?: string | undefined;
  readonly selectedEdgeId?: string | undefined;
  readonly pathTargetId?: string | undefined;
  readonly isolatedNodeIds?: ReadonlySet<string> | undefined;
  readonly collapsedStageIds: ReadonlySet<string>;
  readonly hiddenSiblingIds: ReadonlySet<string>;
  readonly pinnedNodeIds: ReadonlySet<string>;
  readonly stageExpansionPreview?: CallFlowStageExpansionPreview | undefined;
  readonly history: readonly string[];
  readonly historyIndex: number;
  readonly viewport: CallFlowViewport;
}

export type CallFlowViewAction =
  | {
      readonly type: "hydrate";
      readonly graphRevision: string;
      readonly nodeIds: ReadonlySet<string>;
      readonly edgeIds?: ReadonlySet<string> | undefined;
      readonly initialNodeIds: readonly string[];
      readonly fallbackSelection?: string | undefined;
      readonly defaultOverlay?: CallFlowOverlay | undefined;
    }
  | {
      readonly type: "select";
      readonly nodeId?: string | undefined;
      readonly recordHistory?: boolean | undefined;
    }
  | { readonly type: "select-edge"; readonly edgeId?: string | undefined }
  | { readonly type: "history-back" }
  | { readonly type: "history-forward" }
  | { readonly type: "history-go"; readonly historyIndex: number }
  | { readonly type: "reveal"; readonly nodeIds: readonly string[] }
  | {
      readonly type: "expand-stage";
      readonly stageId: string;
      readonly memberIds: readonly string[];
      readonly confirmed?: boolean | undefined;
    }
  | { readonly type: "dismiss-stage-expansion" }
  | { readonly type: "toggle-pin"; readonly nodeId: string }
  | { readonly type: "toggle-stage"; readonly stageId: string }
  | { readonly type: "collapse-siblings"; readonly siblingIds: readonly string[] }
  | { readonly type: "isolate"; readonly nodeIds: readonly string[] }
  | { readonly type: "show-all" }
  | { readonly type: "set-query"; readonly query: string }
  | { readonly type: "set-overlay"; readonly overlay: CallFlowOverlay }
  | { readonly type: "set-node-kind-filter"; readonly kind: string }
  | { readonly type: "set-evidence-state-filter"; readonly state: string }
  | { readonly type: "clear-filters" }
  | { readonly type: "set-path-target"; readonly nodeId?: string | undefined }
  | { readonly type: "set-viewport"; readonly viewport: CallFlowViewport }
  | {
      readonly type: "reset";
      readonly graphRevision: string;
      readonly initialNodeIds: readonly string[];
      readonly defaultOverlay?: CallFlowOverlay | undefined;
    };

export const DEFAULT_VIEWPORT: CallFlowViewport = Object.freeze({ x: 0, y: 0, zoom: 1 });

export function createCallFlowViewState(
  graphRevision = "",
  initialNodeIds: readonly string[] = [],
  defaultOverlay: CallFlowOverlay = "flow",
): CallFlowViewState {
  return {
    graphRevision,
    initialNodeIds: new Set(initialNodeIds),
    revealedNodeIds: new Set(initialNodeIds),
    query: "",
    overlay: defaultOverlay,
    nodeKindFilter: "all",
    evidenceStateFilter: "all",
    collapsedStageIds: new Set(),
    hiddenSiblingIds: new Set(),
    pinnedNodeIds: new Set(),
    history: [],
    historyIndex: -1,
    viewport: DEFAULT_VIEWPORT,
  };
}

function toggled(values: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(values);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function selectionHistory(
  state: CallFlowViewState,
  nodeId: string,
): Pick<CallFlowViewState, "history" | "historyIndex"> {
  if (state.history[state.historyIndex] === nodeId) {
    return { history: state.history, historyIndex: state.historyIndex };
  }
  const history = [...state.history.slice(0, state.historyIndex + 1), nodeId].slice(-50);
  return { history, historyIndex: history.length - 1 };
}

export function callFlowViewReducer(
  state: CallFlowViewState,
  action: CallFlowViewAction,
): CallFlowViewState {
  switch (action.type) {
    case "hydrate": {
      const initialNodeIds = new Set(
        action.initialNodeIds.filter((nodeId) => action.nodeIds.has(nodeId)),
      );
      const revealedNodeIds = new Set(
        state.graphRevision
          ? [...state.revealedNodeIds].filter((nodeId) => action.nodeIds.has(nodeId))
          : [],
      );
      for (const nodeId of initialNodeIds) revealedNodeIds.add(nodeId);
      const retainedPins = new Set(
        [...state.pinnedNodeIds].filter((nodeId) => action.nodeIds.has(nodeId)),
      );
      const retainedHistory = state.history.filter((nodeId) => action.nodeIds.has(nodeId));
      const selectedNodeId =
        state.selectedNodeId && action.nodeIds.has(state.selectedNodeId)
          ? state.selectedNodeId
          : action.fallbackSelection && action.nodeIds.has(action.fallbackSelection)
            ? action.fallbackSelection
            : undefined;
      const selectedEdgeId =
        state.selectedEdgeId && action.edgeIds?.has(state.selectedEdgeId)
          ? state.selectedEdgeId
          : undefined;
      return {
        ...state,
        graphRevision: action.graphRevision,
        initialNodeIds,
        revealedNodeIds,
        overlay: state.graphRevision ? state.overlay : (action.defaultOverlay ?? state.overlay),
        ...(selectedNodeId ? { selectedNodeId } : { selectedNodeId: undefined }),
        ...(selectedEdgeId ? { selectedEdgeId } : { selectedEdgeId: undefined }),
        ...(state.pathTargetId && action.nodeIds.has(state.pathTargetId)
          ? {}
          : { pathTargetId: undefined }),
        pinnedNodeIds: retainedPins,
        hiddenSiblingIds: new Set(
          [...state.hiddenSiblingIds].filter((nodeId) => action.nodeIds.has(nodeId)),
        ),
        isolatedNodeIds: state.isolatedNodeIds
          ? new Set([...state.isolatedNodeIds].filter((nodeId) => action.nodeIds.has(nodeId)))
          : undefined,
        stageExpansionPreview:
          state.graphRevision === action.graphRevision &&
          state.stageExpansionPreview &&
          action.nodeIds.has(state.stageExpansionPreview.stageId)
            ? state.stageExpansionPreview
            : undefined,
        history: retainedHistory,
        historyIndex: selectedNodeId ? retainedHistory.lastIndexOf(selectedNodeId) : -1,
      };
    }
    case "select": {
      if (!action.nodeId) {
        return { ...state, selectedNodeId: undefined, selectedEdgeId: undefined };
      }
      return {
        ...state,
        selectedNodeId: action.nodeId,
        selectedEdgeId: undefined,
        ...(action.recordHistory === false ? {} : selectionHistory(state, action.nodeId)),
      };
    }
    case "select-edge":
      return {
        ...state,
        selectedNodeId: undefined,
        selectedEdgeId: action.edgeId,
      };
    case "history-back": {
      if (state.historyIndex <= 0) return state;
      const historyIndex = state.historyIndex - 1;
      return {
        ...state,
        historyIndex,
        selectedNodeId: state.history[historyIndex],
        selectedEdgeId: undefined,
      };
    }
    case "history-forward": {
      if (state.historyIndex >= state.history.length - 1) return state;
      const historyIndex = state.historyIndex + 1;
      return {
        ...state,
        historyIndex,
        selectedNodeId: state.history[historyIndex],
        selectedEdgeId: undefined,
      };
    }
    case "history-go": {
      if (action.historyIndex < 0 || action.historyIndex >= state.history.length) return state;
      return {
        ...state,
        historyIndex: action.historyIndex,
        selectedNodeId: state.history[action.historyIndex],
        selectedEdgeId: undefined,
      };
    }
    case "reveal": {
      const revealedNodeIds = new Set(state.revealedNodeIds);
      let additions = 0;
      for (const nodeId of action.nodeIds) {
        if (revealedNodeIds.has(nodeId)) continue;
        if (additions >= MAX_REVEAL_PER_ACTION) break;
        revealedNodeIds.add(nodeId);
        additions += 1;
      }
      return { ...state, revealedNodeIds };
    }
    case "expand-stage": {
      const candidateIds = [
        ...new Set(
          action.memberIds.filter(
            (nodeId) => nodeId !== action.stageId && !state.revealedNodeIds.has(nodeId),
          ),
        ),
      ].sort();
      if (!action.confirmed && candidateIds.length > MAX_REVEAL_PER_ACTION) {
        return {
          ...state,
          stageExpansionPreview: {
            stageId: action.stageId,
            remainingCount: candidateIds.length,
          },
        };
      }
      const revealedNodeIds = new Set(state.revealedNodeIds);
      revealedNodeIds.add(action.stageId);
      for (const nodeId of candidateIds.slice(0, MAX_REVEAL_PER_ACTION)) {
        revealedNodeIds.add(nodeId);
      }
      const collapsedStageIds = new Set(state.collapsedStageIds);
      collapsedStageIds.delete(action.stageId);
      const remainingCount = Math.max(0, candidateIds.length - MAX_REVEAL_PER_ACTION);
      return {
        ...state,
        revealedNodeIds,
        collapsedStageIds,
        stageExpansionPreview:
          remainingCount > 0 ? { stageId: action.stageId, remainingCount } : undefined,
      };
    }
    case "dismiss-stage-expansion":
      return { ...state, stageExpansionPreview: undefined };
    case "toggle-pin":
      return { ...state, pinnedNodeIds: toggled(state.pinnedNodeIds, action.nodeId) };
    case "toggle-stage":
      return {
        ...state,
        collapsedStageIds: toggled(state.collapsedStageIds, action.stageId),
      };
    case "collapse-siblings": {
      const hiddenSiblingIds = new Set(state.hiddenSiblingIds);
      for (const nodeId of action.siblingIds) {
        if (!state.pinnedNodeIds.has(nodeId) && nodeId !== state.selectedNodeId) {
          hiddenSiblingIds.add(nodeId);
        }
      }
      return { ...state, hiddenSiblingIds };
    }
    case "isolate":
      return { ...state, isolatedNodeIds: new Set(action.nodeIds), hiddenSiblingIds: new Set() };
    case "show-all":
      return { ...state, isolatedNodeIds: undefined, hiddenSiblingIds: new Set() };
    case "set-query":
      return { ...state, query: action.query.slice(0, 200) };
    case "set-overlay":
      return { ...state, overlay: action.overlay };
    case "set-node-kind-filter":
      return { ...state, nodeKindFilter: action.kind };
    case "set-evidence-state-filter":
      return { ...state, evidenceStateFilter: action.state };
    case "clear-filters":
      return { ...state, nodeKindFilter: "all", evidenceStateFilter: "all" };
    case "set-path-target":
      return { ...state, pathTargetId: action.nodeId };
    case "set-viewport":
      return { ...state, viewport: action.viewport };
    case "reset":
      return createCallFlowViewState(
        action.graphRevision,
        action.initialNodeIds,
        action.defaultOverlay ?? "flow",
      );
  }
}

export interface VisibilityNode {
  readonly id: string;
  readonly kind: string;
  readonly parentId?: string | undefined;
  readonly stageId?: string | undefined;
  readonly evidenceState?: string | undefined;
  readonly attributes?: Readonly<Record<string, string | number | boolean>> | undefined;
}

export interface CallFlowVisibility {
  readonly visibleNodeIds: ReadonlySet<string>;
  readonly hiddenCount: number;
  readonly hiddenReasons: Readonly<
    Record<
      | "unrevealed"
      | "collapsed"
      | "siblings"
      | "isolated"
      | "node-filter"
      | "evidence-filter"
      | "limit",
      number
    >
  >;
}

export const INITIAL_VISIBLE_NODE_MIN = 10;
export const INITIAL_VISIBLE_NODE_MAX = 30;
export const MAX_REVEAL_PER_ACTION = 25;
export const MAX_VISIBLE_NODES = 250;

export function viewportAnimationDuration(prefersReducedMotion: boolean): number {
  return prefersReducedMotion ? 0 : 180;
}

function compareNodeIds(left: VisibilityNode, right: VisibilityNode): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function isManifestAnchor(node: VisibilityNode): boolean {
  return (
    node.attributes !== undefined &&
    Object.prototype.hasOwnProperty.call(node.attributes, "anchorId")
  );
}

/** Selects a byte-stable overview while keeping stages and manifest anchors at the front. */
export function initialCallFlowNodeIds(
  nodes: readonly VisibilityNode[],
  stageOrder: readonly string[] = [],
): readonly string[] {
  const stageRanks = new Map(stageOrder.map((nodeId, index) => [nodeId, index]));
  const stages = nodes
    .filter((node) => node.kind === "stage")
    .sort((left, right) => {
      const leftRank = stageRanks.get(left.id) ?? Number.POSITIVE_INFINITY;
      const rightRank = stageRanks.get(right.id) ?? Number.POSITIVE_INFINITY;
      return leftRank - rightRank || compareNodeIds(left, right);
    });
  const stageIds = new Set(stages.map((node) => node.id));
  const anchors = nodes
    .filter((node) => !stageIds.has(node.id) && isManifestAnchor(node))
    .sort(compareNodeIds);
  const prioritized = [...stages, ...anchors];
  const prioritizedIds = new Set(prioritized.map((node) => node.id));
  const remaining = nodes.filter((node) => !prioritizedIds.has(node.id)).sort(compareNodeIds);
  const target = Math.min(
    INITIAL_VISIBLE_NODE_MAX,
    Math.max(INITIAL_VISIBLE_NODE_MIN, Math.min(nodes.length, INITIAL_VISIBLE_NODE_MAX)),
  );
  return [...prioritized, ...remaining].slice(0, target).map((node) => node.id);
}

export function computeCallFlowVisibility(
  nodes: readonly VisibilityNode[],
  state: CallFlowViewState,
): CallFlowVisibility {
  const visibleNodeIds = new Set<string>();
  const hiddenReasons = {
    unrevealed: 0,
    collapsed: 0,
    siblings: 0,
    isolated: 0,
    "node-filter": 0,
    "evidence-filter": 0,
    limit: 0,
  };

  const isFiltered = (node: VisibilityNode): boolean =>
    (state.nodeKindFilter !== "all" &&
      (state.nodeKindFilter === "stage"
        ? node.kind !== "stage"
        : node.kind !== "stage" && node.kind !== state.nodeKindFilter)) ||
    (state.evidenceStateFilter !== "all" && node.evidenceState !== state.evidenceStateFilter);

  // Pins survive collapse and isolation, but explicit content filters remain authoritative.
  for (const node of nodes) {
    if (
      state.pinnedNodeIds.has(node.id) &&
      !isFiltered(node) &&
      visibleNodeIds.size < MAX_VISIBLE_NODES
    ) {
      visibleNodeIds.add(node.id);
    }
  }

  for (const node of nodes) {
    if (visibleNodeIds.has(node.id)) continue;
    const pinned = state.pinnedNodeIds.has(node.id);
    let reason: keyof typeof hiddenReasons | undefined;
    if (
      state.nodeKindFilter !== "all" &&
      (state.nodeKindFilter === "stage"
        ? node.kind !== "stage"
        : node.kind !== "stage" && node.kind !== state.nodeKindFilter)
    ) {
      reason = "node-filter";
    } else if (
      state.evidenceStateFilter !== "all" &&
      node.evidenceState !== state.evidenceStateFilter
    ) {
      reason = "evidence-filter";
    } else if (!pinned && !state.revealedNodeIds.has(node.id)) {
      reason = "unrevealed";
    } else if (!pinned && state.isolatedNodeIds && !state.isolatedNodeIds.has(node.id)) {
      reason = "isolated";
    } else if (!pinned && state.hiddenSiblingIds.has(node.id)) {
      reason = "siblings";
    } else if (
      !pinned &&
      node.stageId &&
      state.collapsedStageIds.has(node.stageId) &&
      node.id !== node.stageId
    ) {
      reason = "collapsed";
    } else if (visibleNodeIds.size >= MAX_VISIBLE_NODES) {
      reason = "limit";
    }
    if (reason) hiddenReasons[reason] += 1;
    else visibleNodeIds.add(node.id);
  }

  return {
    visibleNodeIds,
    hiddenCount: nodes.length - visibleNodeIds.size,
    hiddenReasons,
  };
}

/** Resolves a hidden selection to the nearest visible parent, stage, or overview node. */
export function nearestVisibleNodeId(
  selectedNodeId: string | undefined,
  nodes: readonly VisibilityNode[],
  visibleNodeIds: ReadonlySet<string>,
): string | undefined {
  if (selectedNodeId && visibleNodeIds.has(selectedNodeId)) return selectedNodeId;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  let current = selectedNodeId ? nodeById.get(selectedNodeId) : undefined;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const parentId = current.parentId ?? current.stageId;
    if (!parentId) break;
    if (visibleNodeIds.has(parentId)) return parentId;
    current = nodeById.get(parentId);
  }
  return (
    nodes.find((node) => node.kind === "stage" && visibleNodeIds.has(node.id))?.id ??
    nodes.find((node) => visibleNodeIds.has(node.id))?.id
  );
}

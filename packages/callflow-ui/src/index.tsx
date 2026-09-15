import "@xyflow/react/dist/style.css";
import "./styles.css";

import {
  type CallFlowCapabilityUpdate,
  type CallFlowSourceExcerpt,
  type CallFlowUiPayload,
  type EvidenceRecord,
  type GraphEdge,
  type GraphNode,
} from "@callflow/contracts";
import {
  App,
  type AppEventMap,
  type McpUiHostCapabilities,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import { applyDocumentTheme } from "@openai/apps-sdk-ui/theme";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";

import {
  edgeMatchesOverlay,
  graphDiffStatus,
  graphSearch,
  relatedNodeIds,
  shortestDirectedPath,
  stageSiblings,
  type GraphDirection,
} from "./graph";
import {
  metadataCapabilityUpdate,
  metadataPayload,
  parseLayoutResult,
  parseNodeListResult,
  parseSourceExcerpt,
  readBootstrapPayload,
  structuredRecord,
  toolFailed,
} from "./payload";
import { QuietParentTransport } from "./quiet-transport";
import {
  callFlowViewReducer,
  computeCallFlowVisibility,
  createCallFlowViewState,
  initialCallFlowNodeIds,
  MAX_REVEAL_PER_ACTION,
  MAX_VISIBLE_NODES,
  nearestVisibleNodeId,
  type CallFlowOverlay,
  type CallFlowViewport,
  viewportAnimationDuration,
} from "./state";

const MAX_VISIBLE_EDGES = 600;
const NORMAL_EXPANSION_LIMIT = MAX_REVEAL_PER_ACTION;
const SEARCH_LIMIT = 50;
const SOURCE_MAX_BYTES = 24 * 1024;

type HostContext = McpUiHostContext & {
  readonly locale?: string;
  readonly timeZone?: string;
  readonly platform?: string;
};

interface CanvasNodeData extends Record<string, unknown> {
  readonly graphNode: GraphNode;
  readonly evidenceState: EvidenceRecord["state"];
  readonly pinned: boolean;
  readonly matched: boolean;
  readonly collapsed: boolean;
  readonly childCount: number;
  readonly hiddenChildCount: number;
  readonly diffStatus: ReturnType<typeof graphDiffStatus>;
  readonly onToggleStage: (stageId: string) => void;
}

type CanvasNode = Node<CanvasNodeData, "callflow-node">;

function humanize(value: string): string {
  const text = value.replaceAll("-", " ");
  return `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;
}

function presentationOverlay(value: string | undefined): CallFlowOverlay {
  switch (value) {
    case "data":
    case "failure":
    case "retry":
    case "transaction":
    case "change":
      return value;
    case undefined:
    default:
      return "flow";
  }
}

function worstEvidenceState(
  evidence: readonly EvidenceRecord[],
  evidenceIds: readonly string[],
): EvidenceRecord["state"] {
  const priority: Readonly<Record<EvidenceRecord["state"], number>> = {
    exact: 0,
    ambiguous: 1,
    stale: 2,
    unavailable: 3,
    failed: 4,
  };
  let state: EvidenceRecord["state"] = "exact";
  for (const evidenceId of evidenceIds) {
    const candidate = evidence.find((record) => record.id === evidenceId)?.state ?? "unavailable";
    if (priority[candidate] > priority[state]) state = candidate;
  }
  return state;
}

function nodeKindSymbol(kind: GraphNode["kind"]): string {
  switch (kind) {
    case "stage":
      return "§";
    case "condition":
      return "?";
    case "transaction":
      return "⇄";
    case "database":
    case "table":
      return "▤";
    case "queue":
    case "message":
      return "⇢";
    case "external-system":
      return "◇";
    case "terminal":
      return "■";
    case "package":
      return "▣";
    case "class":
      return "C";
    case "function":
      return "ƒ";
  }
}

function WorkflowNode({ data, selected }: NodeProps<CanvasNode>) {
  const node = data.graphNode;
  const isStage = node.kind === "stage";
  return (
    <div
      className="cf-node"
      data-kind={node.kind}
      data-evidence-state={data.evidenceState}
      data-diff-status={data.diffStatus}
      data-selected={selected ? "true" : "false"}
      data-matched={data.matched ? "true" : "false"}
      aria-label={`${node.label}, ${humanize(node.kind)}, ${humanize(data.evidenceState)} evidence`}
    >
      <Handle type="target" position={Position.Left} className="cf-handle" />
      <span className="cf-node-kind" aria-hidden="true">
        {nodeKindSymbol(node.kind)}
      </span>
      <span className="cf-node-copy">
        <strong>{node.label}</strong>
        <span>
          {node.level} · {humanize(node.kind)}
          {data.pinned ? " · pinned" : ""}
        </span>
      </span>
      {isStage && data.childCount > 0 ? (
        <button
          type="button"
          className="cf-stage-toggle nodrag"
          aria-label={`${data.collapsed ? "Open" : "Collapse"} ${node.label} group`}
          aria-expanded={!data.collapsed}
          onClick={(event) => {
            event.stopPropagation();
            data.onToggleStage(node.id);
          }}
        >
          {data.collapsed ? `+${String(data.hiddenChildCount)}` : "−"}
        </button>
      ) : null}
      <Handle type="source" position={Position.Right} className="cf-handle" />
    </div>
  );
}

const nodeTypes = { "callflow-node": WorkflowNode } as const;

interface LayoutResult {
  readonly nodes: readonly CanvasNode[];
  readonly stageIndex: ReadonlyMap<string, number>;
}

function numericAttribute(node: GraphNode, key: string): number | undefined {
  const value = node.attributes?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function layoutNodes(
  graphNodes: readonly GraphNode[],
  evidence: readonly EvidenceRecord[],
  visibleNodeIds: ReadonlySet<string>,
  state: ReturnType<typeof createCallFlowViewState>,
  matchedNodeIds: ReadonlySet<string>,
  onToggleStage: (stageId: string) => void,
  serverPositions: ReadonlyMap<string, { readonly x: number; readonly y: number }>,
  stageOrder: readonly string[],
): LayoutResult {
  const stageRanks = new Map(stageOrder.map((nodeId, index) => [nodeId, index]));
  const stages = graphNodes
    .filter((node) => node.kind === "stage")
    .sort((left, right) => {
      const leftRank = stageRanks.get(left.id) ?? Number.POSITIVE_INFINITY;
      const rightRank = stageRanks.get(right.id) ?? Number.POSITIVE_INFINITY;
      return leftRank - rightRank || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    });
  const stageIndex = new Map(stages.map((stage, index) => [stage.id, index]));
  const grouped = new Map<string, GraphNode[]>();
  for (const node of graphNodes) {
    if (node.kind === "stage" || !node.stageId) continue;
    const members = grouped.get(node.stageId) ?? [];
    members.push(node);
    grouped.set(node.stageId, members);
  }
  const output: CanvasNode[] = [];
  const stageWidth = 270;
  const stageGap = 70;
  for (const [index, stage] of stages.entries()) {
    if (!visibleNodeIds.has(stage.id)) continue;
    const children = grouped.get(stage.id) ?? [];
    const visibleChildren = children
      .filter((node) => visibleNodeIds.has(node.id))
      .sort((left, right) => {
        const leftY = serverPositions.get(left.id)?.y;
        const rightY = serverPositions.get(right.id)?.y;
        if (leftY !== undefined && rightY !== undefined && leftY !== rightY) return leftY - rightY;
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      });
    const collapsed = state.collapsedStageIds.has(stage.id);
    const width = collapsed ? 230 : stageWidth;
    const height = collapsed ? 68 : Math.max(160, 76 + visibleChildren.length * 82);
    output.push({
      id: stage.id,
      type: "callflow-node",
      position: {
        x:
          serverPositions.get(stage.id)?.x ??
          numericAttribute(stage, "layout.x") ??
          28 + index * (stageWidth + stageGap),
        y: serverPositions.get(stage.id)?.y ?? numericAttribute(stage, "layout.y") ?? 26,
      },
      data: {
        graphNode: stage,
        evidenceState: worstEvidenceState(evidence, stage.evidenceIds),
        pinned: state.pinnedNodeIds.has(stage.id),
        matched: matchedNodeIds.has(stage.id),
        collapsed,
        childCount: children.length,
        hiddenChildCount: children.length - visibleChildren.length,
        diffStatus: graphDiffStatus(stage.attributes),
        onToggleStage,
      },
      className: "cf-stage-node",
      style: { width, height },
      selectable: true,
      draggable: true,
    });
    for (const [childIndex, child] of visibleChildren.entries()) {
      const useParent = !collapsed;
      output.push({
        id: child.id,
        type: "callflow-node",
        ...(useParent ? { parentId: stage.id, extent: "parent" as const } : {}),
        position: {
          x: useParent
            ? 20
            : (serverPositions.get(child.id)?.x ??
              numericAttribute(child, "layout.x") ??
              28 + index * (stageWidth + stageGap)),
          y: useParent
            ? 58 + childIndex * 82
            : (serverPositions.get(child.id)?.y ??
              numericAttribute(child, "layout.y") ??
              112 + childIndex * 82),
        },
        data: {
          graphNode: child,
          evidenceState: worstEvidenceState(evidence, child.evidenceIds),
          pinned: state.pinnedNodeIds.has(child.id),
          matched: matchedNodeIds.has(child.id),
          collapsed: false,
          childCount: 0,
          hiddenChildCount: 0,
          diffStatus: graphDiffStatus(child.attributes),
          onToggleStage,
        },
        style: { width: 230, height: 62 },
        selectable: true,
        draggable: true,
      });
    }
  }

  const ungrouped = graphNodes.filter(
    (node) =>
      node.kind !== "stage" &&
      (!node.stageId || !stageIndex.has(node.stageId) || !visibleNodeIds.has(node.stageId)),
  );
  for (const [index, node] of ungrouped.entries()) {
    if (!visibleNodeIds.has(node.id)) continue;
    output.push({
      id: node.id,
      type: "callflow-node",
      position: {
        x:
          serverPositions.get(node.id)?.x ??
          numericAttribute(node, "layout.x") ??
          28 + (stages.length + (index % 2)) * 340,
        y:
          serverPositions.get(node.id)?.y ??
          numericAttribute(node, "layout.y") ??
          26 + Math.floor(index / 2) * 86,
      },
      data: {
        graphNode: node,
        evidenceState: worstEvidenceState(evidence, node.evidenceIds),
        pinned: state.pinnedNodeIds.has(node.id),
        matched: matchedNodeIds.has(node.id),
        collapsed: false,
        childCount: 0,
        hiddenChildCount: 0,
        diffStatus: graphDiffStatus(node.attributes),
        onToggleStage,
      },
      style: { width: 230, height: 62 },
      selectable: true,
      draggable: true,
    });
  }
  return { nodes: output, stageIndex };
}

function edgeColor(edge: GraphEdge, overlay: CallFlowOverlay): string {
  if (overlay === "change") {
    const status = graphDiffStatus(edge.attributes);
    if (status === "broken") return "var(--cf-failure)";
    if (status === "changed") return "var(--cf-warning)";
    if (status === "unverified") return "var(--cf-line-strong)";
  }
  if (edge.kind === "failure-exit") return "var(--cf-failure)";
  if (edge.kind === "retry" || edge.kind === "poll") return "var(--cf-retry)";
  if (edge.kind === "async-handoff") return "var(--cf-async)";
  if (overlay === "transaction") return "var(--cf-transaction)";
  return "var(--cf-path)";
}

function buildEdges(
  graphEdges: readonly GraphEdge[],
  visibleNodeIds: ReadonlySet<string>,
  stageIndex: ReadonlyMap<string, number>,
  nodeById: ReadonlyMap<string, GraphNode>,
  overlay: CallFlowOverlay,
  selectedEdgeId?: string,
): Edge[] {
  const visibleEdges = graphEdges
    .filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target))
    .slice(0, MAX_VISIBLE_EDGES);
  const isBackEdge = (edge: GraphEdge): boolean => {
    const sourceStage = nodeById.get(edge.source)?.stageId ?? edge.source;
    const targetStage = nodeById.get(edge.target)?.stageId ?? edge.target;
    return (
      edge.kind === "retry" ||
      (stageIndex.has(sourceStage) &&
        stageIndex.has(targetStage) &&
        (stageIndex.get(targetStage) ?? 0) <= (stageIndex.get(sourceStage) ?? 0))
    );
  };
  const retryLaneById = new Map(
    visibleEdges
      .filter(isBackEdge)
      .map((edge) => edge.id)
      .sort()
      .map((edgeId, index) => [edgeId, index]),
  );
  return visibleEdges.map((edge) => {
    const backEdge = isBackEdge(edge);
    const retryLane = retryLaneById.get(edge.id) ?? 0;
    const diffStatus = graphDiffStatus(edge.attributes);
    const emphasized = edgeMatchesOverlay(edge.kind, overlay, diffStatus);
    const color = edgeColor(edge, overlay);
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label ?? edge.condition ?? humanize(edge.kind),
      className: `cf-edge cf-edge--${edge.kind} cf-edge--${diffStatus}${backEdge ? ` cf-edge--back cf-edge--retry-lane-${String(retryLane % 4)}` : ""}${emphasized ? " cf-edge--active" : " cf-edge--muted"}`,
      markerEnd: { type: MarkerType.ArrowClosed, color },
      style: { stroke: color, strokeWidth: emphasized ? 2 : 1 },
      type: backEdge ? "smoothstep" : "default",
      ...(backEdge
        ? {
            pathOptions: { borderRadius: 8, offset: 72 + (retryLane % 4) * 18, stepPosition: 0.18 },
          }
        : {}),
      ariaLabel: `${humanize(edge.kind)} from ${nodeById.get(edge.source)?.label ?? edge.source} to ${nodeById.get(edge.target)?.label ?? edge.target}`,
      focusable: true,
      selected: edge.id === selectedEdgeId,
      data: { diffStatus, assertion: edge.assertion },
    } satisfies Edge;
  });
}

function IconButton({
  label,
  disabled = false,
  pressed,
  onClick,
  children,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly pressed?: boolean | undefined;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="cf-icon-button"
      aria-label={label}
      title={label}
      disabled={disabled}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Outline({
  nodes,
  selectedNodeId,
  matchedNodeIds,
  collapsedStageIds,
  pinnedNodeIds,
  unrevealedMemberCounts,
  stageOrder,
  onSelect,
  onExpandStage,
  onToggleStage,
}: {
  readonly nodes: readonly GraphNode[];
  readonly selectedNodeId?: string | undefined;
  readonly matchedNodeIds: ReadonlySet<string>;
  readonly collapsedStageIds: ReadonlySet<string>;
  readonly pinnedNodeIds: ReadonlySet<string>;
  readonly unrevealedMemberCounts: ReadonlyMap<string, number>;
  readonly stageOrder: readonly string[];
  readonly onSelect: (nodeId: string) => void;
  readonly onExpandStage: (stageId: string) => void;
  readonly onToggleStage: (stageId: string) => void;
}) {
  const treeRef = useRef<HTMLDivElement>(null);
  const lastFocusedNodeId = useRef<string | undefined>(undefined);
  const stageRanks = new Map(stageOrder.map((nodeId, index) => [nodeId, index]));
  const stageNodes = nodes
    .filter((node) => node.kind === "stage")
    .sort((left, right) => {
      const leftRank = stageRanks.get(left.id) ?? Number.POSITIVE_INFINITY;
      const rightRank = stageRanks.get(right.id) ?? Number.POSITIVE_INFINITY;
      return leftRank - rightRank || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    });
  const stageIds = new Set(stageNodes.map((node) => node.id));
  const ungrouped = nodes.filter(
    (node) => node.kind !== "stage" && (!node.stageId || !stageIds.has(node.stageId)),
  );
  const firstTreeNodeId = stageNodes[0]?.id ?? ungrouped[0]?.id;
  useLayoutEffect(() => {
    if (document.activeElement !== document.body || !lastFocusedNodeId.current) return;
    const preferred = selectedNodeId ?? lastFocusedNodeId.current;
    const target = treeRef.current?.querySelector<HTMLElement>(
      `[role="treeitem"][data-node-id="${CSS.escape(preferred)}"]`,
    );
    (target ?? treeRef.current?.querySelector<HTMLElement>('[role="treeitem"]'))?.focus();
  }, [nodes, selectedNodeId]);

  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.getAttribute("role") !== "treeitem") return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    const current = items.indexOf(target);
    if (current < 0) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const nodeId = target.dataset["nodeId"];
      if (nodeId) onSelect(nodeId);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next =
        event.key === "ArrowDown"
          ? Math.min(items.length - 1, current + 1)
          : Math.max(0, current - 1);
      items[next]?.focus();
      return;
    }
    if (event.key === "ArrowRight") {
      const expandable = target.dataset["expandable"] === "true";
      if (!expandable) return;
      event.preventDefault();
      const stageId = target.dataset["nodeId"];
      if (!stageId) return;
      if (target.dataset["expanded"] !== "true") {
        onToggleStage(stageId);
        return;
      }
      const firstChild = items.find((candidate) => candidate.dataset["parentId"] === stageId);
      if (firstChild) firstChild.focus();
      else if (Number(target.dataset["unrevealedCount"] ?? 0) > 0) onExpandStage(stageId);
      return;
    }
    if (event.key === "ArrowLeft") {
      const parentId = target.dataset["parentId"];
      if (parentId) {
        event.preventDefault();
        items.find((candidate) => candidate.dataset["nodeId"] === parentId)?.focus();
      } else if (target.dataset["expandable"] === "true" && target.dataset["expanded"] === "true") {
        event.preventDefault();
        const nodeId = target.dataset["nodeId"];
        if (nodeId) onToggleStage(nodeId);
      }
    }
  };
  const item = (node: GraphNode, level: number, parentId?: string) => (
    <button
      type="button"
      role="treeitem"
      aria-level={level}
      aria-selected={node.id === selectedNodeId}
      tabIndex={
        node.id === selectedNodeId || (!selectedNodeId && node.id === firstTreeNodeId) ? 0 : -1
      }
      className="cf-outline-item"
      data-node-id={node.id}
      data-parent-id={parentId}
      data-selected={node.id === selectedNodeId ? "true" : "false"}
      data-matched={matchedNodeIds.has(node.id) ? "true" : "false"}
      key={node.id}
      onFocus={() => {
        lastFocusedNodeId.current = node.id;
      }}
      onClick={() => {
        onSelect(node.id);
      }}
    >
      <span aria-hidden="true">{nodeKindSymbol(node.kind)}</span>
      <span>{node.label}</span>
      <small>{pinnedNodeIds.has(node.id) ? `${node.level} · PIN` : node.level}</small>
    </button>
  );
  return (
    <div
      ref={treeRef}
      className="cf-outline-tree"
      role="tree"
      aria-label="Workflow outline"
      onKeyDown={onTreeKeyDown}
    >
      {stageNodes.map((stage) => {
        const children = nodes
          .filter((node) => node.stageId === stage.id && node.id !== stage.id)
          .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
        const collapsed = collapsedStageIds.has(stage.id);
        const unrevealedCount = unrevealedMemberCounts.get(stage.id) ?? 0;
        return (
          <div
            className="cf-outline-group"
            role="treeitem"
            aria-level={1}
            aria-expanded={!collapsed}
            aria-selected={stage.id === selectedNodeId}
            tabIndex={
              stage.id === selectedNodeId || (!selectedNodeId && stage.id === firstTreeNodeId)
                ? 0
                : -1
            }
            data-node-id={stage.id}
            data-expandable="true"
            data-expanded={!collapsed ? "true" : "false"}
            data-unrevealed-count={String(unrevealedCount)}
            data-selected={stage.id === selectedNodeId ? "true" : "false"}
            data-matched={matchedNodeIds.has(stage.id) ? "true" : "false"}
            key={stage.id}
            onFocus={(event) => {
              if (event.target === event.currentTarget) lastFocusedNodeId.current = stage.id;
            }}
            onClick={(event) => {
              if (event.target === event.currentTarget) onSelect(stage.id);
            }}
          >
            <div className="cf-outline-stage-row">
              <button
                type="button"
                className="cf-outline-disclosure"
                aria-label={`${collapsed ? "Expand" : "Collapse"} ${stage.label} group`}
                aria-expanded={!collapsed}
                aria-controls={`cf-outline-stage-${stage.id}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleStage(stage.id);
                }}
              >
                {collapsed ? "+" : "−"}
              </button>
              <div
                className="cf-outline-item cf-outline-stage-item"
                data-selected={stage.id === selectedNodeId ? "true" : "false"}
                data-matched={matchedNodeIds.has(stage.id) ? "true" : "false"}
              >
                <span aria-hidden="true">{nodeKindSymbol(stage.kind)}</span>
                <span>{stage.label}</span>
                <small>{pinnedNodeIds.has(stage.id) ? `${stage.level} · PIN` : stage.level}</small>
              </div>
              {unrevealedCount > 0 ? (
                <button
                  type="button"
                  className="cf-outline-expand-stage"
                  aria-label={`Expand ${stage.label} stage`}
                  title={`${String(unrevealedCount)} unrevealed workflow steps`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onExpandStage(stage.id);
                  }}
                >
                  Reveal {String(Math.min(unrevealedCount, MAX_REVEAL_PER_ACTION))} more
                </button>
              ) : null}
            </div>
            {children.length > 0 ? (
              <div id={`cf-outline-stage-${stage.id}`} role="group">
                {children.map((node) => item(node, 2, stage.id))}
              </div>
            ) : null}
          </div>
        );
      })}
      {ungrouped.map((node) => item(node, 1))}
    </div>
  );
}

function EvidenceInspector({
  node,
  edge,
  callsites,
  evidence,
  edges,
  nodeById,
  excerpts,
  busyEvidenceId,
  sourceEnabled,
  onSelectNode,
  onLoadSource,
}: {
  readonly node?: GraphNode | undefined;
  readonly edge?: GraphEdge | undefined;
  readonly callsites: readonly GraphNode[];
  readonly evidence: readonly EvidenceRecord[];
  readonly edges: readonly GraphEdge[];
  readonly nodeById: ReadonlyMap<string, GraphNode>;
  readonly excerpts: ReadonlyMap<string, CallFlowSourceExcerpt>;
  readonly busyEvidenceId?: string | undefined;
  readonly sourceEnabled: boolean;
  readonly onSelectNode: (nodeId: string) => void;
  readonly onLoadSource: (evidenceId: string) => void;
}) {
  if (!node && !edge) {
    return (
      <div className="cf-empty-inspector">
        <span aria-hidden="true">⌁</span>
        <strong>Select a workflow step or connection</strong>
        <p>Inspect its evidence, relationships, source span, and revision here.</p>
      </div>
    );
  }
  const subjectEvidenceIds = node?.evidenceIds ?? edge?.evidenceIds ?? [];
  const records = subjectEvidenceIds
    .map((evidenceId) => evidence.find((record) => record.id === evidenceId))
    .filter((record): record is EvidenceRecord => Boolean(record));
  const incoming = node ? edges.filter((candidate) => candidate.target === node.id) : [];
  const outgoing = node ? edges.filter((candidate) => candidate.source === node.id) : [];
  const sourceNode = edge ? nodeById.get(edge.source) : undefined;
  const targetNode = edge ? nodeById.get(edge.target) : undefined;
  const relationshipList = (relationships: readonly GraphEdge[], direction: "in" | "out") => (
    <ul className="cf-relationship-list">
      {relationships.map((relationship) => {
        const relatedId = direction === "in" ? relationship.source : relationship.target;
        const related = nodeById.get(relatedId);
        return (
          <li key={relationship.id}>
            <button
              type="button"
              onClick={() => {
                onSelectNode(relatedId);
              }}
            >
              <span>{related?.label ?? relatedId}</span>
              <small>
                {humanize(relationship.kind)} · {humanize(relationship.assertion)}
              </small>
            </button>
          </li>
        );
      })}
    </ul>
  );
  return (
    <div className="cf-inspector-content">
      {node ? (
        <>
          <div className="cf-inspector-heading">
            <span className="cf-kind-mark" aria-hidden="true">
              {nodeKindSymbol(node.kind)}
            </span>
            <div>
              <h2>{node.label}</h2>
              <p>
                {node.level} · {humanize(node.kind)} · {humanize(graphDiffStatus(node.attributes))}
              </p>
            </div>
          </div>
          {node.qualifiedName ? (
            <code className="cf-qualified-name">{node.qualifiedName}</code>
          ) : null}
          {node.summary ? <p className="cf-summary">{node.summary}</p> : null}
          {node.signature ? (
            <details className="cf-signature">
              <summary>Signature</summary>
              <code>{node.signature}</code>
            </details>
          ) : null}
        </>
      ) : edge ? (
        <>
          <div className="cf-inspector-heading">
            <span className="cf-kind-mark" aria-hidden="true">
              ⇢
            </span>
            <div>
              <h2>{edge.label ?? edge.condition ?? humanize(edge.kind)}</h2>
              <p>
                {humanize(edge.kind)} · {humanize(edge.assertion)} ·{" "}
                {humanize(graphDiffStatus(edge.attributes))}
              </p>
            </div>
          </div>
          <div className="cf-edge-endpoints" aria-label="Connection endpoints">
            <button
              type="button"
              onClick={() => {
                onSelectNode(edge.source);
              }}
            >
              <span>From</span>
              <strong>{sourceNode?.label ?? edge.source}</strong>
            </button>
            <span aria-hidden="true">→</span>
            <button
              type="button"
              onClick={() => {
                onSelectNode(edge.target);
              }}
            >
              <span>To</span>
              <strong>{targetNode?.label ?? edge.target}</strong>
            </button>
          </div>
          {edge.condition ? <p className="cf-summary">Condition: {edge.condition}</p> : null}
        </>
      ) : null}
      {node && callsites.length > 0 ? (
        <section className="cf-inspector-section">
          <h3>Callsites</h3>
          <ul className="cf-callsite-list">
            {callsites.map((callsite) => (
              <li key={callsite.id}>
                <strong>{callsite.label}</strong>
                {callsite.signature ? <code>{callsite.signature}</code> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {node ? (
        <section className="cf-inspector-section cf-relationships">
          <div>
            <h3>Incoming ({String(incoming.length)})</h3>
            {incoming.length > 0 ? relationshipList(incoming, "in") : <p>None</p>}
          </div>
          <div>
            <h3>Outgoing ({String(outgoing.length)})</h3>
            {outgoing.length > 0 ? relationshipList(outgoing, "out") : <p>None</p>}
          </div>
        </section>
      ) : null}
      {edge ? (
        <section className="cf-inspector-section cf-edge-context">
          <h3>Relationship context</h3>
          <p>
            {String(edges.filter((candidate) => candidate.target === edge.source).length)} incoming
            to source ·{" "}
            {String(edges.filter((candidate) => candidate.source === edge.target).length)} outgoing
            from target
          </p>
        </section>
      ) : null}
      <section className="cf-inspector-section">
        <h3>Evidence</h3>
        <div className="cf-evidence-list">
          {records.map((record) => {
            const excerpt = excerpts.get(record.id);
            const source = record.source;
            const sourceLabel =
              source.type === "source-span"
                ? `${source.path}:${String(source.start.line)}`
                : `${source.system}: ${source.reference}`;
            return (
              <article className="cf-evidence" data-state={record.state} key={record.id}>
                <div className="cf-evidence-title">
                  <strong>{humanize(record.kind)}</strong>
                  <span>{humanize(record.state)}</span>
                </div>
                <code>{sourceLabel}</code>
                <p>
                  {record.producer.name} {record.producer.version} · revision {record.revision}
                </p>
                {record.details ? <p>{record.details}</p> : null}
                {source.type === "source-span" && !excerpt ? (
                  <button
                    type="button"
                    className="cf-text-button"
                    disabled={!sourceEnabled || busyEvidenceId === record.id}
                    title={
                      sourceEnabled
                        ? undefined
                        : "Source access is expired or has no remaining budget."
                    }
                    onClick={() => {
                      onLoadSource(record.id);
                    }}
                  >
                    {busyEvidenceId === record.id ? "Loading source…" : "Load authorized source"}
                  </button>
                ) : null}
                {excerpt ? (
                  <div className="cf-source-excerpt">
                    <div>
                      <strong>
                        {excerpt.path}:{String(excerpt.startLine)}–{String(excerpt.endLine)}
                      </strong>
                      {excerpt.truncated ? <span>Truncated</span> : null}
                    </div>
                    <pre tabIndex={0} aria-label={`Source excerpt from ${excerpt.path}`}>
                      <code>{excerpt.content}</code>
                    </pre>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function CallFlowApp({
  app,
  bootstrapPayload,
}: {
  readonly app: App;
  readonly bootstrapPayload?: CallFlowUiPayload | undefined;
}) {
  const initialNodeIds = bootstrapPayload
    ? initialCallFlowNodeIds(
        bootstrapPayload.snapshot.nodes.filter((node) => node.level !== "L2"),
        bootstrapPayload.snapshot.layoutHints.stageOrder,
      )
    : [];
  const [payload, setPayload] = useState<CallFlowUiPayload | undefined>(bootstrapPayload);
  const [view, dispatch] = useReducer(callFlowViewReducer, undefined, () =>
    createCallFlowViewState(
      bootstrapPayload?.snapshot.id,
      initialNodeIds,
      presentationOverlay(bootstrapPayload?.snapshot.presentation.defaultOverlay),
    ),
  );
  const [canvasNodes, setCanvasNodes] = useState<CanvasNode[]>([]);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<CanvasNode>>();
  const [connectionError, setConnectionError] = useState<string>();
  const [operationError, setOperationError] = useState<string>();
  const [toast, setToast] = useState<string>();
  const [busyAction, setBusyAction] = useState<string>();
  const [busyEvidenceId, setBusyEvidenceId] = useState<string>();
  const [sourceExcerpts, setSourceExcerpts] = useState<ReadonlyMap<string, CallFlowSourceExcerpt>>(
    new Map(),
  );
  const [serverMatchIds, setServerMatchIds] = useState<readonly string[]>([]);
  const [serverPositions, setServerPositions] = useState<
    ReadonlyMap<string, { readonly x: number; readonly y: number }>
  >(new Map());
  const [layoutEngine, setLayoutEngine] = useState<"elk" | "deterministic-fallback">();
  const [layoutRequestVersion, setLayoutRequestVersion] = useState(0);
  const [hostBacked, setHostBacked] = useState(false);
  const [displayMode, setDisplayMode] = useState<"inline" | "fullscreen" | "pip">("inline");
  const [hostCapabilities, setHostCapabilities] = useState<McpUiHostCapabilities>({});
  const currentPayload = useRef<CallFlowUiPayload | undefined>(undefined);
  const hostBackedRef = useRef(false);
  const hostContext = useRef<HostContext>({});
  const manualPositions = useRef(new Map<string, { readonly x: number; readonly y: number }>());
  currentPayload.current = payload;

  const acceptPayload = useCallback((candidate: CallFlowUiPayload) => {
    const active = currentPayload.current;
    if (
      active &&
      hostBackedRef.current &&
      (candidate.sessionId !== active.sessionId ||
        candidate.snapshot.repository.identity !== active.snapshot.repository.identity)
    ) {
      setOperationError("A result for a different CallFlow session was rejected.");
      return false;
    }
    const expired = Date.parse(candidate.capability.expiresAt) <= Date.now();
    currentPayload.current = candidate;
    setPayload(candidate);
    setConnectionError(undefined);
    setOperationError(
      expired
        ? "This CallFlow source capability has expired. Render the workflow again."
        : undefined,
    );
    const overviewNodeIds = initialCallFlowNodeIds(
      candidate.snapshot.nodes.filter((node) => node.level !== "L2"),
      candidate.snapshot.layoutHints.stageOrder,
    );
    dispatch({
      type: "hydrate",
      graphRevision: candidate.snapshot.id,
      nodeIds: new Set(candidate.snapshot.nodes.map((node) => node.id)),
      edgeIds: new Set(candidate.snapshot.edges.map((edge) => edge.id)),
      initialNodeIds: overviewNodeIds,
      defaultOverlay: presentationOverlay(candidate.snapshot.presentation.defaultOverlay),
    });
    return true;
  }, []);

  const acceptCapabilityUpdate = useCallback((candidate: CallFlowCapabilityUpdate) => {
    const active = currentPayload.current;
    if (
      candidate.sessionId !== active?.sessionId ||
      candidate.capability.graphRevision !== active.snapshot.id ||
      candidate.capability.repositoryRevision !== active.snapshot.repository.commit
    ) {
      setOperationError("A capability for a different CallFlow session was rejected.");
      return false;
    }
    const next = { ...active, capability: candidate.capability };
    currentPayload.current = next;
    setPayload(next);
    setOperationError(
      Date.parse(candidate.capability.expiresAt) <= Date.now()
        ? "This CallFlow source capability has expired. Render the workflow again."
        : undefined,
    );
    return true;
  }, []);

  useEffect(() => {
    const onToolResult = (result: AppEventMap["toolresult"]) => {
      const candidate = metadataPayload(result);
      if (candidate) {
        hostBackedRef.current = true;
        setHostBacked(true);
        acceptPayload(candidate);
      }
    };
    app.addEventListener("toolresult", onToolResult);
    return () => {
      app.removeEventListener("toolresult", onToolResult);
    };
  }, [acceptPayload, app]);

  useEffect(() => {
    let mounted = true;
    const applyContext = (partial: McpUiHostContext) => {
      const context = { ...hostContext.current, ...partial } as HostContext;
      hostContext.current = context;
      if (context.theme === "light" || context.theme === "dark") applyDocumentTheme(context.theme);
      setDisplayMode(context.displayMode ?? "inline");
      if (context.locale) document.documentElement.lang = context.locale;
      const style = document.documentElement.style;
      style.setProperty("--cf-safe-top", `${String(context.safeAreaInsets?.top ?? 0)}px`);
      style.setProperty("--cf-safe-right", `${String(context.safeAreaInsets?.right ?? 0)}px`);
      style.setProperty("--cf-safe-bottom", `${String(context.safeAreaInsets?.bottom ?? 0)}px`);
      style.setProperty("--cf-safe-left", `${String(context.safeAreaInsets?.left ?? 0)}px`);
    };
    app.addEventListener("hostcontextchanged", applyContext);
    if (bootstrapPayload) {
      setConnectionError(undefined);
      setHostCapabilities({});
      return () => {
        mounted = false;
        app.removeEventListener("hostcontextchanged", applyContext);
      };
    }
    void app
      .connect(new QuietParentTransport(window.parent, window.parent))
      .then(() => {
        if (!mounted) return;
        const context = app.getHostContext();
        if (context) applyContext(context);
        setHostCapabilities(app.getHostCapabilities() ?? {});
        setConnectionError(undefined);
      })
      .catch(() => {
        if (mounted) {
          if (!currentPayload.current) {
            setConnectionError(
              "Could not connect to the Codex host. The workflow remains read-only.",
            );
          }
        }
      });
    return () => {
      mounted = false;
      app.removeEventListener("hostcontextchanged", applyContext);
    };
  }, [app, bootstrapPayload]);

  useEffect(() => {
    const close = () => void app.close();
    window.addEventListener("pagehide", close, { once: true });
    return () => {
      window.removeEventListener("pagehide", close);
    };
  }, [app]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => {
      setToast(undefined);
    }, 6_000);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [toast]);

  const snapshot = payload?.snapshot;
  const nodeById = useMemo(
    () => new Map(snapshot?.nodes.map((node) => [node.id, node]) ?? []),
    [snapshot?.nodes],
  );
  const stageMemberIds = useMemo(() => {
    const grouped = new Map<string, string[]>();
    for (const node of snapshot?.nodes ?? []) {
      if (node.level === "L2" || node.kind === "stage" || !node.stageId) continue;
      const memberIds = grouped.get(node.stageId) ?? [];
      memberIds.push(node.id);
      grouped.set(node.stageId, memberIds);
    }
    for (const memberIds of grouped.values()) memberIds.sort();
    return grouped;
  }, [snapshot?.nodes]);
  const unrevealedStageMemberCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const [stageId, memberIds] of stageMemberIds) {
      counts.set(stageId, memberIds.filter((nodeId) => !view.revealedNodeIds.has(nodeId)).length);
    }
    return counts;
  }, [stageMemberIds, view.revealedNodeIds]);
  const matchedNodeIds = useMemo(() => {
    const local = graphSearch(snapshot?.nodes ?? [], view.query, SEARCH_LIMIT);
    return new Set([...local, ...serverMatchIds]);
  }, [serverMatchIds, snapshot?.nodes, view.query]);
  const visibility = useMemo(() => {
    const evidence = snapshot?.evidence ?? [];
    const nodes = (snapshot?.nodes ?? [])
      .filter((node) => node.level !== "L2")
      .map((node) => ({
        ...node,
        evidenceState: worstEvidenceState(evidence, node.evidenceIds),
      }));
    return computeCallFlowVisibility(nodes, view);
  }, [snapshot?.evidence, snapshot?.nodes, view]);
  const visibleNodeKey = useMemo(
    () => [...visibility.visibleNodeIds].sort().join("\0"),
    [visibility.visibleNodeIds],
  );
  const pinnedNodeKey = useMemo(
    () => [...view.pinnedNodeIds].sort().join("\0"),
    [view.pinnedNodeIds],
  );
  const layoutRequestKey = `${snapshot?.id ?? ""}:${displayMode}:${String(layoutRequestVersion)}:${visibleNodeKey}:${pinnedNodeKey}`;
  const toggleStage = useCallback(
    (stageId: string) => {
      const selected = view.selectedNodeId ? nodeById.get(view.selectedNodeId) : undefined;
      if (
        selected?.stageId === stageId &&
        !view.collapsedStageIds.has(stageId) &&
        !view.pinnedNodeIds.has(selected.id)
      ) {
        dispatch({ type: "select", nodeId: stageId });
      }
      dispatch({ type: "toggle-stage", stageId });
    },
    [nodeById, view.collapsedStageIds, view.pinnedNodeIds, view.selectedNodeId],
  );
  const requestStageExpansion = useCallback(
    (stageId: string) => {
      dispatch({
        type: "expand-stage",
        stageId,
        memberIds: stageMemberIds.get(stageId) ?? [],
      });
    },
    [stageMemberIds],
  );
  const confirmStageExpansion = useCallback(
    (stageId: string) => {
      dispatch({
        type: "expand-stage",
        stageId,
        memberIds: stageMemberIds.get(stageId) ?? [],
        confirmed: true,
      });
    },
    [stageMemberIds],
  );
  const layout = useMemo(
    () =>
      layoutNodes(
        snapshot?.nodes.filter((node) => node.level !== "L2") ?? [],
        snapshot?.evidence ?? [],
        visibility.visibleNodeIds,
        view,
        matchedNodeIds,
        toggleStage,
        serverPositions,
        snapshot?.layoutHints.stageOrder ?? [],
      ),
    [
      matchedNodeIds,
      snapshot?.evidence,
      snapshot?.nodes,
      snapshot?.layoutHints.stageOrder,
      serverPositions,
      toggleStage,
      view,
      visibility.visibleNodeIds,
    ],
  );
  const canvasEdges = useMemo(
    () =>
      buildEdges(
        snapshot?.edges ?? [],
        visibility.visibleNodeIds,
        layout.stageIndex,
        nodeById,
        view.overlay,
        view.selectedEdgeId,
      ),
    [
      layout.stageIndex,
      nodeById,
      snapshot?.edges,
      view.overlay,
      view.selectedEdgeId,
      visibility.visibleNodeIds,
    ],
  );

  useEffect(() => {
    if (!snapshot || !view.selectedNodeId || visibility.visibleNodeIds.has(view.selectedNodeId)) {
      return;
    }
    dispatch({
      type: "select",
      nodeId: nearestVisibleNodeId(
        view.selectedNodeId,
        snapshot.nodes.filter((node) => node.level !== "L2"),
        visibility.visibleNodeIds,
      ),
      recordHistory: false,
    });
  }, [snapshot, view.selectedNodeId, visibility.visibleNodeIds]);

  useEffect(() => {
    if (!snapshot || !view.selectedEdgeId) return;
    const edge = snapshot.edges.find((candidate) => candidate.id === view.selectedEdgeId);
    if (
      edge &&
      visibility.visibleNodeIds.has(edge.source) &&
      visibility.visibleNodeIds.has(edge.target)
    ) {
      return;
    }
    dispatch({
      type: "select",
      nodeId: edge
        ? nearestVisibleNodeId(
            edge.source,
            snapshot.nodes.filter((node) => node.level !== "L2"),
            visibility.visibleNodeIds,
          )
        : undefined,
      recordHistory: false,
    });
  }, [snapshot, view.selectedEdgeId, visibility.visibleNodeIds]);

  useLayoutEffect(() => {
    setCanvasNodes((previous) => {
      const previousPositions = new Map(previous.map((node) => [node.id, node.position]));
      return layout.nodes.map((node) => ({
        ...node,
        position:
          manualPositions.current.get(node.id) ??
          (view.pinnedNodeIds.has(node.id) ? previousPositions.get(node.id) : undefined) ??
          (serverPositions.has(node.id) ? node.position : previousPositions.get(node.id)) ??
          node.position,
        selected: node.id === view.selectedNodeId,
      }));
    });
  }, [layout.nodes, serverPositions, view.pinnedNodeIds, view.selectedNodeId]);

  useEffect(() => {
    setSourceExcerpts(new Map());
    setServerPositions(new Map());
    setLayoutEngine(undefined);
  }, [snapshot?.id]);

  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    for (const change of changes) {
      if (change.type === "position" && change.position) {
        manualPositions.current.set(change.id, change.position);
      }
    }
    setCanvasNodes((nodes) => applyNodeChanges(changes, nodes));
  }, []);

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const selected = changes.find((change) => change.type === "select" && change.selected);
      if (selected?.type === "select") {
        dispatch({ type: "select-edge", edgeId: selected.id });
        return;
      }
      if (
        view.selectedEdgeId &&
        changes.some(
          (change) =>
            change.type === "select" && !change.selected && change.id === view.selectedEdgeId,
        )
      ) {
        dispatch({ type: "select-edge" });
      }
    },
    [view.selectedEdgeId],
  );

  const selectNode = useCallback((nodeId: string) => {
    dispatch({ type: "select", nodeId });
    window.setTimeout(() => {
      document.querySelector<HTMLElement>(".cf-inspector")?.focus({ preventScroll: true });
    }, 0);
  }, []);

  const selectEdge = useCallback((edgeId: string) => {
    dispatch({ type: "select-edge", edgeId });
    window.setTimeout(() => {
      document.querySelector<HTMLElement>(".cf-inspector")?.focus({ preventScroll: true });
    }, 0);
  }, []);

  const callHelper = useCallback(
    async (
      name: string,
      specificArguments: Readonly<Record<string, unknown>>,
      signal?: AbortSignal,
    ) => {
      if (!hostBackedRef.current) {
        throw new Error("This action requires the Codex host.");
      }
      const active = currentPayload.current;
      if (!active) throw new Error("No CallFlow workflow is loaded.");
      if (Date.parse(active.capability.expiresAt) <= Date.now()) {
        throw new Error("This CallFlow capability expired. Render the workflow again.");
      }
      const result = await app.callServerTool(
        {
          name,
          arguments: {
            sessionId: active.sessionId,
            capabilityToken: active.capability.token,
            graphRevision: active.capability.graphRevision,
            ...specificArguments,
          },
        },
        signal ? { signal, timeout: 7_000 } : undefined,
      );
      if (toolFailed(result)) throw new Error(`${humanize(name)} failed.`);
      const next = metadataPayload(result);
      if (next) acceptPayload(next);
      const capabilityUpdate = metadataCapabilityUpdate(result);
      if (capabilityUpdate) acceptCapabilityUpdate(capabilityUpdate);
      return result;
    },
    [acceptCapabilityUpdate, acceptPayload, app],
  );

  const withBusy = useCallback(async (label: string, operation: () => Promise<void>) => {
    setBusyAction(label);
    setOperationError(undefined);
    try {
      await operation();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : `${label} failed.`);
    } finally {
      setBusyAction(undefined);
    }
  }, []);

  useEffect(() => {
    const activePayload = currentPayload.current;
    if (!hostBacked || !activePayload || !visibleNodeKey) return;
    const controller = new AbortController();
    const requestedRevision = activePayload.capability.graphRevision;
    const visibleNodeIds = visibleNodeKey.split("\0");
    const knownNodeIds = new Set(activePayload.snapshot.nodes.map((node) => node.id));
    void callHelper(
      "callflow_relayout",
      { visibleNodeIds, pinnedNodeIds: pinnedNodeKey ? pinnedNodeKey.split("\0") : [] },
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        const parsed = parseLayoutResult(result);
        if (parsed?.graphRevision !== requestedRevision) {
          throw new Error("The layout helper returned an invalid or stale layout.");
        }
        const allowed = new Set(visibleNodeIds);
        const positions = new Map<string, { readonly x: number; readonly y: number }>();
        for (const position of parsed.positions) {
          if (allowed.has(position.nodeId) && knownNodeIds.has(position.nodeId)) {
            positions.set(position.nodeId, { x: position.x, y: position.y });
          }
        }
        setServerPositions(positions);
        setLayoutEngine(parsed.engine);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setOperationError(error instanceof Error ? error.message : "Server layout failed.");
      });
    return () => {
      controller.abort();
    };
  }, [callHelper, hostBacked, layoutRequestKey, pinnedNodeKey, visibleNodeKey]);

  const expand = useCallback(
    (direction: GraphDirection) => {
      if (!view.selectedNodeId) return;
      void withBusy(`expand-${direction}`, async () => {
        const result = await callHelper("callflow_expand", {
          nodeId: view.selectedNodeId,
          direction,
          depth: 1,
          limit: NORMAL_EXPANSION_LIMIT,
        });
        const returnedNodeIds = parseNodeListResult(result)?.nodeIds ?? [];
        dispatch({ type: "reveal", nodeIds: returnedNodeIds });
      });
    },
    [callHelper, view.selectedNodeId, withBusy],
  );

  const isolate = useCallback(
    (direction: GraphDirection) => {
      if (!snapshot || !view.selectedNodeId) return;
      const nodeIds = [...relatedNodeIds(snapshot.edges, view.selectedNodeId, direction)];
      dispatch({ type: "reveal", nodeIds });
      dispatch({
        type: "isolate",
        nodeIds,
      });
    },
    [snapshot, view.selectedNodeId],
  );

  const showPath = useCallback(() => {
    const fromNodeId = view.selectedNodeId;
    const toNodeId = view.pathTargetId;
    if (!snapshot || !fromNodeId || !toNodeId) return;
    void withBusy("path", async () => {
      let path = shortestDirectedPath(snapshot.edges, fromNodeId, toNodeId, 20);
      try {
        if (!hostBacked) throw new Error("standalone");
        const result = await callHelper("callflow_find_path", {
          fromNodeId,
          toNodeId,
          maxDepth: 20,
        });
        path = parseNodeListResult(result)?.nodeIds ?? path;
      } catch {
        // The validated local graph remains a safe fallback when the optional helper is unavailable.
      }
      if (path.length === 0) throw new Error("No directed path connects those workflow steps.");
      dispatch({ type: "reveal", nodeIds: path });
      dispatch({ type: "isolate", nodeIds: path });
      setToast(`Showing a path with ${String(path.length)} workflow steps.`);
    });
  }, [callHelper, hostBacked, snapshot, view.pathTargetId, view.selectedNodeId, withBusy]);

  const searchServer = useCallback(() => {
    const query = view.query.trim();
    if (!query) {
      setServerMatchIds([]);
      return;
    }
    if (!hostBacked) {
      const nodeIds = graphSearch(snapshot?.nodes ?? [], query, NORMAL_EXPANSION_LIMIT);
      setServerMatchIds(nodeIds);
      dispatch({ type: "reveal", nodeIds });
      return;
    }
    void withBusy("search", async () => {
      const result = await callHelper("callflow_search", { query, limit: SEARCH_LIMIT });
      const nodeIds = parseNodeListResult(result)?.nodeIds ?? [];
      setServerMatchIds(nodeIds);
      dispatch({ type: "reveal", nodeIds });
    });
  }, [callHelper, hostBacked, snapshot?.nodes, view.query, withBusy]);

  const loadSource = useCallback(
    (evidenceId: string) => {
      setBusyEvidenceId(evidenceId);
      setOperationError(undefined);
      void callHelper("callflow_get_source", {
        evidenceId,
        purpose: "Explain the user-selected workflow evidence in the local inspector.",
        maxBytes: Math.min(
          SOURCE_MAX_BYTES,
          currentPayload.current?.capability.sourceByteBudget ?? 0,
        ),
      })
        .then((result) => {
          const excerpt = parseSourceExcerpt(result);
          if (!excerpt) throw new Error("The source helper returned an invalid excerpt.");
          setSourceExcerpts((current) => new Map(current).set(excerpt.evidenceId, excerpt));
        })
        .catch((error: unknown) => {
          setOperationError(error instanceof Error ? error.message : "Source loading failed.");
        })
        .finally(() => {
          setBusyEvidenceId(undefined);
        });
    },
    [callHelper],
  );

  const requestFullscreen = useCallback(() => {
    void withBusy("fullscreen", async () => {
      const result = await app.requestDisplayMode({ mode: "fullscreen" });
      setDisplayMode(result.mode);
    });
  }, [app, withBusy]);

  const describeVisible = useCallback(() => {
    void withBusy("describe", async () => {
      const result = await callHelper("callflow_describe_visible", {
        visibleNodeIds: [...visibility.visibleNodeIds],
      });
      const structured = structuredRecord(result);
      const description = structured?.["description"];
      if (typeof description !== "string" || description.length > 8_192) {
        throw new Error("The visible-flow explanation was unavailable.");
      }
      if (typeof app.sendMessage !== "function") {
        throw new Error("The Codex host cannot receive a workflow explanation.");
      }
      await app.sendMessage({ role: "user", content: [{ type: "text", text: description }] });
      setToast("Sent the visible workflow context to Codex.");
    });
  }, [app, callHelper, visibility.visibleNodeIds, withBusy]);

  const selectedNode = view.selectedNodeId ? nodeById.get(view.selectedNodeId) : undefined;
  const selectedEdge = view.selectedEdgeId
    ? snapshot?.edges.find((edge) => edge.id === view.selectedEdgeId)
    : undefined;
  const selectedCallsites = selectedNode
    ? (snapshot?.nodes.filter((node) => node.level === "L2" && node.parentId === selectedNode.id) ??
      [])
    : [];
  const selectedSiblings = selectedNode ? stageSiblings(snapshot?.nodes ?? [], selectedNode) : [];
  const selectedStageUnrevealedCount =
    selectedNode?.kind === "stage" ? (unrevealedStageMemberCounts.get(selectedNode.id) ?? 0) : 0;
  const expansionPreviewStage = view.stageExpansionPreview
    ? nodeById.get(view.stageExpansionPreview.stageId)
    : undefined;
  const expansionPreviewRemainingCount = view.stageExpansionPreview
    ? (unrevealedStageMemberCounts.get(view.stageExpansionPreview.stageId) ??
      view.stageExpansionPreview.remainingCount)
    : 0;
  const expansionPreviewBatchSize = Math.min(expansionPreviewRemainingCount, MAX_REVEAL_PER_ACTION);
  const expansionAtVisibleLimit = visibility.visibleNodeIds.size >= MAX_VISIBLE_NODES;
  const visibleEdgeCount = canvasEdges.length;
  const eligibleVisibleEdgeCount =
    snapshot?.edges.filter(
      (edge) =>
        visibility.visibleNodeIds.has(edge.source) && visibility.visibleNodeIds.has(edge.target),
    ).length ?? 0;
  const edgeLimitHiddenCount = Math.max(0, eligibleVisibleEdgeCount - MAX_VISIBLE_EDGES);
  const endpointHiddenEdgeCount = Math.max(
    0,
    (snapshot?.edges.length ?? 0) - eligibleVisibleEdgeCount,
  );
  const hiddenEdgeCount = edgeLimitHiddenCount + endpointHiddenEdgeCount;
  const oversizedSnapshot =
    (snapshot?.nodes.filter((node) => node.level !== "L2").length ?? 0) > MAX_VISIBLE_NODES ||
    (snapshot?.edges.length ?? 0) > MAX_VISIBLE_EDGES;
  const nodeKinds = [
    ...new Set(
      snapshot?.nodes.filter((node) => node.level !== "L2").map((node) => node.kind) ?? [],
    ),
  ].sort();
  const evidenceStates = [
    ...new Set(snapshot?.evidence.map((record) => record.state) ?? []),
  ].sort();
  const breadcrumbStart = Math.max(0, view.historyIndex - 4);
  const breadcrumbs = view.history
    .slice(breadcrumbStart, view.historyIndex + 1)
    .map((nodeId, offset) => ({
      historyIndex: breadcrumbStart + offset,
      nodeId,
      label: nodeById.get(nodeId)?.label ?? nodeId,
    }));
  const canFullscreen = hostContext.current.availableDisplayModes?.includes("fullscreen") ?? false;
  const capabilityExpired = payload
    ? Date.parse(payload.capability.expiresAt) <= Date.now()
    : false;

  if (!payload) {
    return (
      <main className="callflow cf-loading" data-display-mode={displayMode}>
        <div className="cf-loading-mark" aria-hidden="true">
          ⌁
        </div>
        <h1>CallFlow</h1>
        <p>{connectionError ?? "Waiting for an evidence-backed workflow…"}</p>
      </main>
    );
  }

  return (
    <main className="callflow" data-display-mode={displayMode} data-overlay={view.overlay}>
      <header className="cf-header">
        <div className="cf-title-block">
          <span className="cf-mark" aria-hidden="true">
            ⌁
          </span>
          <div>
            <h1>CallFlow</h1>
            <p>
              {payload.snapshot.workflowManifestId} · {payload.snapshot.adapter.name}{" "}
              {payload.snapshot.adapter.version}
            </p>
          </div>
        </div>
        <div className="cf-header-meta">
          <span title={payload.snapshot.repository.commit}>
            revision {payload.snapshot.repository.commit.slice(0, 10)}
          </span>
          <span title={payload.snapshot.repository.dirtyDigest}>
            tree {payload.snapshot.repository.dirtyDigest.slice(7, 15)}
          </span>
          {canFullscreen && displayMode !== "fullscreen" ? (
            <button type="button" onClick={requestFullscreen} disabled={Boolean(busyAction)}>
              Open full map
            </button>
          ) : null}
        </div>
      </header>

      {connectionError ||
      operationError ||
      capabilityExpired ||
      oversizedSnapshot ||
      payload.snapshot.warnings.length > 0 ? (
        <div className="cf-alerts" aria-live="polite">
          {connectionError ? <p data-kind="error">{connectionError}</p> : null}
          {operationError ? <p data-kind="error">{operationError}</p> : null}
          {capabilityExpired ? (
            <p data-kind="warning">
              Source access expired. Render this workflow again to load source.
            </p>
          ) : null}
          {oversizedSnapshot ? (
            <p data-kind="warning">
              Preview mode: this workflow contains {String(payload.snapshot.nodes.length)} steps and{" "}
              {String(payload.snapshot.edges.length)} connections. CallFlow shows a bounded
              overview; narrow it with search or filters before expanding.
            </p>
          ) : null}
          {payload.snapshot.warnings.slice(0, 3).map((warning) => (
            <p data-kind="warning" key={warning.code}>
              {warning.message}
            </p>
          ))}
        </div>
      ) : null}

      {view.stageExpansionPreview && expansionPreviewStage && expansionPreviewRemainingCount > 0 ? (
        <section className="cf-stage-expansion-preview" aria-labelledby="cf-stage-preview-title">
          <div>
            <h2 id="cf-stage-preview-title">Stage expansion preview</h2>
            <p>
              {expansionPreviewStage.label} has {String(expansionPreviewRemainingCount)} unrevealed
              workflow steps. Reveal the next {String(expansionPreviewBatchSize)} or narrow the
              result with search and filters.
            </p>
          </div>
          <div>
            <button
              type="button"
              disabled={expansionAtVisibleLimit}
              title={
                expansionAtVisibleLimit
                  ? "The 250-step visible limit is reached; narrow the view first."
                  : undefined
              }
              onClick={() => {
                confirmStageExpansion(view.stageExpansionPreview?.stageId ?? "");
              }}
            >
              Reveal next {String(expansionPreviewBatchSize)}
            </button>
            <button
              type="button"
              className="cf-text-button"
              onClick={() => {
                dispatch({ type: "dismiss-stage-expansion" });
              }}
            >
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      <div className="cf-commandbar" aria-label="Workflow controls">
        <form
          className="cf-search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            searchServer();
          }}
        >
          <label htmlFor="cf-search-input">Search workflow</label>
          <div>
            <input
              id="cf-search-input"
              type="search"
              value={view.query}
              maxLength={200}
              placeholder="Function, table, queue…"
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                dispatch({ type: "set-query", query: event.currentTarget.value });
                setServerMatchIds([]);
              }}
            />
            <button type="submit" disabled={!view.query.trim() || busyAction === "search"}>
              Find
            </button>
          </div>
        </form>
        <label className="cf-overlay-control">
          Overlay
          <select
            value={view.overlay}
            onChange={(event) => {
              dispatch({
                type: "set-overlay",
                overlay: event.currentTarget.value as CallFlowOverlay,
              });
            }}
          >
            <option value="flow">All flow</option>
            <option value="data">Data movement</option>
            <option value="evidence">Evidence</option>
            <option value="failure">Failure exits</option>
            <option value="retry">Retries and polls</option>
            <option value="transaction">Transactions</option>
            <option value="change">Change impact</option>
          </select>
        </label>
        <div className="cf-filter-controls" aria-label="Workflow filters">
          <label>
            Node type
            <select
              value={view.nodeKindFilter}
              onChange={(event) => {
                dispatch({ type: "set-node-kind-filter", kind: event.currentTarget.value });
              }}
            >
              <option value="all">All node types</option>
              {nodeKinds.map((kind) => (
                <option value={kind} key={kind}>
                  {humanize(kind)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Evidence
            <select
              value={view.evidenceStateFilter}
              onChange={(event) => {
                dispatch({ type: "set-evidence-state-filter", state: event.currentTarget.value });
              }}
            >
              <option value="all">All evidence</option>
              {evidenceStates.map((state) => (
                <option value={state} key={state}>
                  {humanize(state)}
                </option>
              ))}
            </select>
          </label>
          {view.nodeKindFilter !== "all" || view.evidenceStateFilter !== "all" ? (
            <button
              type="button"
              className="cf-text-button"
              onClick={() => {
                dispatch({ type: "clear-filters" });
              }}
            >
              Clear filters
            </button>
          ) : null}
        </div>
        <div className="cf-history-controls">
          <IconButton
            label="Previous selection"
            disabled={view.historyIndex <= 0}
            onClick={() => {
              dispatch({ type: "history-back" });
            }}
          >
            ←
          </IconButton>
          <IconButton
            label="Next selection"
            disabled={view.historyIndex >= view.history.length - 1}
            onClick={() => {
              dispatch({ type: "history-forward" });
            }}
          >
            →
          </IconButton>
          <button
            type="button"
            onClick={() => {
              manualPositions.current.clear();
              dispatch({
                type: "reset",
                graphRevision: payload.snapshot.id,
                initialNodeIds: initialCallFlowNodeIds(
                  payload.snapshot.nodes.filter((node) => node.level !== "L2"),
                  payload.snapshot.layoutHints.stageOrder,
                ),
                defaultOverlay: presentationOverlay(payload.snapshot.presentation.defaultOverlay),
              });
              window.setTimeout(
                () =>
                  void flowInstance?.fitView({
                    duration: viewportAnimationDuration(
                      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
                    ),
                    padding: 0.12,
                  }),
                0,
              );
            }}
          >
            Reset view
          </button>
        </div>
        <nav className="cf-breadcrumbs" aria-label="Selection breadcrumb">
          <span>Trail</span>
          {breadcrumbs.length > 0 ? (
            <ol>
              {breadcrumbStart > 0 ? <li aria-hidden="true">…</li> : null}
              {breadcrumbs.map((crumb) => (
                <li key={`${crumb.nodeId}:${String(crumb.historyIndex)}`}>
                  <button
                    type="button"
                    aria-current={crumb.historyIndex === view.historyIndex ? "step" : undefined}
                    title={crumb.label}
                    onClick={() => {
                      dispatch({ type: "history-go", historyIndex: crumb.historyIndex });
                    }}
                  >
                    {crumb.label}
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p>Select a step to begin.</p>
          )}
        </nav>
      </div>

      <div className="cf-workspace">
        <aside className="cf-outline" aria-labelledby="cf-outline-heading">
          <div className="cf-pane-heading">
            <div>
              <h2 id="cf-outline-heading">Workflow outline</h2>
              <p>
                {String(visibility.visibleNodeIds.size)} shown
                {visibility.hiddenCount > 0 ? ` · ${String(visibility.hiddenCount)} hidden` : ""}
              </p>
            </div>
            {view.isolatedNodeIds || view.hiddenSiblingIds.size > 0 ? (
              <button
                type="button"
                className="cf-text-button"
                onClick={() => {
                  dispatch({ type: "show-all" });
                }}
              >
                Show all
              </button>
            ) : null}
          </div>
          {visibility.hiddenCount > 0 ? (
            <details className="cf-hidden-reasons">
              <summary>Why steps are hidden</summary>
              <ul>
                {Object.entries(visibility.hiddenReasons)
                  .filter(([, count]) => count > 0)
                  .map(([reason, count]) => (
                    <li key={reason}>
                      {humanize(reason)}: {String(count)}
                    </li>
                  ))}
              </ul>
            </details>
          ) : null}
          <Outline
            nodes={payload.snapshot.nodes.filter(
              (node) => node.level !== "L2" && visibility.visibleNodeIds.has(node.id),
            )}
            selectedNodeId={view.selectedNodeId}
            matchedNodeIds={matchedNodeIds}
            collapsedStageIds={view.collapsedStageIds}
            pinnedNodeIds={view.pinnedNodeIds}
            unrevealedMemberCounts={unrevealedStageMemberCounts}
            stageOrder={payload.snapshot.layoutHints.stageOrder}
            onSelect={selectNode}
            onExpandStage={requestStageExpansion}
            onToggleStage={toggleStage}
          />
        </aside>

        <section className="cf-canvas-pane" aria-labelledby="cf-canvas-heading">
          <div className="cf-pane-heading cf-canvas-heading">
            <div>
              <h2 id="cf-canvas-heading">Causal map</h2>
              <p>
                {String(visibleEdgeCount)} connections
                {hiddenEdgeCount > 0 ? ` · ${String(hiddenEdgeCount)} hidden` : ""}
                {layoutEngine ? ` · ${layoutEngine === "elk" ? "ELK" : "fallback"} layout` : ""}
              </p>
            </div>
            <div className="cf-legend" aria-label="Connection legend">
              <span data-kind="sync">Call</span>
              <span data-kind="async">Async</span>
              <span data-kind="retry">Retry</span>
              <span data-kind="failure">Failure</span>
            </div>
          </div>
          <div className="cf-canvas" data-testid="callflow-canvas">
            <ReactFlow<CanvasNode>
              nodes={canvasNodes}
              edges={canvasEdges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onInit={setFlowInstance}
              onNodeClick={(_event, node) => {
                selectNode(node.id);
              }}
              onEdgeClick={(_event, edge) => {
                selectEdge(edge.id);
              }}
              onPaneClick={() => {
                dispatch({ type: "select" });
              }}
              onMoveEnd={(_event, viewport: CallFlowViewport) => {
                dispatch({ type: "set-viewport", viewport });
              }}
              defaultViewport={view.viewport}
              minZoom={0.2}
              maxZoom={2.2}
              fitView
              fitViewOptions={{ padding: 0.12 }}
              nodesFocusable
              edgesFocusable
              onlyRenderVisibleElements
              proOptions={{ hideAttribution: false }}
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
              <MiniMap
                pannable
                zoomable
                ariaLabel="Workflow minimap"
                nodeColor={(node) =>
                  node.data["evidenceState"] === "exact" ? "#14b8a6" : "#f59e0b"
                }
              />
              <Controls showInteractive={false} position="bottom-center" />
            </ReactFlow>
          </div>
          <div className="cf-action-tray" aria-label="Selected workflow actions">
            <button
              type="button"
              disabled={selectedNode?.kind !== "stage" || selectedStageUnrevealedCount === 0}
              title={
                selectedNode?.kind === "stage" && selectedStageUnrevealedCount > 0
                  ? `${String(selectedStageUnrevealedCount)} unrevealed workflow steps`
                  : undefined
              }
              onClick={() => {
                if (selectedNode?.kind === "stage") requestStageExpansion(selectedNode.id);
              }}
            >
              Expand stage
            </button>
            <button
              type="button"
              disabled={!hostBacked || !selectedNode || Boolean(busyAction)}
              title={hostBacked ? undefined : "Expansion requires the Codex host."}
              onClick={() => {
                expand("both");
              }}
            >
              Expand one hop
            </button>
            <button
              type="button"
              disabled={!selectedNode}
              onClick={() => {
                isolate("callers");
              }}
            >
              Callers
            </button>
            <button
              type="button"
              disabled={!selectedNode}
              onClick={() => {
                isolate("callees");
              }}
            >
              Callees
            </button>
            <button
              type="button"
              disabled={!selectedNode || view.pinnedNodeIds.size >= MAX_VISIBLE_NODES}
              aria-pressed={selectedNode ? view.pinnedNodeIds.has(selectedNode.id) : false}
              onClick={() => {
                if (selectedNode) dispatch({ type: "toggle-pin", nodeId: selectedNode.id });
              }}
            >
              {selectedNode && view.pinnedNodeIds.has(selectedNode.id) ? "Unpin" : "Pin"}
            </button>
            <button
              type="button"
              disabled={selectedSiblings.length === 0}
              onClick={() => {
                dispatch({ type: "collapse-siblings", siblingIds: selectedSiblings });
              }}
            >
              Collapse siblings
            </button>
            <button
              type="button"
              onClick={() =>
                void flowInstance?.fitView({
                  duration: viewportAnimationDuration(
                    window.matchMedia("(prefers-reduced-motion: reduce)").matches,
                  ),
                  padding: 0.12,
                })
              }
            >
              Fit
            </button>
            <button
              type="button"
              disabled={!hostBacked}
              title={hostBacked ? undefined : "Server layout requires the Codex host."}
              onClick={() => {
                setLayoutRequestVersion((version) => version + 1);
              }}
            >
              Relayout
            </button>
          </div>
          <div className="cf-path-controls">
            <label htmlFor="cf-path-target">Path from selected step to</label>
            <select
              id="cf-path-target"
              value={view.pathTargetId ?? ""}
              disabled={!selectedNode}
              onChange={(event) => {
                dispatch({
                  type: "set-path-target",
                  nodeId: event.currentTarget.value || undefined,
                });
              }}
            >
              <option value="">Choose a destination</option>
              {payload.snapshot.nodes
                .filter((node) => node.id !== selectedNode?.id)
                .map((node) => (
                  <option value={node.id} key={node.id}>
                    {node.label}
                  </option>
                ))}
            </select>
            <button
              type="button"
              disabled={!selectedNode || !view.pathTargetId || busyAction === "path"}
              onClick={showPath}
            >
              Show path
            </button>
            <button
              type="button"
              disabled={!hostBacked || Boolean(busyAction) || !hostCapabilities.message?.text}
              onClick={describeVisible}
              title={
                hostCapabilities.message?.text
                  ? undefined
                  : "The host did not advertise text message delivery."
              }
            >
              Explain visible flow
            </button>
          </div>
        </section>

        <aside className="cf-inspector" tabIndex={-1} aria-labelledby="cf-inspector-label">
          <div className="cf-pane-heading">
            <div>
              <h2 id="cf-inspector-label">Evidence inspector</h2>
              <p>Local source stays private until requested.</p>
            </div>
          </div>
          <EvidenceInspector
            node={selectedNode}
            edge={selectedEdge}
            callsites={selectedCallsites}
            evidence={payload.snapshot.evidence}
            edges={payload.snapshot.edges}
            nodeById={nodeById}
            excerpts={sourceExcerpts}
            busyEvidenceId={busyEvidenceId}
            sourceEnabled={
              hostBacked && !capabilityExpired && payload.capability.sourceByteBudget > 0
            }
            onSelectNode={selectNode}
            onLoadSource={loadSource}
          />
        </aside>
      </div>

      {toast ? (
        <div className="cf-toast" role="status">
          {toast}
        </div>
      ) : null}
      {busyAction ? (
        <div className="cf-busy" role="status">
          Working: {humanize(busyAction)}
        </div>
      ) : null}
    </main>
  );
}

const rootElement = document.querySelector<HTMLElement>("#callflow-root");
if (!rootElement) throw new Error("CallFlow root element is missing.");
if (!document.documentElement.hasAttribute("data-theme")) {
  applyDocumentTheme(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
const app = new App(
  { name: "CallFlow", version: "0.1.0" },
  { availableDisplayModes: ["inline", "fullscreen"] },
  { strict: true, allowUnsafeEval: false },
);
const bootstrapPayload = readBootstrapPayload(document);
createRoot(rootElement).render(
  <ReactFlowProvider>
    <CallFlowApp app={app} bootstrapPayload={bootstrapPayload} />
  </ReactFlowProvider>,
);

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";

import { GraphSnapshotSchema, type GraphSnapshot } from "@callflow/contracts";

import { CallFlowError } from "./errors.js";

const SMALL_LAYOUT_TIMEOUT_MS = 250;
const LARGE_LAYOUT_TIMEOUT_MS = 1_000;
const NODE_WIDTH = 240;
const NODE_HEIGHT = 72;
const STAGE_HORIZONTAL_PADDING = 20;
const STAGE_VERTICAL_HEADER = 58;
const STAGE_MEMBER_GAP = 10;

export interface LayoutPosition {
  readonly nodeId: string;
  readonly x: number;
  readonly y: number;
}

export interface CallFlowLayout {
  readonly schema: "callflow/layout-v1";
  readonly graphRevision: string;
  readonly engine: "elk" | "deterministic-fallback";
  readonly positions: readonly LayoutPosition[];
}

interface WorkerResult {
  readonly ok: boolean;
  readonly positions?: readonly LayoutPosition[];
}

interface LayoutGroup {
  readonly id: string;
  readonly memberIds: readonly string[];
}

export interface LayoutGraphOptions {
  readonly workerPath?: string;
}

function orderedNodes(snapshot: GraphSnapshot): GraphSnapshot["nodes"] {
  const stageRanks = new Map(
    snapshot.layoutHints.stageOrder.map((nodeId, index) => [nodeId, index]),
  );
  return [...snapshot.nodes].sort((left, right) => {
    const leftStage = left.kind === "stage" ? left.id : left.stageId;
    const rightStage = right.kind === "stage" ? right.id : right.stageId;
    const leftRank = leftStage
      ? (stageRanks.get(leftStage) ?? Number.POSITIVE_INFINITY)
      : Number.POSITIVE_INFINITY;
    const rightRank = rightStage
      ? (stageRanks.get(rightStage) ?? Number.POSITIVE_INFINITY)
      : Number.POSITIVE_INFINITY;
    if (leftRank !== rightRank) return leftRank - rightRank;
    if (left.kind === "stage" && right.kind !== "stage") return -1;
    if (right.kind === "stage" && left.kind !== "stage") return 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

function layoutGroups(snapshot: GraphSnapshot): readonly LayoutGroup[] {
  return snapshot.layoutHints.stageOrder.map((stageId) => ({
    id: stageId,
    memberIds: orderedNodes(snapshot)
      .filter((node) => node.kind !== "stage" && node.stageId === stageId)
      .map((node) => node.id),
  }));
}

function topLevelNodeId(
  nodeId: string,
  nodeById: ReadonlyMap<string, GraphSnapshot["nodes"][number]>,
): string {
  const node = nodeById.get(nodeId);
  return node?.kind === "stage" ? node.id : (node?.stageId ?? nodeId);
}

function workerGraph(snapshot: GraphSnapshot, groups: readonly LayoutGroup[]) {
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const groupedIds = new Set(groups.flatMap((group) => group.memberIds));
  const topLevelNodes = [
    ...groups.map((group) => ({
      id: group.id,
      width: NODE_WIDTH + STAGE_HORIZONTAL_PADDING * 2,
      height: Math.max(
        160,
        STAGE_VERTICAL_HEADER +
          group.memberIds.length * NODE_HEIGHT +
          Math.max(0, group.memberIds.length - 1) * STAGE_MEMBER_GAP +
          STAGE_HORIZONTAL_PADDING,
      ),
    })),
    ...orderedNodes(snapshot)
      .filter((node) => node.kind !== "stage" && !groupedIds.has(node.id))
      .map((node) => ({ id: node.id, width: NODE_WIDTH, height: NODE_HEIGHT })),
  ];
  const seen = new Set<string>();
  const edges = [...snapshot.edges]
    .sort((left, right) => {
      const leftFeedback = left.kind === "retry" || left.kind === "poll" ? 1 : 0;
      const rightFeedback = right.kind === "retry" || right.kind === "poll" ? 1 : 0;
      return leftFeedback - rightFeedback || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    })
    .flatMap((edge) => {
      const source = topLevelNodeId(edge.source, nodeById);
      const target = topLevelNodeId(edge.target, nodeById);
      const identity = `${source}\0${target}`;
      if (source === target || seen.has(identity)) return [];
      seen.add(identity);
      return [{ id: edge.id, sources: [source], targets: [target] }];
    });
  return { id: snapshot.id, children: topLevelNodes, edges };
}

function fallback(snapshot: GraphSnapshot): CallFlowLayout {
  const groups = layoutGroups(snapshot);
  const groupedIds = new Set(groups.flatMap((group) => group.memberIds));
  const positions: LayoutPosition[] = [];
  for (const [stageIndex, group] of groups.entries()) {
    const stageX = stageIndex * 360;
    positions.push({ nodeId: group.id, x: stageX, y: 0 });
    for (const [memberIndex, nodeId] of group.memberIds.entries()) {
      positions.push({
        nodeId,
        x: stageX + STAGE_HORIZONTAL_PADDING,
        y: STAGE_VERTICAL_HEADER + memberIndex * (NODE_HEIGHT + STAGE_MEMBER_GAP),
      });
    }
  }
  const ungrouped = orderedNodes(snapshot).filter(
    (node) => node.kind !== "stage" && !groupedIds.has(node.id),
  );
  for (const [index, node] of ungrouped.entries()) {
    positions.push({
      nodeId: node.id,
      x: (groups.length + (index % 2)) * 360,
      y: Math.floor(index / 2) * 132,
    });
  }
  return {
    schema: "callflow/layout-v1",
    graphRevision: snapshot.id,
    engine: "deterministic-fallback",
    positions,
  };
}

export async function layoutGraph(
  snapshotValue: GraphSnapshot,
  signal?: AbortSignal,
  options: LayoutGraphOptions = {},
): Promise<CallFlowLayout> {
  const snapshot = GraphSnapshotSchema.parse(snapshotValue);
  if (signal?.aborted === true) {
    throw new CallFlowError("aborted", "The CallFlow layout was cancelled.", true);
  }
  const defaultWorkerPath =
    typeof __dirname === "string" ? resolve(__dirname, "callflow-layout-worker.cjs") : undefined;
  const workerPath = options.workerPath ?? defaultWorkerPath;
  if (!workerPath) return fallback(snapshot);
  try {
    await access(workerPath);
  } catch {
    return fallback(snapshot);
  }
  const groups = layoutGroups(snapshot);
  const graph = workerGraph(snapshot, groups);

  return await new Promise<CallFlowLayout>((resolve, reject) => {
    let settled = false;
    const worker = new Worker(workerPath, {
      workerData: { graph, groups, stageOrder: snapshot.layoutHints.stageOrder },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
    });
    const finish = (layout: CallFlowLayout): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      resolve(layout);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      reject(new CallFlowError("aborted", "The CallFlow layout was cancelled.", true));
    };
    const timer = setTimeout(
      () => {
        finish(fallback(snapshot));
      },
      snapshot.nodes.length <= 30 ? SMALL_LAYOUT_TIMEOUT_MS : LARGE_LAYOUT_TIMEOUT_MS,
    );
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message: WorkerResult) => {
      if (!message.ok || !message.positions) {
        finish(fallback(snapshot));
        return;
      }
      finish({
        schema: "callflow/layout-v1",
        graphRevision: snapshot.id,
        engine: "elk",
        positions: message.positions,
      });
    });
    worker.once("error", () => {
      finish(fallback(snapshot));
    });
    worker.once("exit", (code) => {
      if (code !== 0) finish(fallback(snapshot));
    });
  });
}

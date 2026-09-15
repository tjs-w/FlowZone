import { parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";

import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api.js";

interface LayoutWorkerData {
  readonly graph: ElkNode;
  readonly groups?: readonly {
    readonly id: string;
    readonly memberIds: readonly string[];
  }[];
  readonly stageOrder?: readonly string[];
}

const STAGE_HORIZONTAL_STEP = 368;
const STAGE_HORIZONTAL_PADDING = 20;
const STAGE_VERTICAL_HEADER = 58;
const STAGE_MEMBER_HEIGHT = 72;
const STAGE_MEMBER_GAP = 10;

function compareIds(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

async function run(): Promise<void> {
  if (!parentPort) throw new Error("CallFlow layout worker requires a parent port.");
  const { graph, groups = [], stageOrder = [] } = workerData as LayoutWorkerData;
  const elk = new ELK();
  try {
    const layoutStarted = performance.now();
    const result = await elk.layout(graph, {
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.layered.feedbackEdges": "true",
        "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
        "elk.spacing.nodeNode": "42",
        "elk.layered.spacing.nodeNodeBetweenLayers": "88",
      },
    });
    const topLevel = new Map(
      (result.children ?? []).map((node) => [
        node.id,
        {
          x: Number.isFinite(node.x) ? (node.x ?? 0) : 0,
          y: Number.isFinite(node.y) ? (node.y ?? 0) : 0,
        },
      ]),
    );
    const stageStartX = Math.min(0, ...stageOrder.map((stageId) => topLevel.get(stageId)?.x ?? 0));
    for (const [index, stageId] of stageOrder.entries()) {
      const existing = topLevel.get(stageId);
      if (existing)
        topLevel.set(stageId, { x: stageStartX + index * STAGE_HORIZONTAL_STEP, y: existing.y });
    }
    const positions = [
      ...[...topLevel].map(([nodeId, position]) => ({ nodeId, ...position })),
      ...groups.flatMap((group) => {
        const stage = topLevel.get(group.id);
        if (!stage) return [];
        return group.memberIds.map((nodeId, index) => ({
          nodeId,
          x: stage.x + STAGE_HORIZONTAL_PADDING,
          y: stage.y + STAGE_VERTICAL_HEADER + index * (STAGE_MEMBER_HEIGHT + STAGE_MEMBER_GAP),
        }));
      }),
    ].sort((left, right) => compareIds({ id: left.nodeId }, { id: right.nodeId }));
    parentPort.postMessage({
      ok: true,
      layoutMilliseconds: performance.now() - layoutStarted,
      positions,
    });
  } catch {
    parentPort.postMessage({ ok: false });
  } finally {
    try {
      elk.terminateWorker();
    } catch {
      // The bundled Node adapter has no long-lived web worker to terminate.
    }
  }
}

void run().catch(() => {
  parentPort?.postMessage({ ok: false });
});

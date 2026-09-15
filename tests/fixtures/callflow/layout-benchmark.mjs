/* global process */

import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

const [workerPath, rawNodeCount, mode] = process.argv.slice(2);
const nodeCount = Number(rawNodeCount);
if (!workerPath || !Number.isInteger(nodeCount) || nodeCount < 1 || nodeCount > 250) {
  process.exitCode = 2;
} else {
  const nodeId = (index) => `node-${String(index).padStart(3, "0")}`;
  const grouped = mode === "grouped";
  const groups = grouped
    ? [
        { id: "stage-a", memberIds: [nodeId(0), nodeId(1)] },
        { id: "stage-b", memberIds: [nodeId(2), nodeId(3)] },
      ]
    : [];
  const stageOrder = grouped ? ["stage-b", "stage-a"] : [];
  const graph = grouped
    ? {
        id: `performance-${String(nodeCount)}`,
        children: [
          { id: "stage-a", width: 280, height: 242 },
          { id: "stage-b", width: 280, height: 242 },
        ],
        edges: [{ id: "stage-edge", sources: ["stage-a"], targets: ["stage-b"] }],
      }
    : {
        id: `performance-${String(nodeCount)}`,
        children: Array.from({ length: nodeCount }, (_, index) => ({
          id: nodeId(index),
          width: 240,
          height: 72,
        })),
        edges: Array.from({ length: Math.max(0, nodeCount - 1) }, (_, index) => ({
          id: `edge-${String(index).padStart(3, "0")}`,
          sources: [nodeId(index)],
          targets: [nodeId(index + 1)],
        })),
      };
  const roundTripStarted = performance.now();
  const worker = new Worker(workerPath, { workerData: { graph, groups, stageOrder } });
  worker.once("message", (message) => {
    const roundTripMilliseconds = performance.now() - roundTripStarted;
    if (
      !message?.ok ||
      !Array.isArray(message.positions) ||
      !Number.isFinite(message.layoutMilliseconds) ||
      message.layoutMilliseconds < 0
    ) {
      process.exitCode = 1;
    } else {
      const positions = new Map(message.positions.map((position) => [position.nodeId, position]));
      process.stdout.write(
        `${JSON.stringify({
          layoutMilliseconds: message.layoutMilliseconds,
          roundTripMilliseconds,
          positionCount: message.positions.length,
          stageOrderPreserved: grouped
            ? positions.get("stage-b")?.x < positions.get("stage-a")?.x
            : undefined,
          membersProjected: grouped
            ? positions.get(nodeId(2))?.x === positions.get("stage-b")?.x + 20 &&
              positions.get(nodeId(0))?.x === positions.get("stage-a")?.x + 20
            : undefined,
        })}\n`,
      );
    }
    void worker.terminate();
  });
  worker.once("error", () => {
    process.exitCode = 1;
  });
}

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const digest = `sha256:${"2".repeat(64)}`;

export const callFlowHarnessPayload = {
  schema: "callflow/ui-payload-v1",
  sessionId: "callflow-e2e-session",
  capability: {
    token: "callflow-e2e-capability-token-1234567890",
    expiresAt: "2099-01-01T00:00:00.000Z",
    repositoryRevision: "fixture-commit",
    graphRevision: "callflow-e2e-graph",
    sourceByteBudget: 65_536,
  },
  snapshot: {
    schemaVersion: "callflow/graph-snapshot-v1",
    id: "callflow-e2e-graph",
    workflowManifestId: "async-document-write",
    repository: {
      identity: "callflow-e2e-fixture",
      commit: "fixture-commit",
      dirtyDigest: digest,
    },
    adapter: { name: "graft", version: "0.18.0", indexRevision: "fixture-index" },
    nodes: [
      { id: "stage-receive", kind: "stage", label: "Receive", level: "L0", evidenceIds: ["e1"] },
      {
        id: "route",
        kind: "function",
        label: "Route request",
        level: "L1",
        stageId: "stage-receive",
        evidenceIds: ["e1"],
        qualifiedName: "api.route",
      },
      {
        id: "validate",
        kind: "condition",
        label: "Validate input",
        level: "L1",
        stageId: "stage-receive",
        evidenceIds: ["e1"],
      },
      { id: "stage-process", kind: "stage", label: "Process", level: "L0", evidenceIds: ["e1"] },
      {
        id: "enqueue",
        kind: "queue",
        label: "Enqueue outbox",
        level: "L1",
        stageId: "stage-process",
        evidenceIds: ["e1"],
      },
      {
        id: "worker",
        kind: "function",
        label: "Process record",
        level: "L1",
        stageId: "stage-process",
        evidenceIds: ["e1"],
        summary: "Claims and projects one queued record.",
        attributes: { diffStatus: "changed" },
      },
      {
        id: "retry",
        kind: "condition",
        label: "Retry eligible",
        level: "L1",
        stageId: "stage-process",
        evidenceIds: ["e1"],
        attributes: { diffStatus: "broken" },
      },
      { id: "stage-store", kind: "stage", label: "Store", level: "L0", evidenceIds: ["e1"] },
      {
        id: "transaction",
        kind: "transaction",
        label: "Commit projection",
        level: "L1",
        stageId: "stage-store",
        evidenceIds: ["e1"],
      },
      {
        id: "index",
        kind: "database",
        label: "Search index",
        level: "L1",
        stageId: "stage-store",
        evidenceIds: ["e1"],
      },
      {
        id: "worker-callsite",
        kind: "function",
        label: "processClaim call",
        level: "L2",
        parentId: "worker",
        stageId: "stage-process",
        signature: "await processClaim(record)",
        evidenceIds: ["e1"],
      },
    ],
    edges: [
      {
        id: "edge-route-validate",
        source: "route",
        target: "validate",
        kind: "conditional-call",
        assertion: "static-possible",
        evidenceIds: ["e1"],
      },
      {
        id: "edge-validate-enqueue",
        source: "validate",
        target: "enqueue",
        kind: "async-handoff",
        assertion: "curated-workflow",
        evidenceIds: ["e2"],
      },
      {
        id: "edge-enqueue-worker",
        source: "enqueue",
        target: "worker",
        kind: "poll",
        assertion: "static-possible",
        evidenceIds: ["e1"],
      },
      {
        id: "edge-worker-transaction",
        source: "worker",
        target: "transaction",
        kind: "direct-call",
        assertion: "static-possible",
        evidenceIds: ["e1"],
        attributes: { diffStatus: "changed" },
      },
      {
        id: "edge-transaction-index",
        source: "transaction",
        target: "index",
        kind: "state-write",
        assertion: "curated-workflow",
        evidenceIds: ["e2"],
      },
      {
        id: "edge-worker-retry",
        source: "worker",
        target: "retry",
        kind: "failure-exit",
        assertion: "curated-workflow",
        evidenceIds: ["e2"],
        attributes: { diffStatus: "broken" },
      },
      {
        id: "edge-retry-enqueue",
        source: "retry",
        target: "enqueue",
        kind: "retry",
        assertion: "curated-workflow",
        evidenceIds: ["e2"],
      },
    ],
    evidence: [
      {
        id: "e1",
        kind: "graft-exact",
        state: "exact",
        revision: "fixture-commit",
        source: {
          type: "source-span",
          path: "src/workflow.ts",
          start: { line: 10, column: 1 },
          end: { line: 14, column: 2 },
          symbol: "processClaim",
        },
        contentDigest: digest,
        producer: { name: "graft", version: "0.18.0" },
        details: "Exact source span from the fixture index.",
      },
      {
        id: "e2",
        kind: "human-curated",
        state: "exact",
        revision: "fixture-commit",
        source: {
          type: "external-reference",
          system: "CallFlow fixture",
          reference: "reviewed async workflow intent",
        },
        contentDigest: digest,
        producer: { name: "callflow-fixture", version: "0.1.0" },
        details: "Reviewed workflow relationship for the browser acceptance fixture.",
      },
    ],
    warnings: [],
    presentation: {
      schemaVersion: "callflow/graph-presentation-v1",
      direction: "RIGHT",
      defaultOverlay: "data",
    },
    layoutHints: {
      schemaVersion: "callflow/graph-layout-hints-v1",
      stageOrder: ["stage-receive", "stage-process", "stage-store"],
    },
    extraction: { status: "succeeded", items: ["e1", "e2"] },
    runtimeEvidence: {
      status: "unavailable",
      reason: "Runtime evidence is unavailable in CallFlow v1.",
    },
  },
} as const;

function scriptData(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function hostScript(payload: unknown = callFlowHarnessPayload): string {
  const initialResult = {
    content: [{ type: "text", text: "CallFlow fixture ready." }],
    _meta: {
      flowzone: {
        schema: "flowzone/ui-v1",
        plugin: "callflow",
        action: "discover",
        view: "workflow",
        payload,
      },
    },
  };
  return `<script>
(() => {
  "use strict";
  const payload = ${scriptData(payload)};
  const initialResult = ${scriptData(initialResult)};
  const state = {
    toolCalls: [],
    messages: [],
    displayModes: [],
    startedAt: performance.now(),
    usefulPaintMilliseconds: null
  };
  window.__callflowHarness = state;
  const paintObserver = new MutationObserver(() => {
    if (!document.querySelector("h1")) return;
    paintObserver.disconnect();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      state.usefulPaintMilliseconds = performance.now() - state.startedAt;
    }));
  });
  paintObserver.observe(document.documentElement, { childList: true, subtree: true });
  const respond = (id, result) => window.postMessage({ jsonrpc: "2.0", id, result }, "*");
  const notify = (method, params) => window.postMessage({ jsonrpc: "2.0", method, params }, "*");
  window.addEventListener("message", (event) => {
    const request = event.data;
    if (event.source !== window || !request || request.jsonrpc !== "2.0" || typeof request.method !== "string") return;
    if (request.id === undefined) return;
    event.stopImmediatePropagation();
    let result = {};
    if (request.method === "ui/initialize") {
      result = {
        protocolVersion: "2026-01-26",
        hostInfo: { name: "callflow-browser-harness", version: "0.1.0" },
        hostCapabilities: { serverTools: {}, message: { text: {} } },
        hostContext: {
          theme: "light",
          displayMode: "fullscreen",
          availableDisplayModes: ["inline", "fullscreen"],
          platform: "desktop",
          deviceCapabilities: { touch: false, hover: true },
          safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
          locale: "en-US",
          timeZone: "America/Los_Angeles"
        }
      };
      respond(request.id, result);
      setTimeout(() => notify("ui/notifications/tool-result", initialResult), 0);
      return;
    }
    if (request.method === "tools/call") {
      state.toolCalls.push(request.params);
      const name = request.params?.name;
      if (name === "callflow_get_source") {
        const source = {
          schema: "callflow/source-v1",
          evidenceId: "e1",
          path: "src/workflow.ts",
          startLine: 10,
          endLine: 14,
          content: "export async function processClaim(record) {\\n  await writeProjection(record);\\n}",
          truncated: false,
          remainingByteBudget: 65444
        };
        result = {
          content: [],
          structuredContent: {
            schema: source.schema,
            evidenceId: source.evidenceId,
            path: source.path,
            startLine: source.startLine,
            endLine: source.endLine,
            truncated: source.truncated,
            remainingByteBudget: source.remainingByteBudget
          },
          _meta: { callflowSource: source }
        };
      } else if (name === "callflow_search") {
        result = { content: [], structuredContent: { nodeIds: ["worker"] } };
      } else if (name === "callflow_find_path") {
        result = { content: [], structuredContent: { nodeIds: ["worker", "transaction", "index"] } };
      } else if (name === "callflow_expand") {
        result = {
          content: [],
          structuredContent: { nodeIds: ["worker", "transaction", "retry"] },
          _meta: { callflowGraph: payload }
        };
      } else if (name === "callflow_relayout") {
        const requested = Array.isArray(request.params?.arguments?.visibleNodeIds)
          ? request.params.arguments.visibleNodeIds
          : [];
        const fixed = {
          "stage-receive": { x: 44, y: 38 },
          "stage-process": { x: 414, y: 38 },
          "stage-store": { x: 784, y: 38 }
        };
        result = {
          content: [],
          structuredContent: {
            schema: "callflow/layout-v1",
            graphRevision: "callflow-e2e-graph",
            engine: "elk",
            positions: requested.map((nodeId, index) => ({
              nodeId,
              x: fixed[nodeId]?.x ?? 70 + index * 15,
              y: fixed[nodeId]?.y ?? 90 + index * 22
            }))
          },
          _meta: { callflowGraph: payload }
        };
      } else if (name === "callflow_describe_visible") {
        result = { content: [], structuredContent: { description: "Explain the visible CallFlow fixture." } };
      } else {
        result = { content: [], _meta: { callflowGraph: payload } };
      }
    } else if (request.method === "ui/message") {
      state.messages.push(request.params);
      document.documentElement.dataset.callflowMessageCount = String(state.messages.length);
    } else if (request.method === "ui/request-display-mode") {
      state.displayModes.push(request.params.mode);
      result = { mode: request.params.mode };
    }
    document.documentElement.dataset.callflowToolCallCount = String(state.toolCalls.length);
    respond(request.id, result);
  });
})();
</script>`;
}

export async function createCallFlowBrowserHarnessPage(
  repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
): Promise<string> {
  const [template, script, stylesheet] = await Promise.all([
    readFile(resolve(repositoryRoot, "web/callflow.html"), "utf8"),
    readFile(resolve(repositoryRoot, "web/dist/callflow.js"), "utf8"),
    readFile(resolve(repositoryRoot, "web/dist/callflow.css"), "utf8"),
  ]);
  return template.replace(
    "<!-- CALLFLOW_APP -->",
    () => `<style>${stylesheet}</style>${hostScript()}<script>${script}</script>`,
  );
}

export async function createCallFlowLargeBrowserHarnessPage(
  repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
): Promise<string> {
  const extraNodes = Array.from({ length: 241 }, (_, index) => ({
    id: `large-node-${String(index).padStart(3, "0")}`,
    kind: "function" as const,
    label: `Large workflow step ${String(index + 1)}`,
    level: "L1" as const,
    stageId: "stage-receive",
    evidenceIds: ["e1"],
  }));
  const extraEdges = Array.from({ length: 594 }, (_, index) => ({
    id: `large-edge-${String(index).padStart(3, "0")}`,
    source: "route",
    target: "validate",
    kind: "direct-call" as const,
    assertion: "static-possible" as const,
    evidenceIds: ["e1"],
  }));
  const payload = {
    ...callFlowHarnessPayload,
    snapshot: {
      ...callFlowHarnessPayload.snapshot,
      nodes: [...callFlowHarnessPayload.snapshot.nodes, ...extraNodes],
      edges: [...callFlowHarnessPayload.snapshot.edges, ...extraEdges],
    },
  };
  const [template, script, stylesheet] = await Promise.all([
    readFile(resolve(repositoryRoot, "web/callflow.html"), "utf8"),
    readFile(resolve(repositoryRoot, "web/dist/callflow.js"), "utf8"),
    readFile(resolve(repositoryRoot, "web/dist/callflow.css"), "utf8"),
  ]);
  return template.replace(
    "<!-- CALLFLOW_APP -->",
    () => `<style>${stylesheet}</style>${hostScript(payload)}<script>${script}</script>`,
  );
}

export async function createCallFlowStandaloneHarnessPage(
  repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
): Promise<string> {
  const [template, script, stylesheet] = await Promise.all([
    readFile(resolve(repositoryRoot, "web/callflow.html"), "utf8"),
    readFile(resolve(repositoryRoot, "web/dist/callflow.js"), "utf8"),
    readFile(resolve(repositoryRoot, "web/dist/callflow.css"), "utf8"),
  ]);
  const standalonePayload = {
    ...callFlowHarnessPayload,
    capability: { ...callFlowHarnessPayload.capability, sourceByteBudget: 0 },
  };
  const withBootstrap = template.replace(
    "<!-- CALLFLOW_APP -->",
    () =>
      `<script>
window.__callflowStandaloneMessages = [];
window.addEventListener("message", (event) => {
  if (event.source === window && event.data?.jsonrpc === "2.0") {
    window.__callflowStandaloneMessages.push(event.data.method ?? "response");
  }
});
</script><script id="callflow-bootstrap" type="application/json">${scriptData(standalonePayload)}</script><!-- CALLFLOW_APP -->`,
  );
  return withBootstrap.replace(
    "<!-- CALLFLOW_APP -->",
    () => `<style>${stylesheet}</style><script>${script}</script>`,
  );
}

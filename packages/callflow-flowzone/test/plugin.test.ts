import { describe, expect, test } from "bun:test";

import {
  CallFlowUiPayloadSchema,
  GraphDiffSchema,
  GraphSnapshotSchema,
  WorkflowManifestSchema,
  type GraphSnapshot,
  type WorkflowManifest,
} from "@callflow/contracts";
import { CallFlowError, CallFlowService } from "@callflow/node";
import {
  FlowZoneExecutionError,
  createFlowZoneRegistry,
  type FlowZoneAction,
  type FlowZoneExecutionContext,
} from "@flowzone/mcp-server";

import {
  CALLFLOW_TEMPLATE_URI,
  LEGACY_CALLFLOW_TEMPLATE_URIS,
  createCallFlowPlugin,
  describeVisibleGraph,
  layoutSnapshotForVisible,
  type CallFlowPluginService,
} from "../src/plugin.js";
import { CallFlowSessionStore } from "../src/sessions.js";
import { FlowZoneExecutionPolicy } from "../../mcp-server/src/execution-policy.js";

function fixtureManifest(): WorkflowManifest {
  return WorkflowManifestSchema.parse({
    schemaVersion: "callflow/workflow-manifest-v1",
    id: "fixture-manifest",
    name: "Fixture workflow",
    repository: { identity: "local:/Users/private/repository" },
    anchors: [
      {
        id: "entry",
        label: "entry",
        role: "entry",
        nodeKind: "function",
        selector: { type: "symbol", value: "entry" },
        stageId: "stage-node",
      },
    ],
    stages: [{ id: "stage-node", label: "Ingest stage", order: 0 }],
    exclusions: [],
    acceptedSemanticLinks: [],
    presentation: { direction: "RIGHT", defaultOverlay: "none" },
  });
}

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

function fixtureService(
  manifest = fixtureManifest(),
  snapshot = fixtureSnapshot(),
): CallFlowPluginService {
  const service = new CallFlowService();
  return {
    discover: () => Promise.resolve({ manifest, snapshot }),
    query: service.query.bind(service),
    loadManifest: () => Promise.resolve(manifest),
    diff: service.diff.bind(service),
    export: service.export.bind(service),
  };
}

function context(action: string): FlowZoneExecutionContext {
  return {
    plugin: "callflow",
    action,
    requestId: `request-${action}`,
    signal: new AbortController().signal,
    reportProgress: () => Promise.resolve(),
  };
}

function action(pluginAction: readonly FlowZoneAction[], id: string): FlowZoneAction {
  const found = pluginAction.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing CallFlow action ${id}`);
  if (found.executor.kind !== "module") throw new Error(`CallFlow action ${id} is not a module`);
  return found;
}

async function execute(actionValue: FlowZoneAction, input: unknown) {
  if (actionValue.executor.kind !== "module") throw new Error("Expected module action");
  return await actionValue.executor.execute(input, context(actionValue.id));
}

describe("CallFlow FlowZone plugin", () => {
  test("registers only bounded router actions plus private app helpers", () => {
    const plugin = createCallFlowPlugin({ service: fixtureService() });
    const registry = createFlowZoneRegistry([plugin]);

    expect(plugin.id).toBe("callflow");
    expect(plugin.actions.map((candidate) => candidate.id)).toEqual([
      "discover",
      "query",
      "validate",
      "diff",
      "export",
    ]);
    expect(plugin.actions.every((candidate) => candidate.presentation === undefined)).toBe(true);
    expect(plugin.actions.find((candidate) => candidate.id === "discover")?.ui).toMatchObject({
      view: "workflow",
    });
    expect(plugin.actions.find((candidate) => candidate.id === "discover")?.ui).not.toHaveProperty(
      "legacyMetaKey",
    );
    expect(plugin.actions.find((candidate) => candidate.id === "export")?.ui).toBeUndefined();
    expect(registry.routerActions).toHaveLength(5);
    expect(registry.presentations).toHaveLength(0);
    expect(plugin.appTools?.map((tool) => tool.name)).toEqual([
      "callflow_expand",
      "callflow_get_source",
      "callflow_search",
      "callflow_find_path",
      "callflow_relayout",
      "callflow_describe_visible",
    ]);
    expect(
      Object.fromEntries(
        (plugin.appTools ?? []).map((tool) => [tool.name, tool.annotations.idempotentHint]),
      ),
    ).toEqual({
      callflow_expand: true,
      callflow_get_source: false,
      callflow_search: true,
      callflow_find_path: true,
      callflow_relayout: true,
      callflow_describe_visible: true,
    });
    expect(CALLFLOW_TEMPLATE_URI).toBe("ui://flowzone/callflow/v2.html");
    expect(LEGACY_CALLFLOW_TEMPLATE_URIS).toContain("ui://flowzone/callflow/v1.html");
    expect(LEGACY_CALLFLOW_TEMPLATE_URIS).toContain("ui://callflow/workflow/v1.html");
  });

  test("preserves the node service's 30-node default while forwarding an explicit bound", async () => {
    const maximumNodes: (number | undefined)[] = [];
    const service = fixtureService();
    const plugin = createCallFlowPlugin({
      service: {
        ...service,
        discover(request) {
          maximumNodes.push(request.maximumNodes);
          return Promise.resolve({ manifest: fixtureManifest(), snapshot: fixtureSnapshot() });
        },
      },
    });

    await execute(action(plugin.actions, "discover"), {
      repositoryPath: "/Users/private/repository",
      entries: ["entry"],
    });
    await execute(action(plugin.actions, "discover"), {
      repositoryPath: "/Users/private/repository",
      entries: ["entry"],
      maximumNodes: 47,
    });

    expect(maximumNodes).toEqual([undefined, 47]);
  });

  test("preflights sanitized CLI exports without returning the export body", async () => {
    const sessions = new CallFlowSessionStore({
      createId: () => "fixture-session",
      createToken: () => "e".repeat(43),
    });
    const plugin = createCallFlowPlugin({ service: fixtureService(), sessions });
    const discovered = await execute(action(plugin.actions, "discover"), {
      repositoryPath: "/Users/private/repository",
      entries: ["entry"],
    });
    const discoveryPayload = CallFlowUiPayloadSchema.parse(discovered.uiPayload);
    const exportAction = action(plugin.actions, "export");
    const exported = await execute(exportAction, {
      sessionId: discoveryPayload.sessionId,
      graphRevision: discoveryPayload.snapshot.id,
      format: "graph-json",
    });

    expect(exported.result).toMatchObject({
      schema: "callflow/export-preflight-v1",
      graphRevision: "fixture-graph",
      format: "graph-json",
      delivery: "cli-only",
    });
    const publicResult = exported.result as Readonly<Record<string, unknown>>;
    expect(publicResult["contentDigest"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(exported.result).not.toHaveProperty("content");
    expect(JSON.stringify(exported.result)).not.toContain("entry-node");
    expect(exportAction.summarize?.(exported.result)).not.toContain("entry-node");

    expect(exported.uiPayload).toBeUndefined();
  });

  test("returns a bounded sanitized topology without duplicate identifier arrays", async () => {
    const sessions = new CallFlowSessionStore({
      createId: () => "fixture-session",
      createToken: () => "q".repeat(43),
    });
    const plugin = createCallFlowPlugin({ service: fixtureService(), sessions });
    const discovered = await execute(action(plugin.actions, "discover"), {
      repositoryPath: "/Users/private/repository",
      entries: ["entry"],
    });
    const payload = CallFlowUiPayloadSchema.parse(discovered.uiPayload);
    const queried = await execute(action(plugin.actions, "query"), {
      sessionId: payload.sessionId,
      graphRevision: payload.snapshot.id,
      query: {},
    });

    expect(queried.result).toMatchObject({
      schema: "callflow/query-result-v1",
      totalMatchedNodes: 3,
      totalMatchedEdges: 1,
      truncated: false,
      edges: [
        {
          id: "handoff-edge",
          source: "entry-node",
          target: "sink-node",
          kind: "async-handoff",
          assertion: "curated-workflow",
          evidenceStates: ["exact"],
        },
      ],
    });
    const publicResult = queried.result as Readonly<Record<string, unknown>>;
    expect(publicResult).not.toHaveProperty("nodeIds");
    expect(publicResult).not.toHaveProperty("edgeIds");
    expect(publicResult["nodes"]).toEqual([
      {
        id: "entry-node",
        kind: "function",
        level: "L1",
        label: "[redacted-sensitive-text]",
        stageId: "stage-node",
        evidenceStates: ["exact"],
      },
      {
        id: "sink-node",
        kind: "queue",
        level: "L1",
        label: "Publish result",
        evidenceStates: ["ambiguous"],
      },
      {
        id: "stage-node",
        kind: "stage",
        level: "L0",
        label: "Ingest stage",
        evidenceStates: ["exact"],
      },
    ]);
    expect(JSON.stringify(publicResult)).not.toContain("/Users/private");

    let invalidQuery: unknown;
    try {
      await execute(action(plugin.actions, "query"), {
        sessionId: payload.sessionId,
        graphRevision: payload.snapshot.id,
        query: { limit: 31 },
      });
    } catch (error: unknown) {
      invalidQuery = error;
    }
    expect(invalidQuery).toMatchObject({ code: "invalid_input" });
  });

  test("bounds and prioritizes public diff entries", async () => {
    const entries = ["current", "unverified", "changed", "broken"].flatMap((status) =>
      Array.from({ length: 20 }, (_, index) => ({
        entity: "node" as const,
        id: `${status}-${String(index).padStart(2, "0")}`,
        status: status as "current" | "unverified" | "changed" | "broken",
        reason: `${status} fixture`,
      })),
    );
    const diff = GraphDiffSchema.parse({
      schemaVersion: "callflow/graph-diff-v1",
      id: "fixture-diff",
      workflowManifestId: "fixture-manifest",
      baseGraphId: "fixture-graph",
      baseRepository: fixtureSnapshot().repository,
      entries,
      summary: { current: 20, changed: 20, broken: 20, unverified: 20 },
      warnings: [],
    });
    const baseService = fixtureService();
    const sessions = new CallFlowSessionStore({
      createId: () => "fixture-session",
      createToken: () => "d".repeat(43),
    });
    const plugin = createCallFlowPlugin({
      sessions,
      service: { ...baseService, diff: () => diff },
    });
    const discovered = await execute(action(plugin.actions, "discover"), {
      repositoryPath: "/Users/private/repository",
      entries: ["entry"],
    });
    const payload = CallFlowUiPayloadSchema.parse(discovered.uiPayload);
    const result = await execute(action(plugin.actions, "diff"), {
      baseSessionId: payload.sessionId,
      baseGraphRevision: payload.snapshot.id,
    });
    const publicResult = result.result as {
      readonly entries: readonly { readonly id: string; readonly status: string }[];
      readonly truncated: boolean;
    };

    expect(publicResult.entries).toHaveLength(64);
    expect(publicResult.entries.slice(0, 20).every((entry) => entry.status === "broken")).toBe(
      true,
    );
    expect(publicResult.entries.slice(20, 40).every((entry) => entry.status === "changed")).toBe(
      true,
    );
    expect(publicResult.entries.slice(40, 60).every((entry) => entry.status === "unverified")).toBe(
      true,
    );
    expect(publicResult.entries.slice(60).every((entry) => entry.status === "current")).toBe(true);
    expect(publicResult.truncated).toBe(true);
  });

  test("discovers into a private UI session while returning only a bounded public summary", async () => {
    const sessions = new CallFlowSessionStore({
      createId: () => "fixture-session",
      createToken: () => "a".repeat(43),
    });
    const plugin = createCallFlowPlugin({ service: fixtureService(), sessions });
    const discovered = await execute(action(plugin.actions, "discover"), {
      repositoryPath: "/Users/private/repository",
      entries: ["entry"],
    });
    const payload = CallFlowUiPayloadSchema.parse(discovered.uiPayload);

    expect(discovered.result).toMatchObject({
      schema: "callflow/snapshot-summary-v1",
      sessionId: "fixture-session",
      graphRevision: "fixture-graph",
      nodeCount: 3,
      edgeCount: 1,
    });
    expect(discovered.result).not.toHaveProperty("nodes");
    expect(discovered.result).not.toHaveProperty("evidence");
    expect(JSON.stringify(discovered.result)).not.toContain("Run /Users/private");
    expect(payload.snapshot.nodes).toHaveLength(3);
    expect(payload.capability.token).toHaveLength(43);
    expect(sessions.size).toBe(1);
  });

  test("does not retry session-creating discovery after a retryable failure", async () => {
    let attempts = 0;
    const sessions = new CallFlowSessionStore({
      createId: () => "fixture-session",
      createToken: () => {
        throw new CallFlowError("adapter_failed", "Transient token fixture failure.", true);
      },
    });
    const service = fixtureService();
    const plugin = createCallFlowPlugin({
      sessions,
      service: {
        ...service,
        discover(request) {
          attempts += 1;
          return service.discover(request);
        },
      },
    });
    const registry = createFlowZoneRegistry([plugin]);
    const registered = registry.find("callflow", "discover");
    if (!registered) throw new Error("Missing registered CallFlow discovery action");

    let failure: unknown;
    try {
      await new FlowZoneExecutionPolicy().execute(
        registered,
        { repositoryPath: "/Users/private/repository", entries: ["entry"] },
        context("discover"),
      );
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "unavailable", retryable: true });
    expect(attempts).toBe(1);
    expect(sessions.size).toBe(1);
  });

  test("keeps helpers capability-bound without rotating tokens or resending graphs", async () => {
    const sessions = new CallFlowSessionStore({
      createId: () => "fixture-session",
      createToken: () => "b".repeat(43),
    });
    const plugin = createCallFlowPlugin({ service: fixtureService(), sessions });
    const discovered = await execute(action(plugin.actions, "discover"), {
      repositoryPath: "/Users/private/repository",
      entries: ["entry"],
    });
    const payload = CallFlowUiPayloadSchema.parse(discovered.uiPayload);
    const search = plugin.appTools?.find((tool) => tool.name === "callflow_search");
    const expand = plugin.appTools?.find((tool) => tool.name === "callflow_expand");
    const relayout = plugin.appTools?.find((tool) => tool.name === "callflow_relayout");
    if (!search) throw new Error("Missing CallFlow search helper");
    if (!expand) throw new Error("Missing CallFlow expand helper");
    if (!relayout) throw new Error("Missing CallFlow relayout helper");

    const validResult = await search.handler(
      {
        sessionId: payload.sessionId,
        graphRevision: payload.snapshot.id,
        capabilityToken: payload.capability.token,
        query: "Publish",
      },
      { signal: new AbortController().signal, requestId: "search" },
    );
    expect(validResult.structuredContent).toEqual({
      nodeIds: ["sink-node"],
      truncated: false,
    });

    const expanded = await expand.handler(
      {
        sessionId: payload.sessionId,
        graphRevision: payload.snapshot.id,
        capabilityToken: payload.capability.token,
        nodeId: "entry-node",
        direction: "both",
      },
      { signal: new AbortController().signal, requestId: "expand" },
    );
    expect(expanded.structuredContent).toMatchObject({
      nodeIds: ["entry-node", "sink-node"],
      edgeIds: ["handoff-edge"],
    });
    expect(expanded._meta).toBeUndefined();

    const laidOut = await relayout.handler(
      {
        sessionId: payload.sessionId,
        graphRevision: payload.snapshot.id,
        capabilityToken: payload.capability.token,
        visibleNodeIds: ["stage-node", "entry-node", "sink-node"],
      },
      { signal: new AbortController().signal, requestId: "relayout" },
    );
    expect(laidOut.structuredContent).toMatchObject({
      schema: "callflow/layout-v1",
      graphRevision: "fixture-graph",
    });
    expect(laidOut._meta).toBeUndefined();

    const afterReadOnlyHelpers = await search.handler(
      {
        sessionId: payload.sessionId,
        graphRevision: payload.snapshot.id,
        capabilityToken: payload.capability.token,
        query: "Publish",
      },
      { signal: new AbortController().signal, requestId: "search-after-helpers" },
    );
    expect(afterReadOnlyHelpers.structuredContent).toEqual(validResult.structuredContent);

    let failure: unknown;
    try {
      await search.handler(
        {
          sessionId: payload.sessionId,
          graphRevision: payload.snapshot.id,
          capabilityToken: "invalid".repeat(8),
          query: "Publish",
        },
        { signal: new AbortController().signal, requestId: "search-invalid" },
      );
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(FlowZoneExecutionError);
    expect(failure).toMatchObject({ code: "unavailable" });
  });

  test("does not leak unexpected service failures through the FlowZone router", async () => {
    const service = fixtureService();
    const plugin = createCallFlowPlugin({
      service: {
        ...service,
        discover: () => {
          throw new Error("secret /Users/private/repository detail");
        },
      },
    });

    let failure: unknown;
    try {
      await execute(action(plugin.actions, "discover"), {
        repositoryPath: "/Users/private/repository",
        entries: ["entry"],
      });
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(FlowZoneExecutionError);
    expect(failure).toMatchObject({
      code: "internal_error",
      message: "CallFlow could not complete the request.",
    });
  });

  test("maps known CallFlow failures into bounded FlowZone categories", async () => {
    const service = fixtureService();
    const plugin = createCallFlowPlugin({
      service: {
        ...service,
        discover: () => {
          throw new CallFlowError("adapter_stale", "Graft is stale at /Users/private/repository.");
        },
      },
    });

    let failure: unknown;
    try {
      await execute(action(plugin.actions, "discover"), {
        repositoryPath: "/Users/private/repository",
        entries: ["entry"],
      });
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(FlowZoneExecutionError);
    expect(failure).toMatchObject({ code: "unavailable" });
    expect(failure instanceof Error ? failure.message : "").not.toContain("/Users/private");
  });
});

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

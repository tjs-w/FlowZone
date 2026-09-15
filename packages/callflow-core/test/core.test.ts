import { describe, expect, test } from "bun:test";
import { marked } from "marked";

import type { GraphBuildInput, GraphSnapshot, WorkflowManifest } from "@callflow/contracts";

import {
  buildGraphFromManifest,
  canonicalStringify,
  computeVisibility,
  diffGraphSnapshots,
  digestOf,
  exportMermaid,
  exportMarkdown,
  exportHtml,
  exportSvg,
  findPath,
  queryGraph,
  sanitizeExportBundle,
  sanitizeGraphSnapshot,
  sanitizePublicText,
  sha256Hex,
  stableId,
  traverseGraph,
} from "../src/index.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected test fixture value.");
  return value;
}

function manifest(): WorkflowManifest {
  return {
    schemaVersion: "callflow/workflow-manifest-v1",
    id: "write-flow",
    name: "Write flow",
    repository: { identity: "local:/Users/example/project" },
    anchors: [
      {
        id: "entry",
        label: "Handle request",
        role: "entry",
        nodeKind: "function",
        selector: { type: "symbol", value: "handle" },
        stageId: "request",
      },
      {
        id: "sink",
        label: "Records table",
        role: "table",
        nodeKind: "table",
        selector: { type: "symbol", value: "records" },
        stageId: "persistence",
      },
    ],
    stages: [
      { id: "request", label: "Request", order: 0 },
      { id: "persistence", label: "Persistence", order: 1 },
    ],
    exclusions: [],
    acceptedSemanticLinks: [
      {
        sourceAnchorId: "entry",
        targetAnchorId: "sink",
        kind: "semantic-link",
        label: "eventually persists",
        rationale: "The reviewed workflow connects the asynchronous path to storage.",
      },
    ],
    acceptedRelationships: [
      {
        sourceAnchorId: "entry",
        targetAnchorId: "sink",
        kind: "async-handoff",
        label: "wake worker",
        rationale: "The transaction signals an asynchronous worker after commit.",
      },
    ],
    discoveryBounds: { depth: 3, maximumNodes: 75 },
    presentation: { direction: "RIGHT", defaultOverlay: "none" },
  };
}

function buildInput(): GraphBuildInput {
  const source = (path: string, line: number) => ({
    type: "source-span" as const,
    path,
    start: { line, column: 1 },
    end: { line: line + 1, column: 1 },
  });
  const evidence = (key: string, path: string, line: number) => ({
    key,
    kind: "graft-exact" as const,
    state: "exact" as const,
    revision: "abc123",
    source: source(path, line),
    contentDigest: digestOf({ path, line }),
    producer: { name: "graft", version: "0.18.0" },
  });
  return {
    repository: {
      identity: "local:/Users/example/project",
      commit: "abc123",
      dirtyDigest: digestOf("clean"),
    },
    adapter: { name: "graft", version: "0.18.0", indexRevision: "index-1" },
    evidence: [
      evidence("e-handler", "src/handler.ts", 10),
      evidence("e-validate", "src/handler.ts", 20),
      evidence("e-enqueue", "src/outbox.ts", 30),
      evidence("e-worker", "src/worker.ts", 40),
      evidence("e-store", "src/store.ts", 50),
      {
        ...evidence("e-curated", "src/outbox.ts", 32),
        kind: "human-curated" as const,
        producer: { name: "callflow-manifest", version: "1" },
      },
    ],
    nodes: [
      {
        key: "handler",
        anchorId: "entry",
        kind: "function",
        label: "handle",
        level: "L1",
        stageId: "request",
        qualifiedName: "handler.handle",
        signature: "handle(request)",
        evidenceKeys: ["e-handler"],
      },
      {
        key: "validate",
        kind: "condition",
        label: "validate",
        level: "L2",
        parentKey: "handler",
        stageId: "request",
        qualifiedName: "handler.validate",
        evidenceKeys: ["e-validate"],
      },
      {
        key: "enqueue",
        kind: "queue",
        label: "enqueue",
        level: "L1",
        stageId: "persistence",
        qualifiedName: "outbox.enqueue",
        evidenceKeys: ["e-enqueue"],
      },
      {
        key: "worker",
        kind: "function",
        label: "worker",
        level: "L1",
        stageId: "persistence",
        qualifiedName: "worker.run",
        evidenceKeys: ["e-worker"],
      },
      {
        key: "store",
        anchorId: "sink",
        kind: "table",
        label: "records",
        level: "L1",
        stageId: "persistence",
        qualifiedName: "database.records",
        evidenceKeys: ["e-store"],
      },
    ],
    edges: [
      {
        key: "validate-call",
        sourceKey: "handler",
        targetKey: "validate",
        kind: "conditional-call",
        assertion: "static-possible",
        evidenceKeys: ["e-handler", "e-validate"],
      },
      {
        key: "validation-retry",
        sourceKey: "validate",
        targetKey: "handler",
        kind: "retry",
        assertion: "curated-workflow",
        evidenceKeys: ["e-curated"],
      },
      {
        key: "enqueue-call",
        sourceKey: "handler",
        targetKey: "enqueue",
        kind: "direct-call",
        assertion: "static-possible",
        evidenceKeys: ["e-handler", "e-enqueue"],
      },
      {
        key: "async-worker",
        sourceKey: "enqueue",
        targetKey: "worker",
        kind: "async-handoff",
        assertion: "curated-workflow",
        evidenceKeys: ["e-curated"],
      },
      {
        key: "store-write",
        sourceKey: "worker",
        targetKey: "store",
        kind: "state-write",
        assertion: "static-possible",
        evidenceKeys: ["e-worker", "e-store"],
      },
    ],
    warnings: [],
    extraction: {
      status: "succeeded",
      items: ["e-handler", "e-validate", "e-enqueue", "e-worker", "e-store", "e-curated"],
    },
    runtimeEvidence: {
      status: "unavailable",
      reason: "Runtime evidence is unavailable in CallFlow v1.",
    },
  };
}

describe("stable CallFlow identities", () => {
  test("uses vetted SHA-256 and canonical object ordering", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(canonicalStringify({ beta: 2, alpha: 1 })).toBe('{"alpha":1,"beta":2}');
    expect(stableId("node", { beta: 2, alpha: 1 })).toBe(stableId("node", { alpha: 1, beta: 2 }));
    expect(() => canonicalStringify(new Date(0))).toThrow("plain objects");
  });

  test("builds byte-stable graph order independent of adapter input order", () => {
    const first = buildGraphFromManifest(manifest(), buildInput());
    const reversed = buildInput();
    reversed.evidence.reverse();
    reversed.nodes.reverse();
    reversed.edges.reverse();
    const second = buildGraphFromManifest(manifest(), reversed);
    expect(second).toEqual(first);
    const humanEvidenceIds = new Set(
      first.evidence
        .filter((evidence) => evidence.kind === "human-curated")
        .map((evidence) => evidence.id),
    );
    expect(
      first.edges.some(
        (edge) =>
          edge.kind === "async-handoff" &&
          edge.assertion === "curated-workflow" &&
          edge.evidenceIds.some((id) => humanEvidenceIds.has(id)),
      ),
    ).toBe(true);

    const relabeled = buildInput();
    relabeled.nodes[0] = { ...required(relabeled.nodes[0]), label: "handle request" };
    const third = buildGraphFromManifest(manifest(), relabeled);
    const firstHandler = first.nodes.find((node) => node.qualifiedName === "handler.handle");
    const thirdHandler = third.nodes.find((node) => node.qualifiedName === "handler.handle");
    expect(thirdHandler?.id).toBe(firstHandler?.id);
    expect(third.id).not.toBe(first.id);
  });

  test("preserves versioned presentation and human stage order as deterministic layout input", () => {
    const workflow = manifest();
    workflow.stages.reverse();
    workflow.presentation.defaultOverlay = "retry";
    const graph = buildGraphFromManifest(workflow, buildInput());
    const stageNodes = graph.nodes.filter((node) => node.kind === "stage");

    expect(graph.presentation).toEqual({
      schemaVersion: "callflow/graph-presentation-v1",
      direction: "RIGHT",
      defaultOverlay: "retry",
    });
    expect(graph.layoutHints).toEqual({
      schemaVersion: "callflow/graph-layout-hints-v1",
      stageOrder: stageNodes.map((node) => node.id),
    });
    expect(stageNodes.map((node) => node.label)).toEqual(["Request", "Persistence"]);

    const stageRank = new Map(
      graph.layoutHints.stageOrder.map((stageId, index) => [stageId, index] as const),
    );
    const observedRanks = graph.nodes.map((node) =>
      required(stageRank.get(node.kind === "stage" ? node.id : required(node.stageId))),
    );
    expect(observedRanks).toEqual([...observedRanks].sort((left, right) => left - right));

    const sameWorkflow = manifest();
    sameWorkflow.presentation.defaultOverlay = "retry";
    expect(buildGraphFromManifest(sameWorkflow, buildInput())).toEqual(graph);
  });

  test("keeps graph element identities stable while revision evidence changes", () => {
    const first = buildGraphFromManifest(manifest(), buildInput());
    const originalInput = buildInput();
    const refreshedInput: GraphBuildInput = {
      ...originalInput,
      repository: {
        ...originalInput.repository,
        commit: "def456",
        dirtyDigest: digestOf("updated-tree"),
      },
      adapter: { ...originalInput.adapter, indexRevision: "index-2" },
      evidence: originalInput.evidence.map((record) => ({
        ...record,
        revision: "def456",
        contentDigest: digestOf({ key: record.key, revision: "def456" }),
      })),
    };

    const refreshed = buildGraphFromManifest(manifest(), refreshedInput);
    expect(refreshed.nodes.map((node) => node.id)).toEqual(first.nodes.map((node) => node.id));
    expect(refreshed.edges.map((edge) => edge.id)).toEqual(first.edges.map((edge) => edge.id));
    expect(refreshed.evidence.map((record) => record.id)).toEqual(
      first.evidence.map((record) => record.id),
    );
    expect(refreshed.id).not.toBe(first.id);

    const diff = diffGraphSnapshots(first, refreshed);
    expect(diff.summary.broken).toBe(0);
    expect(diff.entries.some((entry) => entry.reason === "Referenced evidence changed.")).toBe(
      true,
    );
  });

  test("rejects AI evidence on static calls", () => {
    const input = buildInput();
    input.evidence[0] = { ...required(input.evidence[0]), kind: "ai-inferred" };
    expect(() => buildGraphFromManifest(manifest(), input)).toThrow(
      "AI-inferred evidence cannot support a static or operational edge",
    );
  });
});

describe("graph queries and visibility", () => {
  test("handles cycles while finding deterministic paths", () => {
    const graph = buildGraphFromManifest(manifest(), buildInput());
    const handler = required(graph.nodes.find((node) => node.qualifiedName === "handler.handle"));
    const validate = required(
      graph.nodes.find((node) => node.qualifiedName === "handler.validate"),
    );
    const store = required(graph.nodes.find((node) => node.qualifiedName === "database.records"));
    const traversal = traverseGraph(graph, [handler.id], { direction: "out", maxDepth: 8 });
    expect(new Set(traversal.nodeIds).size).toBe(traversal.nodeIds.length);
    expect(traversal.nodeIds).toContain(validate.id);
    expect(traversal.nodeIds).toContain(store.id);
    expect(findPath(graph, handler.id, store.id)?.nodeIds.at(-1)).toBe(store.id);
    expect(findPath(graph, store.id, handler.id, { direction: "out" })).toBeNull();
  });

  test("uses literal text search and accounts for filters, collapse, pins, and limits", () => {
    const graph = buildGraphFromManifest(manifest(), buildInput());
    expect(queryGraph(graph, { text: "handle[" }).nodes).toHaveLength(0);
    const handler = required(graph.nodes.find((node) => node.qualifiedName === "handler.handle"));
    const validate = required(
      graph.nodes.find((node) => node.qualifiedName === "handler.validate"),
    );
    const collapsed = computeVisibility(graph, { collapsedNodeIds: [handler.id] });
    expect(collapsed.hidden.nodeReasons.collapsed).toBe(1);
    expect(collapsed.visibleNodeIds.has(validate.id)).toBe(false);

    const pinned = computeVisibility(graph, {
      collapsedNodeIds: [handler.id],
      pinnedNodeIds: [validate.id],
      maxNodes: 3,
    });
    expect(pinned.visibleNodeIds.has(validate.id)).toBe(true);
    expect(pinned.hidden.nodeReasons["node-limit"]).toBeGreaterThan(0);
    expect(pinned.hidden.nodeCount).toBe(graph.nodes.length - pinned.nodes.length);
  });
});

describe("graph diffs and exports", () => {
  test("reports current, changed, broken, and unverified states distinctly", () => {
    const base = buildGraphFromManifest(manifest(), buildInput());
    const changedInput = buildInput();
    const workerIndex = changedInput.nodes.findIndex((node) => node.key === "worker");
    changedInput.nodes[workerIndex] = {
      ...required(changedInput.nodes[workerIndex]),
      label: "outbox worker",
    };
    changedInput.edges = changedInput.edges.filter((edge) => edge.key !== "validation-retry");
    const changed = buildGraphFromManifest(manifest(), changedInput);
    const diff = diffGraphSnapshots(base, changed);
    expect(diff.entries.some((entry) => entry.status === "current")).toBe(true);
    expect(diff.entries.some((entry) => entry.status === "changed")).toBe(true);
    expect(diff.entries.some((entry) => entry.status === "broken")).toBe(true);

    const unverified: GraphSnapshot = {
      ...base,
      id: "unverified-target",
      evidence: base.evidence.map((evidence, index) =>
        index === 0 ? { ...evidence, state: "stale" } : evidence,
      ),
    };
    expect(diffGraphSnapshots(base, unverified).summary.unverified).toBeGreaterThan(0);
    expect(
      diffGraphSnapshots(base, undefined, { unavailableReason: "Graft failed." }).summary,
    ).toMatchObject({ unverified: base.nodes.length + base.edges.length + base.evidence.length });

    const failedExtraction: GraphSnapshot = {
      ...base,
      id: "failed-extraction-target",
      extraction: { status: "failed", code: "graft-query-failed", retryable: true },
    };
    const failedDiff = diffGraphSnapshots(base, failedExtraction);
    expect(failedDiff.summary.unverified).toBe(
      base.nodes.length + base.edges.length + base.evidence.length,
    );
    expect(failedDiff.warnings.map((warning) => warning.code)).toContain(
      "target_extraction_unavailable",
    );
  });

  test("preserves renames through unique shared evidence and remaps incident edges", () => {
    const base = buildGraphFromManifest(manifest(), buildInput());
    const renamedInput = buildInput();
    const workerIndex = renamedInput.nodes.findIndex((node) => node.key === "worker");
    renamedInput.nodes[workerIndex] = {
      ...required(renamedInput.nodes[workerIndex]),
      label: "renamed worker",
      qualifiedName: "worker.renamedRun",
    };
    const target = buildGraphFromManifest(manifest(), renamedInput);
    const beforeWorker = required(base.nodes.find((node) => node.qualifiedName === "worker.run"));
    const afterWorker = required(
      target.nodes.find((node) => node.qualifiedName === "worker.renamedRun"),
    );
    const diff = diffGraphSnapshots(base, target);

    expect(diff.summary.broken).toBe(0);
    expect(
      diff.entries.find(
        (entry) => entry.beforeId === beforeWorker.id && entry.afterId === afterWorker.id,
      ),
    ).toMatchObject({
      entity: "node",
      id: afterWorker.id,
      status: "changed",
      reason: "Identity changed; correlated by unique shared evidence.",
    });

    const remappedEdges = diff.entries.filter(
      (entry) => entry.entity === "edge" && entry.beforeId !== undefined,
    );
    expect(remappedEdges).toHaveLength(2);
    expect(remappedEdges.every((entry) => entry.status === "changed")).toBe(true);
    expect(diff.entries.some((entry) => entry.reason === "Added in target graph.")).toBe(false);
  });

  test("does not guess rename correlations when shared evidence is ambiguous", () => {
    const baseInput = buildInput();
    baseInput.nodes.push(
      {
        key: "helper-a",
        kind: "function",
        label: "helper A",
        level: "L1",
        stageId: "request",
        qualifiedName: "helpers.a",
        evidenceKeys: ["e-handler"],
      },
      {
        key: "helper-b",
        kind: "function",
        label: "helper B",
        level: "L1",
        stageId: "request",
        qualifiedName: "helpers.b",
        evidenceKeys: ["e-handler"],
      },
    );
    const targetInput = buildInput();
    targetInput.nodes.push(
      {
        key: "helper-a",
        kind: "function",
        label: "helper A",
        level: "L1",
        stageId: "request",
        qualifiedName: "helpers.renamedA",
        evidenceKeys: ["e-handler"],
      },
      {
        key: "helper-b",
        kind: "function",
        label: "helper B",
        level: "L1",
        stageId: "request",
        qualifiedName: "helpers.renamedB",
        evidenceKeys: ["e-handler"],
      },
    );
    const diff = diffGraphSnapshots(
      buildGraphFromManifest(manifest(), baseInput),
      buildGraphFromManifest(manifest(), targetInput),
    );

    expect(diff.entries.filter((entry) => entry.beforeId !== undefined)).toHaveLength(0);
    expect(diff.entries.filter((entry) => entry.status === "broken")).toHaveLength(2);
    expect(diff.entries.filter((entry) => entry.reason === "Added in target graph.")).toHaveLength(
      2,
    );
  });

  test("sanitizes local paths and secret-like attributes from portable exports", () => {
    const graph = buildGraphFromManifest(manifest(), buildInput());
    const withSensitiveStrings: GraphSnapshot = {
      ...graph,
      nodes: graph.nodes.map((node, index) =>
        index === 0
          ? {
              ...node,
              summary: "Read /Users/example/project/private.ts",
              attributes: { access_token: "do-not-export", reviewed: true },
            }
          : node,
      ),
    };
    const bundle = sanitizeExportBundle(withSensitiveStrings);
    const serialized = JSON.stringify(bundle);
    expect(bundle.repository.identity).toMatch(/^repository:sha256:/);
    expect(serialized).not.toContain("dirtyDigest");
    expect(serialized).not.toContain("/Users/example");
    expect(serialized).not.toContain("do-not-export");
    expect(bundle.nodes[0]?.attributes).toEqual({ reviewed: true });

    const credentialBearing: GraphSnapshot = {
      ...graph,
      repository: {
        ...graph.repository,
        identity: "https://user:password@example.invalid/repository?token=value",
      },
    };
    expect(sanitizeExportBundle(credentialBearing).repository.identity).toMatch(
      /^repository:sha256:/,
    );

    const hostileText: GraphSnapshot = {
      ...graph,
      adapter: {
        ...graph.adapter,
        indexRevision: "index=/private/tmp/callflow-index",
      },
      nodes: graph.nodes.map((node, index) =>
        index === 0
          ? {
              ...node,
              summary:
                "config=/Users/example/private.ts https://user:password@example.invalid/repo?token=x Bearer abcdefghijklmnop",
            }
          : node,
      ),
    };
    const sanitizedGraph = sanitizeGraphSnapshot(hostileText);
    expect(sanitizedGraph.schemaVersion).toBe("callflow/graph-snapshot-v1");
    expect(JSON.stringify(sanitizedGraph)).not.toContain("/Users/example");
    expect(JSON.stringify(sanitizedGraph)).not.toContain("/private/tmp");
    expect(JSON.stringify(sanitizedGraph)).not.toContain("password");
    expect(JSON.stringify(sanitizedGraph)).not.toContain("abcdefghijklmnop");

    for (const value of [
      "path|/Users/alice/private/key.pem",
      "source>/private/tmp/key",
      "source#/home/alice/key",
      String.raw`source=\\server\private\key`,
      "password=hunter2",
      "api_key=top-secret",
      "ghp_abcdefghijklmnopqrstuvwxyz012345",
      "AKIAABCDEFGHIJKLMNOP",
      "-----BEGIN PRIVATE KEY-----",
      "see file:/Users/alice/secret.ts",
      "see <file:///Users/alice/secret.ts>",
      "source vscode://file/Users/alice/secret.ts",
      "source file:%2FUsers%2Falice%2Fsecret.ts",
      "path:/Users/alice/private.ts",
      "at:/Users/alice/private.ts",
      "//server/share/private.ts",
      "///private/tmp/key",
      String.raw`\Users\alice\private.ts`,
      String.raw`root=\Users\alice\private.ts`,
      String.raw`path:\Users\alice\private.ts`,
      String.raw`at:\Users\alice\private.ts`,
      String.raw`foo/\Users\alice\private.ts`,
    ]) {
      expect(sanitizePublicText(value)).toBe("[redacted-sensitive-text]");
    }

    const ordinary = sanitizePublicText("package/function handles retry");
    expect(ordinary).toBe("package/function handles retry");
    expect(sanitizePublicText("https://example.com/path/to/docs")).toBe(
      "https://example.com/path/to/docs",
    );
    expect(sanitizePublicText(String.raw`Use \n for a newline`)).toBe(
      String.raw`Use \n for a newline`,
    );
  });

  test("escapes graph labels in Mermaid output", () => {
    const graph = buildGraphFromManifest(manifest(), buildInput());
    const hostile: GraphSnapshot = {
      ...graph,
      nodes: graph.nodes.map((node, index) =>
        index === 0 ? { ...node, label: 'name"] X["injected' } : node,
      ),
    };
    const mermaid = exportMermaid(hostile);
    expect(mermaid).not.toContain('X["injected');
    expect(mermaid.split("\n").filter((line) => line.includes('["'))).toHaveLength(
      graph.nodes.length,
    );
    for (const node of graph.nodes) expect(mermaid).toContain(`id=${node.id} evidence=`);
    for (const edge of graph.edges) {
      expect(mermaid).toContain(`callflow-edge id=${edge.id}`);
      expect(mermaid).toContain(`assertion=${edge.assertion}`);
    }
    for (const evidence of graph.evidence) {
      expect(mermaid).toContain(`callflow-evidence id=${evidence.id}`);
    }
  });

  test("preserves stable mappings and assertions in every human-readable export", () => {
    const graph = buildGraphFromManifest(manifest(), buildInput());
    const markdown = exportMarkdown(graph);
    const svg = exportSvg(graph);
    const html = exportHtml(graph);

    expect(markdown).toContain(graph.presentation.schemaVersion);
    expect(markdown).toContain(graph.layoutHints.schemaVersion);
    for (const node of graph.nodes) {
      expect(markdown).toContain(node.id);
      expect(svg).toContain(`data-callflow-node-id="${node.id}"`);
      expect(html).toContain(`data-callflow-node-id="${node.id}"`);
    }
    for (const edge of graph.edges) {
      expect(markdown).toContain(edge.id);
      expect(markdown).toContain(edge.assertion);
      expect(svg).toContain(`data-callflow-edge-id="${edge.id}"`);
      expect(svg).toContain(`data-callflow-assertion="${edge.assertion}"`);
      expect(html).toContain(`data-callflow-edge-id="${edge.id}"`);
    }
    for (const evidence of graph.evidence) {
      expect(markdown).toContain(evidence.id);
      expect(svg).toContain(`&quot;id&quot;:&quot;${evidence.id}&quot;`);
      expect(html).toContain(`&quot;id&quot;:&quot;${evidence.id}&quot;`);
    }
  });

  test("keeps hostile labels and references inert in Markdown output", () => {
    const graph = buildGraphFromManifest(manifest(), buildInput());
    const hostile: GraphSnapshot = {
      ...graph,
      nodes: graph.nodes.map((node, index) =>
        index === 0
          ? {
              ...node,
              label:
                '<img src="https://attacker.invalid/pixel"> ![remote](https://attacker.invalid/image) | `break`',
            }
          : node,
      ),
      evidence: graph.evidence.map((record, index) =>
        index === 0
          ? {
              ...record,
              source: {
                type: "external-reference" as const,
                system: "hostile",
                reference: "https://attacker.invalid/evidence",
              },
            }
          : record,
      ),
    };
    const markdown = exportMarkdown(hostile);
    const svg = exportSvg(hostile);
    const html = exportHtml(hostile);
    const rendered = marked.parse(markdown) as string;
    expect(rendered).not.toContain("<img");
    expect(rendered).not.toContain('href="https://attacker.invalid');
    expect(rendered).toContain("&lt;img");
    expect(svg).not.toContain('<img src="https://attacker.invalid');
    expect(svg).toContain("&lt;img");
    expect(html).not.toContain('<img src="https://attacker.invalid');
    expect(html).toContain("&lt;img");
    expect(html).toContain("default-src 'none'");
  });
});

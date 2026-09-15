import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "bun:test";

import {
  GraphBuildInputSchema,
  GraphSnapshotSchema,
  WorkflowManifestSchema,
  type GraphBuildInput,
  type GraphSnapshot,
  type WorkflowManifest,
} from "@callflow/contracts";
import { buildGraphFromManifest, canonicalStringify, findPath } from "@callflow/core";
import { parseGraftReadResponse } from "@callflow/node";

import {
  genericGraphInput,
  linusOpenSearchGraphInput,
  typescriptAsyncOutboxGraphInput,
} from "../fixtures/callflow/graph-build-inputs.js";
import {
  PINNED_LINUS_COMMIT,
  PINNED_READ_COMMANDS,
  PINNED_SOURCE_FILES,
  capturePinnedLinusAcceptance,
  type AcceptanceCapture,
} from "../fixtures/callflow/linus-opensearch/provenance-harness.js";

const fixtureRoot = resolve(import.meta.dir, "../fixtures/callflow");

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(fixtureRoot, path), "utf8")) as unknown;
}

async function readManifest(path: string): Promise<WorkflowManifest> {
  return WorkflowManifestSchema.parse(await readJson(path));
}

async function buildFixture(directory: string, input: GraphBuildInput): Promise<GraphSnapshot> {
  const manifest = await readManifest(`${directory}/workflow.callflow.json`);
  return buildGraphFromManifest(manifest, GraphBuildInputSchema.parse(input));
}

function nodeByLabel(snapshot: GraphSnapshot, label: string) {
  const node = snapshot.nodes.find((candidate) => candidate.label === label);
  expect(node, `Missing fixture node ${label}`).toBeDefined();
  if (node === undefined) throw new Error(`Missing fixture node ${label}.`);
  return node;
}

function pathLabels(snapshot: GraphSnapshot, nodeIds: readonly string[]): string[] {
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  return nodeIds.map((id) => {
    const node = nodeById.get(id);
    if (node === undefined) throw new Error(`Path references missing node ${id}.`);
    return node.label;
  });
}

function expectCompleteEvidence(snapshot: GraphSnapshot): void {
  const evidenceIds = new Set(snapshot.evidence.map((record) => record.id));
  for (const node of snapshot.nodes) {
    expect(node.evidenceIds.length).toBeGreaterThan(0);
    expect(node.evidenceIds.every((id) => evidenceIds.has(id))).toBe(true);
  }
  for (const edge of snapshot.edges) {
    expect(edge.evidenceIds.length).toBeGreaterThan(0);
    expect(edge.evidenceIds.every((id) => evidenceIds.has(id))).toBe(true);
  }

  expect(snapshot.presentation.schemaVersion).toBe("callflow/graph-presentation-v1");
  expect(snapshot.presentation.direction).toBe("RIGHT");
  expect(["none", "data", "failure", "retry", "transaction", "change"]).toContain(
    snapshot.presentation.defaultOverlay,
  );
  expect(snapshot.layoutHints.schemaVersion).toBe("callflow/graph-layout-hints-v1");
  expect(snapshot.layoutHints.stageOrder).toEqual(
    snapshot.nodes.filter((node) => node.kind === "stage").map((node) => node.id),
  );
  expect(GraphSnapshotSchema.parse(snapshot)).toEqual(snapshot);
}

type LinusProvenance = AcceptanceCapture & {
  readonly schema: "callflow/linus-provenance-v1";
  readonly repositoryIdentity: string;
};

async function readLinusProvenance(): Promise<LinusProvenance> {
  return (await readJson("linus-opensearch/provenance.json")) as LinusProvenance;
}

test("checked Linus provenance pins clean read-only Graft evidence and real source digests", async () => {
  const provenance = await readLinusProvenance();
  const serialized = JSON.stringify(provenance);

  expect(provenance.schema).toBe("callflow/linus-provenance-v1");
  expect(provenance.repositoryIdentity).toBe("git:cd.splunkdev.com/linus/linus-findings-service");
  expect(provenance.commit).toBe(PINNED_LINUS_COMMIT);
  expect(provenance.graftVersion).toBe("0.18.0");
  expect(provenance.cleanBefore).toBe(true);
  expect(provenance.cleanAfter).toBe(true);
  expect(provenance.indexAfter).toEqual(provenance.indexBefore);
  expect(provenance.wiring).toEqual({
    path: "graft/.graph/wiring.json",
    bytes: 6_783_543,
    digest: "sha256:6112e64974d8503a601c1d971f620a86c20e1d04d3aa7bcdbcecffdb25e956e7",
  });
  expect(provenance.sources.map((source) => source.path)).toEqual([...PINNED_SOURCE_FILES]);
  expect(provenance.commands.map((command) => command.id)).toEqual(
    PINNED_READ_COMMANDS.map((command) => command.id),
  );
  expect(serialized).not.toContain("/private/");
  expect(serialized).not.toContain("/Users/");

  const sourceDigests = new Map(
    provenance.sources.map((source) => [source.path, source.digest] as const),
  );
  for (const evidence of linusOpenSearchGraphInput.evidence) {
    expect(evidence.source.type).toBe("source-span");
    if (evidence.source.type !== "source-span") continue;
    expect(evidence.source.path.startsWith("/")).toBe(false);
    const sourceDigest = sourceDigests.get(evidence.source.path);
    if (sourceDigest === undefined) {
      throw new Error(`Missing pinned source digest for ${evidence.source.path}.`);
    }
    expect(evidence.contentDigest).toBe(sourceDigest);
  }

  expect(
    provenance.commands.find((command) => command.id === "grep-signal-send")?.observed,
  ).toEqual(["internal/app/service.go:210"]);
  expect(
    provenance.commands.find((command) => command.id === "grep-signal-receive")?.observed,
  ).toEqual(["internal/search/outbox/worker.go:236"]);
});

test("live Linus provenance matches the checked capture when explicitly configured", async () => {
  const repositoryPath = Bun.env["CALLFLOW_LINUS_ACCEPTANCE_REPO"];
  const graftExecutable = Bun.env["CALLFLOW_GRAFT_BIN"];
  if (repositoryPath === undefined || graftExecutable === undefined) return;

  const expected = await readLinusProvenance();
  const actual = await capturePinnedLinusAcceptance({ repositoryPath, graftExecutable });
  const { schema, repositoryIdentity, ...capture } = expected;
  expect(schema).toBe("callflow/linus-provenance-v1");
  expect(repositoryIdentity).toBe("git:cd.splunkdev.com/linus/linus-findings-service");
  expect(actual).toEqual(capture);
}, 120_000);

test.each([
  "generic-workflow/workflow.callflow.json",
  "typescript-async-outbox/workflow.callflow.json",
  "linus-opensearch/workflow.callflow.json",
])("CallFlow manifest fixture validates: %s", async (path) => {
  expect(WorkflowManifestSchema.parse(await readJson(path)).schemaVersion).toBe(
    "callflow/workflow-manifest-v1",
  );
});

test("generic workflow produces byte-stable normalized graph JSON matching its golden", async () => {
  const manifest = await readManifest("generic-workflow/workflow.callflow.json");
  const input = GraphBuildInputSchema.parse(genericGraphInput);
  const snapshot = buildGraphFromManifest(manifest, input);
  const shuffled = GraphBuildInputSchema.parse({
    ...input,
    evidence: [...input.evidence].reverse(),
    nodes: [...input.nodes].reverse(),
    edges: [...input.edges].reverse(),
    warnings: [...input.warnings].reverse(),
  });
  const shuffledSnapshot = buildGraphFromManifest(manifest, shuffled);
  const golden = GraphSnapshotSchema.parse(
    await readJson("generic-workflow/graph-snapshot.golden.json"),
  );

  expectCompleteEvidence(snapshot);
  expect(canonicalStringify(shuffledSnapshot)).toBe(canonicalStringify(snapshot));
  expect(canonicalStringify(snapshot)).toBe(canonicalStringify(golden));
});

test("malformed adapter and evidence fixture inputs are rejected, not treated as empty", async () => {
  const malformedInput = await readJson("malformed-evidence/graph-build-input.invalid.json");
  const malformedGraft = await readFile(
    resolve(fixtureRoot, "malformed-evidence/graft-invalid.json"),
    "utf8",
  );

  const inputResult = GraphBuildInputSchema.safeParse(malformedInput);
  expect(inputResult.success).toBe(false);
  if (!inputResult.success) {
    const issuePaths = inputResult.error.issues.map((issue) => issue.path.join("."));
    expect(issuePaths).toContain("evidence.0.source.path");
    expect(issuePaths).toContain("evidence.0.source.end");
    expect(issuePaths).toContain("evidence.0.contentDigest");
    expect(issuePaths).toContain("extraction.items.0");
  }
  expect(() => parseGraftReadResponse("grep", malformedGraft)).toThrow("unsupported JSON shape");
});

test("TypeScript async outbox fixture preserves the bounded route and curated handoff", async () => {
  const snapshot = await buildFixture("typescript-async-outbox", typescriptAsyncOutboxGraphInput);
  const expectedLabels = (
    await readFile(resolve(fixtureRoot, "typescript-async-outbox/expected-path.txt"), "utf8")
  )
    .trim()
    .split("\n");
  const labels = new Set(snapshot.nodes.map((node) => node.label));

  expect(snapshot.nodes.length).toBeGreaterThanOrEqual(10);
  expect(snapshot.nodes.length).toBeLessThanOrEqual(30);
  expect(expectedLabels.every((label) => labels.has(label))).toBe(true);
  expectCompleteEvidence(snapshot);

  const entry = nodeByLabel(snapshot, "enqueueOpenSearchOutboxTx");
  const signal = nodeByLabel(snapshot, "signalOpenSearch");
  const worker = nodeByLabel(snapshot, "Worker.Run");
  const index = nodeByLabel(snapshot, "IndexDoc");
  const delivered = nodeByLabel(snapshot, "DeleteDelivered");
  const boundedKinds = ["direct-call", "conditional-call", "async-handoff", "poll"] as const;
  const indexPath = findPath(snapshot, entry.id, index.id, {
    maxDepth: 8,
    edgeKinds: boundedKinds,
  });
  const deliveredPath = findPath(snapshot, entry.id, delivered.id, {
    maxDepth: 8,
    edgeKinds: boundedKinds,
  });

  expect(indexPath).not.toBeNull();
  expect(pathLabels(snapshot, indexPath?.nodeIds ?? [])).toEqual([
    "enqueueOpenSearchOutboxTx",
    "signalOpenSearch",
    "Worker.Run",
    "Worker.ProcessOneRecord",
    "processClaim",
    "IndexDoc",
  ]);
  expect(pathLabels(snapshot, deliveredPath?.nodeIds ?? []).at(-1)).toBe("DeleteDelivered");

  const handoff = snapshot.edges.find(
    (edge) => edge.source === signal.id && edge.target === worker.id,
  );
  expect(handoff).toMatchObject({
    kind: "async-handoff",
    assertion: "curated-workflow",
  });
  expect(
    handoff?.evidenceIds.every(
      (id) => snapshot.evidence.find((record) => record.id === id)?.kind === "human-curated",
    ),
  ).toBe(true);
  expect(
    snapshot.edges.some(
      (edge) =>
        edge.source === signal.id && edge.target === worker.id && edge.kind === "direct-call",
    ),
  ).toBe(false);
});

test("Linus acceptance graph covers the pinned OpenSearch backbone without core selectors", async () => {
  const manifest = await readManifest("linus-opensearch/workflow.callflow.json");
  const acceptance = (await readJson("linus-opensearch/acceptance.json")) as {
    readonly commit?: unknown;
    readonly checkoutState?: unknown;
    readonly requiredLabels?: readonly string[];
    readonly requiredRelationship?: {
      readonly sourceAnchorId?: unknown;
      readonly targetAnchorId?: unknown;
      readonly kind?: unknown;
      readonly assertion?: unknown;
    };
    readonly forbiddenRelationship?: { readonly kind?: unknown };
    readonly notes?: unknown;
  };
  const snapshot = buildGraphFromManifest(manifest, linusOpenSearchGraphInput);

  expect(acceptance.commit).toBe("cd2949c1e4a686359900a3f47e8dbd2e2b44b861");
  expect(acceptance.checkoutState).toBe("clean");
  expect(snapshot.repository.commit).toBe(String(acceptance.commit));
  expect(snapshot.nodes.length).toBeLessThanOrEqual(30);
  expectCompleteEvidence(snapshot);

  const labels = new Set(snapshot.nodes.map((node) => node.label));
  expect(acceptance.requiredLabels?.every((label) => labels.has(label))).toBe(true);
  for (const label of [
    "ProcessOneRecord",
    "ReadFindingForProjectionTx",
    "ReadIncidentForProjectionTx",
    "projectFinding",
    "projectIncident",
    "IndexFor",
    "IndexDoc",
    "DeleteDelivered",
    "MarkRetrying",
    "MarkDead",
  ]) {
    expect(labels.has(label), `Missing Linus acceptance label ${label}`).toBe(true);
  }

  const signal = nodeByLabel(snapshot, "signalOpenSearch");
  const worker = nodeByLabel(snapshot, "Worker.Run");
  const handoffEdges = snapshot.edges.filter(
    (edge) => edge.source === signal.id && edge.target === worker.id,
  );
  expect(acceptance.requiredRelationship).toMatchObject({
    sourceAnchorId: "signal",
    targetAnchorId: "worker",
    kind: "async-handoff",
    assertion: "curated-workflow",
  });
  expect(acceptance.forbiddenRelationship?.kind).toBe("direct-call");
  expect(handoffEdges).toHaveLength(1);
  expect(handoffEdges[0]).toMatchObject({
    kind: "async-handoff",
    assertion: "curated-workflow",
  });
  expect(handoffEdges.some((edge) => edge.kind === "direct-call")).toBe(false);

  const enqueue = nodeByLabel(snapshot, "enqueueOpenSearchOutboxTx");
  const outbox = nodeByLabel(snapshot, "EnqueueOpenSearchOutboxTx");
  expect(
    snapshot.edges.some(
      (edge) =>
        edge.source === enqueue.id && edge.target === outbox.id && edge.kind === "direct-call",
    ),
  ).toBe(true);
  expect(
    snapshot.edges.some(
      (edge) =>
        edge.source === outbox.id &&
        edge.target === signal.id &&
        edge.kind === "transaction-commit" &&
        edge.assertion === "curated-workflow",
    ),
  ).toBe(true);

  const deliver = nodeByLabel(snapshot, "deliver");
  const delivered = nodeByLabel(snapshot, "DeleteDelivered");
  const retrying = nodeByLabel(snapshot, "MarkRetrying");
  const dead = nodeByLabel(snapshot, "MarkDead");
  const outcomeKinds = snapshot.edges
    .filter(
      (edge) =>
        edge.source === deliver.id && (edge.target === retrying.id || edge.target === dead.id),
    )
    .map((edge) => edge.kind)
    .sort();
  expect(outcomeKinds).toEqual(["failure-exit", "retry"]);
  expect(
    snapshot.edges.some(
      (edge) =>
        edge.source === deliver.id && edge.target === delivered.id && edge.kind === "direct-call",
    ),
  ).toBe(true);
  const project = nodeByLabel(snapshot, "project");
  for (const [label, kind] of [
    ["ReadFindingForProjectionTx", "state-read"],
    ["ReadIncidentForProjectionTx", "state-read"],
    ["projectFinding", "conditional-call"],
    ["projectIncident", "conditional-call"],
  ] as const) {
    expect(
      snapshot.edges.some(
        (edge) =>
          edge.source === project.id &&
          edge.target === nodeByLabel(snapshot, label).id &&
          edge.kind === kind,
      ),
    ).toBe(true);
  }
  expect(
    snapshot.edges.some(
      (edge) => edge.source === deliver.id && edge.target === nodeByLabel(snapshot, "IndexFor").id,
    ),
  ).toBe(true);
  expect(
    snapshot.edges.some(
      (edge) => edge.source === deliver.id && edge.target === nodeByLabel(snapshot, "IndexDoc").id,
    ),
  ).toBe(true);
  const indexPath = findPath(snapshot, signal.id, nodeByLabel(snapshot, "IndexDoc").id, {
    maxDepth: 8,
    edgeKinds: ["async-handoff", "poll", "conditional-call", "direct-call"],
  });
  expect(pathLabels(snapshot, indexPath?.nodeIds ?? [])).toEqual([
    "signalOpenSearch",
    "Worker.Run",
    "ProcessOneRecord",
    "processClaim",
    "deliver",
    "IndexDoc",
  ]);

  const graftExactEdgeKeys = new Set([
    "enqueue-writes-outbox",
    "process-dispatches",
    "process-delivers",
    "deliver-projects",
    "project-finding-document",
    "project-incident-document",
  ]);
  for (const edge of linusOpenSearchGraphInput.edges) {
    const evidence = linusOpenSearchGraphInput.evidence.find(
      (record) => record.key === edge.evidenceKeys[0],
    );
    expect(evidence).toBeDefined();
    if (edge.key === undefined) throw new Error("Linus acceptance edges must have stable keys.");
    if (graftExactEdgeKeys.has(edge.key)) {
      expect(edge.assertion).toBe("static-possible");
      expect(evidence?.kind).toBe("graft-exact");
    } else {
      expect(edge.assertion).toBe("curated-workflow");
      expect(evidence?.kind).toBe("human-curated");
    }
  }

  const coreSourceRoot = resolve(import.meta.dir, "../../packages/callflow-core/src");
  const coreFiles = (await readdir(coreSourceRoot)).filter((path) => path.endsWith(".ts"));
  const coreSource = (
    await Promise.all(coreFiles.map((path) => readFile(resolve(coreSourceRoot, path), "utf8")))
  ).join("\n");
  for (const selector of [
    "signalOpenSearch",
    "SelectAndClaimOneOpenSearchRecordTx",
    "ReadFindingForProjectionTx",
    "git:cd.splunkdev.com/linus/linus-findings-service",
  ]) {
    expect(coreSource).not.toContain(selector);
  }
  expect(manifest.description).toContain("Acceptance-only selectors");
  expect(String(acceptance.notes)).toContain("never use or mutate the user's dirty checkout");
});

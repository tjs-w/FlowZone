import { createHash } from "node:crypto";

import {
  GraphBuildInputSchema,
  type EdgeAssertion,
  type EdgeKind,
  type EvidenceKind,
  type GraphBuildInput,
  type GraphLevel,
  type NodeKind,
} from "@callflow/contracts";

interface FixtureNode {
  readonly key: string;
  readonly label: string;
  readonly kind?: NodeKind;
  readonly level?: Exclude<GraphLevel, "L0">;
  readonly anchorId?: string;
  readonly stageId: string;
  readonly qualifiedName: string;
  readonly path: string;
  readonly line: number;
  readonly endLine?: number;
  readonly evidenceKind?: EvidenceKind;
  readonly contentDigest?: `sha256:${string}`;
  readonly details?: string;
}

interface FixtureEdge {
  readonly key: string;
  readonly sourceKey: string;
  readonly targetKey: string;
  readonly kind: EdgeKind;
  readonly assertion?: EdgeAssertion;
  readonly evidenceKind?: EvidenceKind;
  readonly path: string;
  readonly line: number;
  readonly endLine?: number;
  readonly contentDigest?: `sha256:${string}`;
  readonly details?: string;
  readonly label?: string;
}

interface FixtureInputOptions {
  readonly repositoryIdentity: string;
  readonly commit: string;
  readonly nodes: readonly FixtureNode[];
  readonly edges: readonly FixtureEdge[];
  readonly defaultNodeEvidenceKind?: EvidenceKind;
  readonly sourceDigests?: Readonly<Record<string, `sha256:${string}`>>;
  readonly humanEvidenceSource?: "external-reference" | "source-span";
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/**
 * Creates deterministic adapter output for acceptance tests that must not depend
 * on an installed Graft index. The locations mirror checked-in fixture source or
 * the separately pinned Linus revision; no source bodies are embedded here.
 */
function fixtureGraphInput(options: FixtureInputOptions): GraphBuildInput {
  const nodeEvidence = options.nodes.map((node) => ({
    key: `evidence:node:${node.key}`,
    kind: node.evidenceKind ?? options.defaultNodeEvidenceKind ?? ("graft-exact" as const),
    state: "exact" as const,
    revision: options.commit,
    source: {
      type: "source-span" as const,
      path: node.path,
      start: { line: node.line, column: 1 },
      end: { line: node.endLine ?? node.line, column: 10_000_000 },
      symbol: node.qualifiedName,
    },
    contentDigest:
      node.contentDigest ??
      options.sourceDigests?.[node.path] ??
      digest(`node\0${options.commit}\0${node.key}`),
    producer:
      (node.evidenceKind ?? options.defaultNodeEvidenceKind) === "source-literal"
        ? { name: "callflow-source-literal", version: "1" }
        : { name: "graft", version: "0.18.0" },
    ...(node.details === undefined ? {} : { details: node.details }),
  }));
  const edgeEvidence = options.edges.map((edge) => {
    const kind = edge.evidenceKind ?? "graft-exact";
    return {
      key: `evidence:edge:${edge.key}`,
      kind,
      state: "exact" as const,
      revision: options.commit,
      source:
        kind === "human-curated" && options.humanEvidenceSource !== "source-span"
          ? {
              type: "external-reference" as const,
              system: "callflow-fixture",
              reference: `${options.repositoryIdentity}#${edge.key}`,
            }
          : {
              type: "source-span" as const,
              path: edge.path,
              start: { line: edge.line, column: 1 },
              end: { line: edge.endLine ?? edge.line, column: 10_000_000 },
              symbol: `${edge.sourceKey}->${edge.targetKey}`,
            },
      contentDigest:
        edge.contentDigest ??
        options.sourceDigests?.[edge.path] ??
        digest(`edge\0${options.commit}\0${edge.key}`),
      producer:
        kind === "human-curated"
          ? { name: "callflow-fixture", version: "1" }
          : { name: "graft", version: "0.18.0" },
      ...(edge.details === undefined ? {} : { details: edge.details }),
    };
  });
  const evidence = [...nodeEvidence, ...edgeEvidence];

  return GraphBuildInputSchema.parse({
    repository: {
      identity: options.repositoryIdentity,
      commit: options.commit,
      dirtyDigest: digest(`clean\0${options.repositoryIdentity}\0${options.commit}`),
    },
    adapter: {
      name: "graft",
      version: "0.18.0",
      indexRevision: digest(`index\0${options.repositoryIdentity}\0${options.commit}`),
    },
    evidence,
    nodes: options.nodes.map((node) => ({
      key: node.key,
      ...(node.anchorId === undefined ? {} : { anchorId: node.anchorId }),
      kind: node.kind ?? "function",
      label: node.label,
      level: node.level ?? "L1",
      stageId: node.stageId,
      qualifiedName: node.qualifiedName,
      evidenceKeys: [`evidence:node:${node.key}`],
      attributes: { fixture: true },
    })),
    edges: options.edges.map((edge) => ({
      key: edge.key,
      sourceKey: edge.sourceKey,
      targetKey: edge.targetKey,
      kind: edge.kind,
      assertion: edge.assertion ?? "static-possible",
      evidenceKeys: [`evidence:edge:${edge.key}`],
      ...(edge.label === undefined ? {} : { label: edge.label }),
    })),
    warnings: [],
    extraction: {
      status: "succeeded",
      items: evidence.map((record) => record.key),
    },
    runtimeEvidence: {
      status: "unavailable",
      reason: "Runtime evidence is disabled in CallFlow v1.",
    },
  });
}

const genericPath = "src/workflow.ts";

export const genericGraphInput = fixtureGraphInput({
  repositoryIdentity: "fixture:generic-workflow",
  commit: "generic-fixture-v1",
  nodes: [
    {
      key: "handle",
      anchorId: "entry-handle-request",
      label: "handleRequest",
      stageId: "accept",
      qualifiedName: "src/workflow.ts#handleRequest",
      path: genericPath,
      line: 13,
    },
    {
      key: "validate",
      label: "validateRequest",
      stageId: "accept",
      qualifiedName: "src/workflow.ts#validateRequest",
      path: genericPath,
      line: 18,
    },
    {
      key: "enqueue",
      anchorId: "queue-work",
      label: "enqueueWork",
      kind: "queue",
      stageId: "handoff",
      qualifiedName: "src/workflow.ts#enqueueWork",
      path: genericPath,
      line: 23,
    },
    {
      key: "process",
      label: "processNext",
      stageId: "handoff",
      qualifiedName: "src/workflow.ts#processNext",
      path: genericPath,
      line: 27,
    },
    {
      key: "persist",
      label: "persistResult",
      kind: "database",
      stageId: "deliver",
      qualifiedName: "src/workflow.ts#persistResult",
      path: genericPath,
      line: 35,
    },
    {
      key: "notify",
      anchorId: "sink-notify",
      label: "notifyExternalSystem",
      kind: "external-system",
      stageId: "deliver",
      qualifiedName: "src/workflow.ts#notifyExternalSystem",
      path: genericPath,
      line: 39,
    },
  ],
  edges: [
    {
      key: "handle-validates",
      sourceKey: "handle",
      targetKey: "validate",
      kind: "direct-call",
      path: genericPath,
      line: 14,
    },
    {
      key: "handle-enqueues",
      sourceKey: "handle",
      targetKey: "enqueue",
      kind: "direct-call",
      path: genericPath,
      line: 15,
    },
    {
      key: "queue-handoff",
      sourceKey: "enqueue",
      targetKey: "process",
      kind: "async-handoff",
      assertion: "curated-workflow",
      evidenceKind: "human-curated",
      label: "consumed later",
      path: genericPath,
      line: 27,
    },
    {
      key: "process-persists",
      sourceKey: "process",
      targetKey: "persist",
      kind: "state-write",
      path: genericPath,
      line: 30,
    },
    {
      key: "process-notifies",
      sourceKey: "process",
      targetKey: "notify",
      kind: "direct-call",
      path: genericPath,
      line: 31,
    },
  ],
});

const typescriptPath = "src/outbox.ts";

export const typescriptAsyncOutboxGraphInput = fixtureGraphInput({
  repositoryIdentity: "fixture:typescript-async-outbox",
  commit: "typescript-async-outbox-v1",
  nodes: [
    {
      key: "enqueue",
      anchorId: "enqueue-entry",
      label: "enqueueOpenSearchOutboxTx",
      stageId: "write",
      qualifiedName: "src/outbox.ts#enqueueOpenSearchOutboxTx",
      path: typescriptPath,
      line: 13,
    },
    {
      key: "transaction",
      label: "transaction",
      kind: "transaction",
      stageId: "write",
      qualifiedName: "src/outbox.ts#transaction",
      path: typescriptPath,
      line: 20,
    },
    {
      key: "outbox",
      anchorId: "outbox-queue",
      label: "Enqueue",
      kind: "queue",
      stageId: "handoff",
      qualifiedName: "src/outbox.ts#Enqueue",
      path: typescriptPath,
      line: 24,
    },
    {
      key: "signal",
      anchorId: "signal",
      label: "signalOpenSearch",
      stageId: "handoff",
      qualifiedName: "src/outbox.ts#signalOpenSearch",
      path: typescriptPath,
      line: 28,
    },
    {
      key: "worker",
      anchorId: "worker",
      label: "Worker.Run",
      stageId: "claim",
      qualifiedName: "src/outbox.ts#Worker.Run",
      path: typescriptPath,
      line: 33,
    },
    {
      key: "process-one",
      label: "Worker.ProcessOneRecord",
      stageId: "claim",
      qualifiedName: "src/outbox.ts#Worker.ProcessOneRecord",
      path: typescriptPath,
      line: 39,
    },
    {
      key: "claim",
      label: "SelectAndClaim",
      kind: "transaction",
      stageId: "claim",
      qualifiedName: "src/outbox.ts#SelectAndClaim",
      path: typescriptPath,
      line: 48,
    },
    {
      key: "process",
      label: "processClaim",
      stageId: "project",
      qualifiedName: "src/outbox.ts#processClaim",
      path: typescriptPath,
      line: 52,
    },
    {
      key: "reread",
      label: "rereadFinding",
      kind: "database",
      stageId: "project",
      qualifiedName: "src/outbox.ts#rereadFinding",
      path: typescriptPath,
      line: 65,
    },
    {
      key: "projection",
      label: "buildProjection",
      stageId: "project",
      qualifiedName: "src/outbox.ts#buildProjection",
      path: typescriptPath,
      line: 69,
    },
    {
      key: "index-for",
      label: "IndexFor",
      stageId: "project",
      qualifiedName: "src/outbox.ts#IndexFor",
      path: typescriptPath,
      line: 73,
    },
    {
      key: "index",
      anchorId: "index-sink",
      label: "IndexDoc",
      kind: "external-system",
      stageId: "project",
      qualifiedName: "src/outbox.ts#IndexDoc",
      path: typescriptPath,
      line: 78,
    },
    {
      key: "delivered",
      label: "DeleteDelivered",
      kind: "terminal",
      stageId: "settle",
      qualifiedName: "src/outbox.ts#DeleteDelivered",
      path: typescriptPath,
      line: 83,
    },
    {
      key: "retrying",
      label: "MarkRetrying",
      kind: "terminal",
      stageId: "settle",
      qualifiedName: "src/outbox.ts#MarkRetrying",
      path: typescriptPath,
      line: 87,
    },
    {
      key: "dead",
      label: "MarkDead",
      kind: "terminal",
      stageId: "settle",
      qualifiedName: "src/outbox.ts#MarkDead",
      path: typescriptPath,
      line: 91,
    },
  ],
  edges: [
    {
      key: "enter-transaction",
      sourceKey: "enqueue",
      targetKey: "transaction",
      kind: "transaction-enter",
      path: typescriptPath,
      line: 14,
    },
    {
      key: "transaction-enqueues",
      sourceKey: "transaction",
      targetKey: "outbox",
      kind: "direct-call",
      path: typescriptPath,
      line: 15,
    },
    {
      key: "post-commit-signal",
      sourceKey: "enqueue",
      targetKey: "signal",
      kind: "direct-call",
      path: typescriptPath,
      line: 17,
    },
    {
      key: "run-processes-one",
      sourceKey: "worker",
      targetKey: "process-one",
      kind: "poll",
      path: typescriptPath,
      line: 34,
    },
    {
      key: "process-claims",
      sourceKey: "process-one",
      targetKey: "claim",
      kind: "claim",
      path: typescriptPath,
      line: 40,
    },
    {
      key: "process-dispatches",
      sourceKey: "process-one",
      targetKey: "process",
      kind: "conditional-call",
      path: typescriptPath,
      line: 42,
    },
    {
      key: "claim-rereads",
      sourceKey: "process",
      targetKey: "reread",
      kind: "state-read",
      path: typescriptPath,
      line: 54,
    },
    {
      key: "claim-projects",
      sourceKey: "process",
      targetKey: "projection",
      kind: "direct-call",
      path: typescriptPath,
      line: 55,
    },
    {
      key: "claim-selects-index",
      sourceKey: "process",
      targetKey: "index-for",
      kind: "direct-call",
      path: typescriptPath,
      line: 56,
    },
    {
      key: "claim-indexes",
      sourceKey: "process",
      targetKey: "index",
      kind: "direct-call",
      path: typescriptPath,
      line: 56,
    },
    {
      key: "claim-delivered",
      sourceKey: "process",
      targetKey: "delivered",
      kind: "direct-call",
      path: typescriptPath,
      line: 57,
    },
    {
      key: "claim-retries",
      sourceKey: "process",
      targetKey: "retrying",
      kind: "retry",
      path: typescriptPath,
      line: 61,
    },
    {
      key: "claim-dead-letters",
      sourceKey: "process",
      targetKey: "dead",
      kind: "failure-exit",
      path: typescriptPath,
      line: 60,
    },
  ],
});

const linusCommit = "cd2949c1e4a686359900a3f47e8dbd2e2b44b861";
const outboxDbPath = "internal/db/opensearch_outbox.go";
const outboxProcessPath = "internal/search/outbox/process.go";
const linusSourceDigests = {
  [outboxDbPath]: "sha256:01db649439fffa7d56029a03cddef8e27e2becb78aeda3389412fd0406627fa4",
  "internal/app/service.go":
    "sha256:17e3bcc3c6715dfca9190ccba1ebf4e186205272fab17920671458effb42607d",
  "internal/search/outbox/worker.go":
    "sha256:01f427cde5892cb95ad8f84e6496ceac31e9d8535f2a333bcaa56e145bf20ed2",
  [outboxProcessPath]: "sha256:2d17b3bc42bf3402054eb675cf3fae6014370fd13d156a363c8c1f57b2d21e17",
  "internal/db/opensearch_reread.go":
    "sha256:a394d71fe058637ffdd6ffa201ed26d7b090b9c794de954c0350ee3ffa67d775",
  "internal/search/outbox/project.go":
    "sha256:674987770585ebdac52836bf466f35aa7dccb33beff9b1b9df09290f62b0394d",
  "internal/search/service.go":
    "sha256:943507439e0bc6fba4fc3e1ce77fb25bb99980e4225125f942867a438b2abc47",
  "internal/search/client.go":
    "sha256:6c6e173c6953ac5d1150fb80f97b3b4fd2a99531bd6c656350b2576a45db0d14",
} as const;

export const linusOpenSearchGraphInput = fixtureGraphInput({
  repositoryIdentity: "git:cd.splunkdev.com/linus/linus-findings-service",
  commit: linusCommit,
  defaultNodeEvidenceKind: "source-literal",
  humanEvidenceSource: "source-span",
  sourceDigests: linusSourceDigests,
  nodes: [
    {
      key: "enqueue",
      anchorId: "enqueue",
      label: "enqueueOpenSearchOutboxTx",
      stageId: "commit",
      qualifiedName: "internal/db/opensearch_outbox.go#Store.enqueueOpenSearchOutboxTx",
      path: outboxDbPath,
      line: 84,
    },
    {
      key: "outbox",
      anchorId: "outbox",
      label: "EnqueueOpenSearchOutboxTx",
      kind: "queue",
      stageId: "commit",
      qualifiedName: "internal/db/opensearch_outbox.go#Store.EnqueueOpenSearchOutboxTx",
      path: outboxDbPath,
      line: 56,
    },
    {
      key: "signal",
      anchorId: "signal",
      label: "signalOpenSearch",
      stageId: "handoff",
      qualifiedName: "internal/app/service.go#Service.signalOpenSearch",
      path: "internal/app/service.go",
      line: 205,
    },
    {
      key: "worker",
      anchorId: "worker",
      label: "Worker.Run",
      stageId: "consume",
      qualifiedName: "internal/search/outbox/worker.go#Worker.Run",
      path: "internal/search/outbox/worker.go",
      line: 227,
    },
    {
      key: "process-one",
      anchorId: "process-one",
      label: "ProcessOneRecord",
      stageId: "consume",
      qualifiedName: "internal/search/outbox/process.go#Worker.ProcessOneRecord",
      path: outboxProcessPath,
      line: 43,
    },
    {
      key: "claim",
      anchorId: "claim",
      label: "SelectAndClaimOneOpenSearchRecordTx",
      kind: "transaction",
      stageId: "consume",
      qualifiedName: "internal/db/opensearch_outbox.go#Store.SelectAndClaimOneOpenSearchRecordTx",
      path: outboxDbPath,
      line: 110,
    },
    {
      key: "process",
      anchorId: "process",
      label: "processClaim",
      stageId: "project",
      qualifiedName: "internal/search/outbox/process.go#Worker.processClaim",
      path: outboxProcessPath,
      line: 130,
    },
    {
      key: "deliver",
      anchorId: "deliver",
      label: "deliver",
      stageId: "project",
      qualifiedName: "internal/search/outbox/process.go#Worker.deliver",
      path: outboxProcessPath,
      line: 142,
    },
    {
      key: "project",
      anchorId: "projection",
      label: "project",
      stageId: "project",
      qualifiedName: "internal/search/outbox/process.go#Worker.project",
      path: outboxProcessPath,
      line: 246,
    },
    {
      key: "reread-finding",
      anchorId: "reread-finding",
      label: "ReadFindingForProjectionTx",
      kind: "database",
      stageId: "project",
      qualifiedName: "internal/db/opensearch_reread.go#Store.ReadFindingForProjectionTx",
      path: "internal/db/opensearch_reread.go",
      line: 91,
    },
    {
      key: "reread-incident",
      label: "ReadIncidentForProjectionTx",
      kind: "database",
      stageId: "project",
      qualifiedName: "internal/db/opensearch_reread.go#Store.ReadIncidentForProjectionTx",
      path: "internal/db/opensearch_reread.go",
      line: 163,
    },
    {
      key: "project-finding",
      label: "projectFinding",
      stageId: "project",
      qualifiedName: "internal/search/outbox/project.go#projectFinding",
      path: "internal/search/outbox/project.go",
      line: 23,
    },
    {
      key: "project-incident",
      label: "projectIncident",
      stageId: "project",
      qualifiedName: "internal/search/outbox/project.go#projectIncident",
      path: "internal/search/outbox/project.go",
      line: 61,
    },
    {
      key: "index-for",
      anchorId: "index-for",
      label: "IndexFor",
      stageId: "deliver",
      qualifiedName: "internal/search/service.go#IndexFor",
      path: "internal/search/service.go",
      line: 114,
    },
    {
      key: "index",
      anchorId: "index",
      label: "IndexDoc",
      kind: "external-system",
      stageId: "deliver",
      qualifiedName: "internal/search/client.go#Client.IndexDoc",
      path: "internal/search/client.go",
      line: 636,
    },
    {
      key: "delivered",
      anchorId: "delivered",
      label: "DeleteDelivered",
      kind: "terminal",
      stageId: "settle",
      qualifiedName:
        "internal/db/opensearch_outbox.go#claimedOpenSearchOutboxRecord.DeleteDelivered",
      path: outboxDbPath,
      line: 157,
    },
    {
      key: "retrying",
      anchorId: "retry",
      label: "MarkRetrying",
      kind: "terminal",
      stageId: "settle",
      qualifiedName: "internal/db/opensearch_outbox.go#claimedOpenSearchOutboxRecord.MarkRetrying",
      path: outboxDbPath,
      line: 165,
    },
    {
      key: "dead",
      anchorId: "dead",
      label: "MarkDead",
      kind: "terminal",
      stageId: "settle",
      qualifiedName: "internal/db/opensearch_outbox.go#claimedOpenSearchOutboxRecord.MarkDead",
      path: outboxDbPath,
      line: 181,
    },
  ],
  edges: [
    {
      key: "enqueue-writes-outbox",
      sourceKey: "enqueue",
      targetKey: "outbox",
      kind: "direct-call",
      path: outboxDbPath,
      line: 91,
      details:
        "Graft 0.18 callers confirms Store.enqueueOpenSearchOutboxTx calls Store.EnqueueOpenSearchOutboxTx at the pinned index revision.",
    },
    {
      key: "worker-polls",
      sourceKey: "worker",
      targetKey: "process-one",
      kind: "poll",
      assertion: "curated-workflow",
      evidenceKind: "human-curated",
      path: "internal/search/outbox/worker.go",
      line: 244,
      details:
        "The pinned source calls ProcessOneRecord after either the notify channel or timer fires; Graft 0.18 omits this receiver call.",
    },
    {
      key: "process-claims",
      sourceKey: "process-one",
      targetKey: "claim",
      kind: "claim",
      assertion: "curated-workflow",
      evidenceKind: "human-curated",
      path: outboxProcessPath,
      line: 64,
      details:
        "The pinned source invokes the outbox-store interface claim method; Graft 0.18 does not resolve that interface edge.",
    },
    {
      key: "process-dispatches",
      sourceKey: "process-one",
      targetKey: "process",
      kind: "conditional-call",
      path: outboxProcessPath,
      line: 92,
      details:
        "Graft 0.18 callers confirms Worker.ProcessOneRecord calls Worker.processClaim at the pinned index revision.",
    },
    {
      key: "process-delivers",
      sourceKey: "process",
      targetKey: "deliver",
      kind: "direct-call",
      path: outboxProcessPath,
      line: 134,
      details:
        "Graft 0.18 callers confirms Worker.processClaim calls Worker.deliver at the pinned index revision.",
    },
    {
      key: "deliver-projects",
      sourceKey: "deliver",
      targetKey: "project",
      kind: "direct-call",
      path: outboxProcessPath,
      line: 145,
      details:
        "Graft 0.18 callers confirms Worker.deliver calls Worker.project at the pinned index revision.",
    },
    {
      key: "project-rereads-finding",
      sourceKey: "project",
      targetKey: "reread-finding",
      kind: "state-read",
      assertion: "curated-workflow",
      evidenceKind: "human-curated",
      path: outboxProcessPath,
      line: 249,
      details:
        "The pinned source invokes the outbox-store interface finding reread; Graft 0.18 omits this interface edge.",
    },
    {
      key: "project-rereads-incident",
      sourceKey: "project",
      targetKey: "reread-incident",
      kind: "state-read",
      assertion: "curated-workflow",
      evidenceKind: "human-curated",
      path: outboxProcessPath,
      line: 259,
      details:
        "The pinned source invokes the outbox-store interface incident reread; Graft 0.18 omits this interface edge.",
    },
    {
      key: "project-finding-document",
      sourceKey: "project",
      targetKey: "project-finding",
      kind: "conditional-call",
      path: outboxProcessPath,
      line: 256,
      details:
        "Graft 0.18 callers confirms Worker.project calls projectFinding at the pinned index revision.",
    },
    {
      key: "project-incident-document",
      sourceKey: "project",
      targetKey: "project-incident",
      kind: "conditional-call",
      path: outboxProcessPath,
      line: 266,
      details:
        "Graft 0.18 callers confirms Worker.project calls projectIncident at the pinned index revision.",
    },
    {
      key: "deliver-selects-index",
      sourceKey: "deliver",
      targetKey: "index-for",
      kind: "direct-call",
      assertion: "curated-workflow",
      evidenceKind: "human-curated",
      path: outboxProcessPath,
      line: 198,
      details:
        "The pinned source selects the tenant index with search.IndexFor; Graft 0.18 omits this cross-package call.",
    },
    {
      key: "deliver-indexes",
      sourceKey: "deliver",
      targetKey: "index",
      kind: "direct-call",
      assertion: "curated-workflow",
      evidenceKind: "human-curated",
      path: outboxProcessPath,
      line: 213,
      details:
        "The pinned source invokes the index-client interface; Graft 0.18 omits this interface edge.",
    },
    {
      key: "deliver-deletes-row",
      sourceKey: "deliver",
      targetKey: "delivered",
      kind: "direct-call",
      assertion: "curated-workflow",
      evidenceKind: "human-curated",
      path: outboxProcessPath,
      line: 216,
      details:
        "The pinned source deletes the claimed row after a successful or benign-conflict delivery; Graft 0.18 omits this interface edge.",
    },
  ],
});

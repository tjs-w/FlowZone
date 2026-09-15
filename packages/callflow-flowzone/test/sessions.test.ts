import { describe, expect, test } from "bun:test";

import {
  GraphSnapshotSchema,
  WorkflowManifestSchema,
  type GraphSnapshot,
  type WorkflowManifest,
} from "@callflow/contracts";
import { RepositoryPolicy, sha256, type RepositoryContext } from "@callflow/node";

import { CallFlowSessionStore, sliceSourceSpan } from "../src/sessions.js";

const source = Buffer.from("alpha\nbravo\ncharlie\n");
const revision = {
  identity: "local:/fixture/repository",
  commit: "fixture-commit",
  dirtyDigest: `sha256:${"0".repeat(64)}`,
} as const;

const manifest: WorkflowManifest = WorkflowManifestSchema.parse({
  schemaVersion: "callflow/workflow-manifest-v1",
  id: "fixture-manifest",
  name: "Fixture manifest",
  repository: { identity: revision.identity },
  anchors: [
    {
      id: "entry",
      label: "entry",
      role: "entry",
      nodeKind: "function",
      selector: { type: "symbol", value: "entry" },
    },
  ],
  stages: [],
  exclusions: [],
  acceptedSemanticLinks: [],
  presentation: { direction: "RIGHT", defaultOverlay: "none" },
});

function snapshot(contentDigest = sha256(source)): GraphSnapshot {
  return GraphSnapshotSchema.parse({
    schemaVersion: "callflow/graph-snapshot-v1",
    id: "fixture-graph",
    workflowManifestId: manifest.id,
    repository: revision,
    adapter: { name: "fixture", version: "1", indexRevision: "fixture-index" },
    nodes: [
      {
        id: "fixture-node",
        kind: "function",
        label: "entry",
        level: "L1",
        evidenceIds: ["fixture-evidence"],
      },
    ],
    edges: [],
    evidence: [
      {
        id: "fixture-evidence",
        kind: "graft-exact",
        state: "exact",
        revision: revision.commit,
        source: {
          type: "source-span",
          path: "src/fixture.ts",
          start: { line: 1, column: 3 },
          end: { line: 2, column: 4 },
        },
        contentDigest,
        producer: { name: "graft", version: "0.18.0" },
      },
      {
        id: "fixture-evidence-2",
        kind: "graft-exact",
        state: "exact",
        revision: revision.commit,
        source: {
          type: "source-span",
          path: "src/fixture.ts",
          start: { line: 3, column: 1 },
          end: { line: 3, column: 8 },
        },
        contentDigest,
        producer: { name: "graft", version: "0.18.0" },
      },
    ],
    warnings: [],
    presentation: {
      schemaVersion: "callflow/graph-presentation-v1",
      direction: "RIGHT",
      defaultOverlay: "none",
    },
    layoutHints: {
      schemaVersion: "callflow/graph-layout-hints-v1",
      stageOrder: [],
    },
  });
}

class FixtureRepositoryPolicy extends RepositoryPolicy {
  bytes = source;

  override resolveRepository(): Promise<RepositoryContext> {
    return Promise.resolve({ root: "/fixture/repository", revision });
  }

  override readSource(): Promise<Buffer> {
    return Promise.resolve(this.bytes);
  }
}

describe("CallFlow source capabilities", () => {
  test("slices both boundary columns and clamps line-only end columns", () => {
    expect(
      sliceSourceSpan(source.toString("utf8"), {
        type: "source-span",
        path: "src/fixture.ts",
        start: { line: 1, column: 3 },
        end: { line: 2, column: 4 },
      }),
    ).toBe("pha\nbra");
    expect(
      sliceSourceSpan(source.toString("utf8"), {
        type: "source-span",
        path: "src/fixture.ts",
        start: { line: 2, column: 1 },
        end: { line: 2, column: 10_000_000 },
      }),
    ).toBe("bravo");
  });

  test("revalidates the exact bytes immediately before disclosure", async () => {
    const repositoryPolicy = new FixtureRepositoryPolicy();
    const sessions = new CallFlowSessionStore({
      repositoryPolicy,
      createId: () => "fixture-session",
      createToken: () => "a".repeat(43),
    });
    const sessionId = sessions.create("/fixture/repository", manifest, snapshot());
    const payload = sessions.issuePayload(sessionId);
    repositoryPolicy.bytes = Buffer.from("changed\nsource\n");

    let failure: unknown;
    try {
      await sessions.source({
        sessionId,
        capabilityToken: payload.capability.token,
        graphRevision: payload.snapshot.id,
        evidenceId: "fixture-evidence",
        purpose: "Explain the selected evidence.",
        maxBytes: 512,
      });
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "source_changed" });
  });

  test("binds each capability to one exact source request", async () => {
    const sessions = new CallFlowSessionStore({
      repositoryPolicy: new FixtureRepositoryPolicy(),
      createId: () => "fixture-session",
      createToken: () => "b".repeat(43),
    });
    const sessionId = sessions.create("/fixture/repository", manifest, snapshot());
    const payload = sessions.issuePayload(sessionId);
    const request = {
      sessionId,
      capabilityToken: payload.capability.token,
      graphRevision: payload.snapshot.id,
      evidenceId: "fixture-evidence",
      purpose: "Explain the exact selected evidence.",
      maxBytes: 4,
    };

    const excerpt = await sessions.source(request);
    let reuseFailure: unknown;
    try {
      await sessions.source({ ...request, purpose: "Try another purpose." });
    } catch (error: unknown) {
      reuseFailure = error;
    }

    expect(excerpt.content).toBe("pha\n");
    expect(excerpt.truncated).toBe(true);
    expect(reuseFailure).toMatchObject({ code: "path_denied" });
  });

  test("rotates capabilities so two explicitly selected spans can be inspected", async () => {
    let tokenNumber = 0;
    const sessions = new CallFlowSessionStore({
      repositoryPolicy: new FixtureRepositoryPolicy(),
      createId: () => "fixture-session",
      createToken: () => `${String(++tokenNumber).padStart(4, "0")}${"c".repeat(39)}`,
    });
    const sessionId = sessions.create("/fixture/repository", manifest, snapshot());
    const firstPayload = sessions.issuePayload(sessionId);
    const first = await sessions.source({
      sessionId,
      capabilityToken: firstPayload.capability.token,
      graphRevision: firstPayload.snapshot.id,
      evidenceId: "fixture-evidence",
      purpose: "Explain the first selected evidence.",
      maxBytes: 512,
    });
    const capabilityUpdate = sessions.issueCapability(sessionId);
    const second = await sessions.source({
      sessionId,
      capabilityToken: capabilityUpdate.capability.token,
      graphRevision: capabilityUpdate.capability.graphRevision,
      evidenceId: "fixture-evidence-2",
      purpose: "Explain the second selected evidence.",
      maxBytes: 512,
    });

    expect(first.content).toBe("pha\nbra");
    expect(second.content).toBe("charlie");
    expect(capabilityUpdate).toMatchObject({
      schema: "callflow/capability-update-v1",
      sessionId,
      capability: {
        repositoryRevision: revision.commit,
        graphRevision: firstPayload.snapshot.id,
      },
    });
    expect(capabilityUpdate).not.toHaveProperty("snapshot");
    expect(capabilityUpdate.capability.token).not.toBe(firstPayload.capability.token);
    expect(second.remainingByteBudget).toBeLessThan(first.remainingByteBudget);
  });

  test("consumes an exact source grant before concurrent repository reads", async () => {
    const sessions = new CallFlowSessionStore({
      repositoryPolicy: new FixtureRepositoryPolicy(),
      createId: () => "fixture-session",
      createToken: () => "d".repeat(43),
    });
    const sessionId = sessions.create("/fixture/repository", manifest, snapshot());
    const payload = sessions.issuePayload(sessionId);
    const request = {
      sessionId,
      capabilityToken: payload.capability.token,
      graphRevision: payload.snapshot.id,
      evidenceId: "fixture-evidence",
      purpose: "Explain the selected evidence once.",
      maxBytes: 512,
    };

    const outcomes = await Promise.allSettled([sessions.source(request), sessions.source(request)]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : undefined).toMatchObject({
      code: "path_denied",
    });
  });
});

import { describe, expect, test } from "bun:test";

import { GraphSnapshotSchema } from "@callflow/contracts";

import { CallFlowService, graphHasHealthyEvidence } from "../src/service.js";

describe("CallFlow graph export", () => {
  test("sanitizes graph JSON through the portable export boundary", () => {
    const snapshot = GraphSnapshotSchema.parse({
      schemaVersion: "callflow/graph-snapshot-v1",
      id: "fixture-graph",
      workflowManifestId: "fixture-manifest",
      repository: {
        identity: "local:/Users/example/private-repository",
        commit: "fixture-commit",
        dirtyDigest: `sha256:${"0".repeat(64)}`,
      },
      adapter: { name: "fixture", version: "1", indexRevision: "fixture-index" },
      nodes: [
        {
          id: "fixture-node",
          kind: "function",
          label: "Load /Users/example/private-repository/src/main.ts",
          level: "L1",
          evidenceIds: ["fixture-evidence"],
          attributes: {
            secretToken: "never-export-this",
            safePath: "/Users/example/private-repository/src/main.ts",
          },
        },
      ],
      edges: [],
      evidence: [
        {
          id: "fixture-evidence",
          kind: "human-curated",
          state: "exact",
          revision: "fixture-commit",
          source: {
            type: "external-reference",
            system: "fixture",
            reference: "/Users/example/private-repository/src/main.ts",
          },
          contentDigest: `sha256:${"1".repeat(64)}`,
          producer: { name: "fixture", version: "1" },
          details: "Reviewed at /Users/example/private-repository/src/main.ts",
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

    const exported = new CallFlowService().export(snapshot, "graph-json");
    const parsed = GraphSnapshotSchema.parse(JSON.parse(exported) as unknown);

    expect(parsed.repository.identity).toStartWith("repository:sha256:");
    expect(exported).not.toContain("/Users/example");
    expect(exported).not.toContain("secretToken");
    expect(exported).not.toContain("never-export-this");
    expect(exported).toContain("[redacted-sensitive-text]");
  });

  test("fails the CLI health policy for degraded extraction or evidence", () => {
    const base = GraphSnapshotSchema.parse({
      schemaVersion: "callflow/graph-snapshot-v1",
      id: "healthy-graph",
      workflowManifestId: "fixture-manifest",
      repository: {
        identity: "repository:fixture",
        commit: "fixture-commit",
        dirtyDigest: `sha256:${"0".repeat(64)}`,
      },
      adapter: { name: "graft", version: "0.18.0", indexRevision: "fixture-index" },
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
          revision: "fixture-commit",
          source: {
            type: "external-reference",
            system: "graft",
            reference: "symbol:entry",
          },
          contentDigest: `sha256:${"1".repeat(64)}`,
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
      extraction: { status: "succeeded", items: ["fixture-evidence"] },
      runtimeEvidence: { status: "unavailable", reason: "Runtime evidence is disabled in v1." },
    });

    expect(graphHasHealthyEvidence(base)).toBe(true);
    expect(
      graphHasHealthyEvidence(
        GraphSnapshotSchema.parse({
          ...base,
          extraction: { status: "failed", code: "graft-query-failed", retryable: true },
        }),
      ),
    ).toBe(false);
    expect(
      graphHasHealthyEvidence(
        GraphSnapshotSchema.parse({
          ...base,
          evidence: [{ ...base.evidence[0], state: "stale" }],
        }),
      ),
    ).toBe(false);
  });
});

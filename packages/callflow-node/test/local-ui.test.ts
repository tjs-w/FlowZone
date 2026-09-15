import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { CallFlowUiPayloadSchema, GraphSnapshotSchema } from "@callflow/contracts";

import { createStandaloneCallFlowHtml, localBrowserCommand } from "../src/local-ui.js";

describe("CallFlow standalone UI", () => {
  test("uses a fixed executable and shell-free arguments to open the UI on Windows", () => {
    const url = "http://127.0.0.1:12345/private-route";

    expect(localBrowserCommand("win32", url)).toEqual({
      candidates: [
        String.raw`C:\Windows\System32\rundll32.exe`,
        String.raw`C:\WINNT\System32\rundll32.exe`,
      ],
      args: ["url.dll,FileProtocolHandler", url],
    });
  });

  test("embeds a source-free escaped bootstrap payload in the interactive app", async () => {
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
          label: "entry </script><script>alert(1)</script>",
          level: "L1",
          evidenceIds: ["fixture-evidence"],
        },
      ],
      edges: [],
      evidence: [
        {
          id: "fixture-evidence",
          kind: "human-curated",
          state: "exact",
          revision: "fixture-commit",
          source: { type: "external-reference", system: "fixture", reference: "reviewed-entry" },
          contentDigest: `sha256:${"1".repeat(64)}`,
          producer: { name: "fixture", version: "1" },
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
    const webRoot = resolve(import.meta.dir, "../../../web");

    const html = await createStandaloneCallFlowHtml(snapshot, webRoot);

    const opening = '<script id="callflow-bootstrap" type="application/json">';
    const openingIndex = html.indexOf(opening);
    const markerIndex = html.indexOf("<!-- CALLFLOW_APP -->");
    const closingIndex = html.indexOf("</script>", openingIndex);
    expect(openingIndex).toBeGreaterThan(0);
    expect(markerIndex).toBeGreaterThan(openingIndex);
    expect(closingIndex).toBe(markerIndex - "</script>".length);
    expect(html.indexOf(opening, openingIndex + 1)).toBe(-1);
    expect(html).not.toContain("local:/Users/example");
    expect(html).not.toContain("</script><script>alert(1)</script>");

    const payloadText = html.slice(openingIndex + opening.length, closingIndex);
    const payload = CallFlowUiPayloadSchema.parse(JSON.parse(payloadText) as unknown);
    expect(payload.capability.sourceByteBudget).toBe(0);
    expect(payload.snapshot.nodes[0]?.label).toBe("[redacted-sensitive-text]");
  });
});

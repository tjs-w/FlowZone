import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  CallFlowError,
  GraftAdapter,
  MAX_GRAFT_RELATIONSHIPS,
  RepositoryPolicy,
  fingerprintGraftIndex,
  isExcludedRepositoryPath,
  parseGraftReadResponse,
  parseGraftSpan,
  utf8ByteOffsetToSourceColumn,
  type ProcessRequest,
  type ProcessResult,
  type ProcessRunner,
  type RepositoryContext,
} from "../src/index.js";
import type { WorkflowAnchor } from "@callflow/contracts";

const fixtureRoot = resolve(import.meta.dir, "../../../tests/fixtures/callflow/graft-0.18");
let fixtureIndexRoot = "";
let repository: RepositoryContext;

class FixtureRepositoryPolicy extends RepositoryPolicy {
  override resolveRepository(): Promise<RepositoryContext> {
    return Promise.resolve(repository);
  }
}

beforeAll(async () => {
  fixtureIndexRoot = await realpath(await mkdtemp(join(tmpdir(), "callflow-graft-index-")));
  await mkdir(join(fixtureIndexRoot, "graft/.graph"), { recursive: true });
  await writeFile(
    join(fixtureIndexRoot, "graft/.graph/wiring.json"),
    '{"meta":{"version":1},"nodes":[],"edges":[]}\n',
  );
  repository = {
    root: fixtureIndexRoot,
    revision: {
      identity: `local:${fixtureIndexRoot}`,
      commit: "0123456789abcdef",
      dirtyDigest: `sha256:${"0".repeat(64)}`,
    },
  };
});

afterAll(async () => {
  if (fixtureIndexRoot) await rm(fixtureIndexRoot, { force: true, recursive: true });
});

function runnerForCheck(
  check: string,
  checkExitCode = 0,
): { runner: ProcessRunner; requests: ProcessRequest[] } {
  const requests: ProcessRequest[] = [];
  const runner: ProcessRunner = (request) => {
    requests.push(request);
    const result: ProcessResult =
      request.args[0] === "--version"
        ? { exitCode: 0, stdout: "0.18.0\n", stderr: "" }
        : { exitCode: checkExitCode, stdout: check, stderr: "index drift\n" };
    return Promise.resolve(result);
  };
  return { runner, requests };
}

describe("Graft 0.18 status", () => {
  test("treats a static graph as ready despite missing context and pending summaries", async () => {
    const check = await readFile(resolve(fixtureRoot, "check-static-ready-pending.json"), "utf8");
    const { runner, requests } = runnerForCheck(check);
    const adapter = new GraftAdapter({ graftExecutable: "/fixture/graft", runner });

    const status = await adapter.statusForRepository(repository);

    expect(status.state).toBe("ready");
    expect(status.fresh).toBe(true);
    expect(status.adapter.indexRevision).toStartWith("sha256:");
    expect(requests.map((request) => request.args)).toEqual([
      ["--version"],
      ["check", "--json", "--", repository.root],
    ]);
  });

  test("parses valid drift JSON even when Graft check exits nonzero", async () => {
    const check = JSON.stringify({
      context: { ok: false, missing: true },
      graph: {
        ok: true,
        missing: false,
        added: ["new-symbol"],
        removed: [],
        changed: [],
        stale: [],
        pending: 12,
      },
    });
    const { runner } = runnerForCheck(check, 1);
    const adapter = new GraftAdapter({ graftExecutable: "/fixture/graft", runner });

    const status = await adapter.statusForRepository(repository);

    expect(status.state).toBe("stale");
    expect(status.fresh).toBe(false);
    expect(status.adapter.indexRevision).toStartWith("sha256:");
  });

  test("classifies malformed check output as failed", async () => {
    const { runner } = runnerForCheck("not-json", 1);
    const adapter = new GraftAdapter({ graftExecutable: "/fixture/graft", runner });

    const status = await adapter.statusForRepository(repository);

    expect(status).toMatchObject({ state: "failed", compatible: true, fresh: false });
  });

  test("distinguishes actual index contents when status documents are identical", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "callflow-graft-distinct-")));
    try {
      const indexPath = join(root, "graft/.graph/wiring.json");
      await mkdir(join(root, "graft/.graph"), { recursive: true });
      await writeFile(indexPath, '{"meta":{"version":1},"nodes":[{"id":"first"}]}\n');
      const check = await readFile(resolve(fixtureRoot, "check-clean.json"), "utf8");
      const { runner } = runnerForCheck(check);
      const context: RepositoryContext = {
        root,
        revision: {
          identity: `local:${root}`,
          commit: "fixture-commit",
          dirtyDigest: `sha256:${"0".repeat(64)}`,
        },
      };
      const adapter = new GraftAdapter({ graftExecutable: "/fixture/graft", runner });

      const first = await adapter.statusForRepository(context);
      await writeFile(indexPath, '{"meta":{"version":1},"nodes":[{"id":"other"}]}\n');
      const second = await adapter.statusForRepository(context);

      expect(first.state).toBe("ready");
      expect(second.state).toBe("ready");
      expect(first.adapter.indexRevision).not.toBe(second.adapter.indexRevision);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("classifies a status-clean repository with no structural index as stale", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "callflow-graft-missing-")));
    try {
      const check = await readFile(resolve(fixtureRoot, "check-clean.json"), "utf8");
      const { runner } = runnerForCheck(check);
      const context: RepositoryContext = {
        root,
        revision: {
          identity: `local:${root}`,
          commit: "fixture-commit",
          dirtyDigest: `sha256:${"0".repeat(64)}`,
        },
      };
      const adapter = new GraftAdapter({ graftExecutable: "/fixture/graft", runner });

      expect(await fingerprintGraftIndex(context)).toBeUndefined();
      const status = await adapter.statusForRepository(context);

      expect(status).toMatchObject({
        state: "stale",
        fresh: false,
        adapter: { indexRevision: "unavailable" },
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("cancels while reading the structural index", async () => {
    let abortChecks = 0;
    const signal = {
      get aborted() {
        abortChecks += 1;
        return abortChecks >= 6;
      },
    } as AbortSignal;

    let failure: unknown;
    try {
      await fingerprintGraftIndex(repository, signal);
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "aborted", retryable: true });
    expect(abortChecks).toBeGreaterThanOrEqual(6);
  });
});

describe("Graft response and workflow boundaries", () => {
  test("converts ripgrep UTF-8 byte offsets to exact source columns", () => {
    const line = "prefix café😀 suffix";
    const expected = "café😀";
    const startByte = Buffer.byteLength("prefix ", "utf8");
    const endByte = startByte + Buffer.byteLength(expected, "utf8");
    const startColumn = utf8ByteOffsetToSourceColumn(line, startByte);
    const endColumn = utf8ByteOffsetToSourceColumn(line, endByte);

    expect(line.slice(startColumn - 1, endColumn - 1)).toBe(expected);
    expect(line.slice(startColumn - 1, endColumn - 1)).not.toContain("prefix");
    expect(line.slice(startColumn - 1, endColumn - 1)).not.toContain("suffix");
  });

  test("validates every read-command path and span", async () => {
    const valid = await readFile(resolve(fixtureRoot, "skeleton.json"), "utf8");
    expect(parseGraftReadResponse("skeleton", valid)).toMatchObject({ file: "src/outbox.ts" });
    expect(
      parseGraftReadResponse(
        "map",
        JSON.stringify({
          totals: { files: 0, symbols: 0, edges: 0, languages: [] },
          dirs: [],
          hotspots: [],
          dropped: 0,
        }),
      ),
    ).toMatchObject({ dropped: 0 });
    expect(
      parseGraftReadResponse("ask", JSON.stringify({ query: "entry", mode: "empty", hits: [] })),
    ).toMatchObject({ mode: "empty" });
    expect(
      parseGraftReadResponse(
        "grep",
        JSON.stringify({
          pattern: "entry",
          filesSearched: 0,
          totalHits: 0,
          groups: [],
          truncated: false,
        }),
      ),
    ).toMatchObject({ totalHits: 0 });
    expect(() =>
      parseGraftReadResponse(
        "skeleton",
        JSON.stringify({
          file: "../outside.ts",
          entries: [{ name: "bad", kind: "function", span: "1:2", signature: null }],
        }),
      ),
    ).toThrow("unsupported JSON shape");
    expect(parseGraftSpan("L7-L11")).toEqual({
      start: { line: 7, column: 1 },
      end: { line: 11, column: 10_000_000 },
    });
  });

  test("runs every supported read command as bounded JSON with no refresh", async () => {
    const check = await readFile(resolve(fixtureRoot, "check-clean.json"), "utf8");
    const skeleton = await readFile(resolve(fixtureRoot, "skeleton.json"), "utf8");
    const outputs: Readonly<Record<string, string>> = {
      map: JSON.stringify({
        totals: { files: 0, symbols: 0, edges: 0, languages: [] },
        dirs: [],
        hotspots: [],
        dropped: 0,
      }),
      ask: JSON.stringify({ query: "entry", mode: "empty", hits: [] }),
      grep: JSON.stringify({
        pattern: "entry",
        filesSearched: 0,
        totalHits: 0,
        groups: [],
        truncated: false,
      }),
      skeleton,
    };
    const requests: ProcessRequest[] = [];
    const runner: ProcessRunner = (request) => {
      requests.push(request);
      const command = request.args[0] ?? "";
      if (command === "--version") {
        return Promise.resolve({ exitCode: 0, stdout: "0.18.0", stderr: "" });
      }
      if (command === "check") {
        return Promise.resolve({ exitCode: 0, stdout: check, stderr: "" });
      }
      return Promise.resolve({ exitCode: 0, stdout: outputs[command] ?? "", stderr: "" });
    };
    class ResolvedPolicy extends RepositoryPolicy {
      override resolveRepository(): Promise<RepositoryContext> {
        return Promise.resolve(repository);
      }
    }
    const adapter = new GraftAdapter({
      graftExecutable: "/fixture/graft",
      runner,
      repositoryPolicy: new ResolvedPolicy({ runner }),
    });

    await adapter.readJson(repository.root, { command: "map" });
    await adapter.readJson(repository.root, { command: "ask", value: "entry" });
    await adapter.readJson(repository.root, { command: "grep", value: "entry" });
    await adapter.readJson(repository.root, { command: "skeleton", value: "src/outbox.ts" });

    const readRequests = requests.filter((request) => outputs[request.args[0] ?? ""] !== undefined);
    expect(readRequests.map((request) => request.args[0])).toEqual([
      "map",
      "ask",
      "grep",
      "skeleton",
    ]);
    for (const request of readRequests) {
      expect(request.args).toContain("--json");
      expect(request.args).toContain("--no-refresh");
      expect(request.maximumOutputBytes).toBe(8 * 1024 * 1024);
    }
  });

  test("matches only the documented fixed exclusion subset", () => {
    const exclusions = ["**/*_test.go", "test/**", "src/generated.go"];
    expect(isExcludedRepositoryPath("internal/worker_test.go", exclusions)).toBe(true);
    expect(isExcludedRepositoryPath("test/integration/worker.go", exclusions)).toBe(true);
    expect(isExcludedRepositoryPath("src/generated.go", exclusions)).toBe(true);
    expect(isExcludedRepositoryPath("internal/worker.go", exclusions)).toBe(false);
    expect(() => isExcludedRepositoryPath("src/worker.go", ["**/[Tt]est/**"])).toThrow(
      "Unsupported safe path exclusion",
    );
  });

  test("propagates stages, excludes test paths, and stops at a sink", async () => {
    const check = await readFile(resolve(fixtureRoot, "check-static-ready-pending.json"), "utf8");
    let checkOutput = check;
    const symbol = (name: string, path: string) => ({
      id: `${path}#${name}`,
      name,
      kind: "function",
      path,
      span: "L1-L2",
    });
    const responses: Readonly<Record<string, unknown>> = {
      Entry: {
        query: "Entry",
        matches: [
          {
            symbol: symbol("Entry", "src/entry.go"),
            hits: [
              { ...symbol("Child", "src/child.go"), relation: "calls", depth: 1 },
              { ...symbol("TestOnly", "test/entry_test.go"), relation: "calls", depth: 1 },
            ],
          },
        ],
      },
      Child: {
        query: "Child",
        matches: [
          {
            symbol: symbol("Child", "src/child.go"),
            hits: [{ ...symbol("Sink", "src/sink.go"), relation: "calls", depth: 1 }],
          },
        ],
      },
      Sink: {
        query: "Sink",
        matches: [
          {
            symbol: symbol("Sink", "src/sink.go"),
            hits: [{ ...symbol("AfterSink", "src/after.go"), relation: "calls", depth: 1 }],
          },
        ],
      },
    };
    const runner: ProcessRunner = (request) => {
      if (request.args[0] === "--version") {
        return Promise.resolve({ exitCode: 0, stdout: "0.18.0\n", stderr: "" });
      }
      if (request.args[0] === "check") {
        return Promise.resolve({ exitCode: 0, stdout: checkOutput, stderr: "" });
      }
      const separator = request.args.indexOf("--");
      const query = request.args[separator + 1] ?? "";
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify(responses[query] ?? { query, matches: [] }),
        stderr: "",
      });
    };
    class SourcePolicy extends FixtureRepositoryPolicy {
      override readSource(): Promise<Buffer> {
        return Promise.resolve(Buffer.from("package fixture\n"));
      }
    }
    const anchors: WorkflowAnchor[] = [
      {
        id: "entry",
        label: "Entry",
        role: "entry",
        nodeKind: "function",
        selector: { type: "symbol", value: "Entry" },
        stageId: "accept",
      },
      {
        id: "sink",
        label: "Sink",
        role: "sink",
        nodeKind: "function",
        selector: { type: "symbol", value: "Sink" },
        stageId: "deliver",
      },
    ];
    const adapter = new GraftAdapter({
      graftExecutable: "/fixture/graft",
      runner,
      repositoryPolicy: new SourcePolicy({ runner }),
    });

    const draft = await adapter.discoverDraft(repository, {
      anchors,
      exclusions: ["**/*_test.go", "test/**"],
      depth: 3,
      maximumNodes: 25,
    });

    expect(draft.nodes.map((node) => node.label).sort()).toEqual(["Child", "Entry", "Sink"]);
    expect(draft.nodes.find((node) => node.label === "Child")?.stageId).toBe("accept");
    expect(draft.nodes.find((node) => node.label === "Sink")?.stageId).toBe("deliver");
    expect(draft.edges).toHaveLength(2);
    expect(draft.extraction).toMatchObject({ status: "succeeded" });
    expect(draft.runtimeEvidence).toMatchObject({ status: "unavailable" });
    expect(JSON.stringify(draft)).not.toContain("AfterSink");
    expect(JSON.stringify(draft)).not.toContain("TestOnly");

    checkOutput = `${check}\n`;
    const afterIndexRefresh = await adapter.discoverDraft(repository, {
      anchors,
      exclusions: ["**/*_test.go", "test/**"],
      depth: 3,
      maximumNodes: 25,
    });
    expect(afterIndexRefresh.adapter.indexRevision).toBe(draft.adapter.indexRevision);
    expect(afterIndexRefresh.evidence.map((item) => item.key)).toEqual(
      draft.evidence.map((item) => item.key),
    );
  });

  test("leaves a shared callee ungrouped when origin stages conflict", async () => {
    const check = await readFile(resolve(fixtureRoot, "check-clean.json"), "utf8");
    const runner: ProcessRunner = (request) => {
      if (request.args[0] === "--version") {
        return Promise.resolve({ exitCode: 0, stdout: "0.18.0", stderr: "" });
      }
      if (request.args[0] === "check") {
        return Promise.resolve({ exitCode: 0, stdout: check, stderr: "" });
      }
      const separator = request.args.indexOf("--");
      const query = request.args[separator + 1] ?? "";
      const rootSymbol = {
        id: `src/${query}.go#${query}`,
        name: query,
        kind: "function",
        path: `src/${query}.go`,
        span: "L1",
      };
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          query,
          matches: [
            {
              symbol: rootSymbol,
              hits: [
                {
                  id: "src/shared.go#Shared",
                  name: "Shared",
                  kind: "function",
                  path: "src/shared.go",
                  span: "L1",
                  relation: "calls",
                  depth: 1,
                },
              ],
            },
          ],
        }),
        stderr: "",
      });
    };
    class SourcePolicy extends FixtureRepositoryPolicy {
      override readSource(): Promise<Buffer> {
        return Promise.resolve(Buffer.from("fixture\n"));
      }
    }
    const anchors: WorkflowAnchor[] = ["Alpha", "Beta"].map((name, index) => ({
      id: name.toLowerCase(),
      label: name,
      role: "entry",
      nodeKind: "function",
      selector: { type: "symbol", value: name },
      stageId: index === 0 ? "one" : "two",
    }));
    const adapter = new GraftAdapter({
      graftExecutable: "/fixture/graft",
      runner,
      repositoryPolicy: new SourcePolicy({ runner }),
    });

    const draft = await adapter.discoverDraft(repository, {
      anchors,
      depth: 1,
      maximumNodes: 25,
    });

    expect(draft.nodes.find((node) => node.label === "Shared")?.stageId).toBeUndefined();
    expect(draft.warnings.some((warning) => warning.code === "stage-conflict")).toBe(true);
  });

  test("sorts bounded Graft matches and hits before retaining nodes", async () => {
    const check = await readFile(resolve(fixtureRoot, "check-clean.json"), "utf8");
    let reverse = false;
    const symbol = (id: string, name: string) => ({
      id,
      name,
      kind: "function",
      path: id.slice(0, id.indexOf("#")),
      span: "L1",
    });
    const roots = [
      {
        symbol: symbol("src/a.go#Entry", "Entry"),
        hits: [
          { ...symbol("src/c.go#CChild", "CChild"), relation: "calls", depth: 1 },
          { ...symbol("src/b.go#BChild", "BChild"), relation: "calls", depth: 1 },
        ],
      },
      {
        symbol: symbol("src/z.go#Entry", "Entry"),
        hits: [{ ...symbol("src/y.go#YChild", "YChild"), relation: "calls", depth: 1 }],
      },
    ];
    const runner: ProcessRunner = (request) => {
      if (request.args[0] === "--version") {
        return Promise.resolve({ exitCode: 0, stdout: "0.18.0", stderr: "" });
      }
      if (request.args[0] === "check") {
        return Promise.resolve({ exitCode: 0, stdout: check, stderr: "" });
      }
      reverse = !reverse;
      const matches = (reverse ? [...roots].reverse() : [...roots]).map((match) => ({
        ...match,
        hits: reverse ? [...match.hits].reverse() : match.hits,
      }));
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({ query: "Entry", matches }),
        stderr: "",
      });
    };
    class SourcePolicy extends FixtureRepositoryPolicy {
      override readSource(): Promise<Buffer> {
        return Promise.resolve(Buffer.from("fixture\n"));
      }
    }
    const adapter = new GraftAdapter({
      graftExecutable: "/fixture/graft",
      runner,
      repositoryPolicy: new SourcePolicy({ runner }),
    });
    const options = {
      anchors: [
        {
          id: "entry",
          label: "Entry",
          role: "entry" as const,
          nodeKind: "function" as const,
          selector: { type: "symbol" as const, value: "Entry" },
        },
      ],
      depth: 1,
      maximumNodes: 2,
    };

    const first = await adapter.discoverDraft(repository, options);
    const second = await adapter.discoverDraft(repository, options);

    expect(first).toEqual(second);
    expect(first.nodes.map((node) => node.qualifiedName)).toEqual([
      "src/a.go#Entry",
      "src/b.go#BChild",
    ]);
    expect(first.warnings.some((warning) => warning.code === "node-limit")).toBe(true);
  });

  test("sorts source-literal matches before assigning a bounded anchor", async () => {
    const staleCheck = JSON.stringify({
      context: { ok: false, missing: true },
      graph: { ok: false, missing: true, added: [], removed: [], changed: [], stale: [] },
    });
    let reverse = false;
    const ripgrepRequests: ProcessRequest[] = [];
    const matchEvent = (path: string) =>
      JSON.stringify({
        type: "match",
        data: {
          path: { text: path },
          lines: { text: "Entry\n" },
          line_number: 1,
          submatches: [{ start: 0, end: 5 }],
        },
      });
    const runner: ProcessRunner = (request) => {
      if (request.executable === "/fixture/graft" && request.args[0] === "--version") {
        return Promise.resolve({ exitCode: 0, stdout: "0.18.0", stderr: "" });
      }
      if (request.executable === "/fixture/graft") {
        return Promise.resolve({ exitCode: 1, stdout: staleCheck, stderr: "stale" });
      }
      ripgrepRequests.push(request);
      reverse = !reverse;
      const paths = reverse ? ["z/entry.ts", "a/entry.ts"] : ["a/entry.ts", "z/entry.ts"];
      return Promise.resolve({
        exitCode: 0,
        stdout: `${paths.map(matchEvent).join("\n")}\n`,
        stderr: "",
      });
    };
    class SourcePolicy extends FixtureRepositoryPolicy {
      override readSource(): Promise<Buffer> {
        return Promise.resolve(Buffer.from("Entry\n"));
      }
    }
    const adapter = new GraftAdapter({
      graftExecutable: "/fixture/graft",
      ripgrepExecutable: "/fixture/rg",
      runner,
      repositoryPolicy: new SourcePolicy({ runner }),
    });
    const options = {
      anchors: [
        {
          id: "entry",
          label: "Entry",
          role: "entry" as const,
          nodeKind: "function" as const,
          selector: { type: "symbol" as const, value: "Entry" },
        },
      ],
      depth: 1,
      maximumNodes: 1,
    };

    const first = await adapter.discoverDraft(repository, options);
    const second = await adapter.discoverDraft(repository, options);

    expect(first).toEqual(second);
    expect(first.evidence[0]?.source).toMatchObject({ path: "a/entry.ts" });
    expect(first.extraction).toMatchObject({ status: "succeeded" });
    expect(ripgrepRequests[0]?.args).toContain("--sort");
    expect(ripgrepRequests[0]?.args).toContain("path");
    expect(ripgrepRequests[0]?.args).toContain("!*.generated.json");
  });

  test("ignores generated CallFlow snapshots in source-literal fallback output", async () => {
    const staleCheck = JSON.stringify({
      context: { ok: false, missing: true },
      graph: { ok: false, missing: true, added: [], removed: [], changed: [], stale: [] },
    });
    const matchEvent = (path: string) =>
      JSON.stringify({
        type: "match",
        data: {
          path: { text: path },
          lines: { text: "Entry\n" },
          line_number: 1,
          submatches: [{ start: 0, end: 5 }],
        },
      });
    const runner: ProcessRunner = (request) => {
      if (request.executable === "/fixture/graft" && request.args[0] === "--version") {
        return Promise.resolve({ exitCode: 0, stdout: "0.18.0", stderr: "" });
      }
      if (request.executable === "/fixture/graft") {
        return Promise.resolve({ exitCode: 1, stdout: staleCheck, stderr: "stale" });
      }
      return Promise.resolve({
        exitCode: 0,
        stdout: `${matchEvent("workflow.callflow.generated.json")}\n${matchEvent("src/entry.ts")}\n`,
        stderr: "",
      });
    };
    class SourcePolicy extends FixtureRepositoryPolicy {
      override readSource(): Promise<Buffer> {
        return Promise.resolve(Buffer.from("Entry\n"));
      }
    }
    const adapter = new GraftAdapter({
      graftExecutable: "/fixture/graft",
      ripgrepExecutable: "/fixture/rg",
      runner,
      repositoryPolicy: new SourcePolicy({ runner }),
    });

    const result = await adapter.discoverDraft(repository, {
      anchors: [
        {
          id: "entry",
          label: "Entry",
          role: "entry",
          nodeKind: "function",
          selector: { type: "symbol", value: "Entry" },
        },
      ],
      depth: 1,
      maximumNodes: 10,
    });

    expect(result.nodes).toHaveLength(1);
    expect(result.evidence[0]?.source).toMatchObject({ path: "src/entry.ts" });
  });

  test("retains duplicate calls with exact relationship evidence", async () => {
    const check = await readFile(resolve(fixtureRoot, "check-clean.json"), "utf8");
    const entry = {
      id: "src/entry.go#Entry",
      name: "Entry",
      kind: "function",
      path: "src/entry.go",
      span: "L1-L3",
    };
    const child = {
      id: "src/child.go#Child",
      name: "Child",
      kind: "function",
      path: "src/child.go",
      span: "L5-L7",
      relation: "calls",
      depth: 1,
    };
    const runner: ProcessRunner = (request) => {
      if (request.args[0] === "--version") {
        return Promise.resolve({ exitCode: 0, stdout: "0.18.0", stderr: "" });
      }
      if (request.args[0] === "check") {
        return Promise.resolve({ exitCode: 0, stdout: check, stderr: "" });
      }
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          query: "Entry",
          matches: [{ symbol: entry, hits: [child, child] }],
        }),
        stderr: "",
      });
    };
    class SourcePolicy extends FixtureRepositoryPolicy {
      override readSource(): Promise<Buffer> {
        return Promise.resolve(Buffer.from("fixture\n"));
      }
    }
    const adapter = new GraftAdapter({
      graftExecutable: "/fixture/graft",
      runner,
      repositoryPolicy: new SourcePolicy({ runner }),
    });

    const draft = await adapter.discoverDraft(repository, {
      anchors: [
        {
          id: "entry",
          label: "Entry",
          role: "entry",
          nodeKind: "function",
          selector: { type: "symbol", value: "Entry" },
        },
      ],
      depth: 1,
      maximumNodes: 25,
    });

    expect(draft.edges).toHaveLength(2);
    expect(new Set(draft.edges.map((edge) => edge.key)).size).toBe(2);
    const relationshipEvidence = draft.evidence.filter((item) =>
      item.key.startsWith("relation-evidence_"),
    );
    expect(relationshipEvidence).toHaveLength(2);
    expect(relationshipEvidence.every((item) => item.source.type === "external-reference")).toBe(
      true,
    );
    expect(draft.edges.every((edge) => edge.evidenceKeys.length === 1)).toBe(true);
    expect(draft.warnings.some((warning) => warning.code === "callsite-span-unavailable")).toBe(
      true,
    );
  });

  test("bounds duplicate call relationships across Graft responses", async () => {
    const check = await readFile(resolve(fixtureRoot, "check-clean.json"), "utf8");
    const symbol = (id: string, name: string) => ({
      id,
      name,
      kind: "function",
      path: id.slice(0, id.indexOf("#")),
      span: "L1",
    });
    const entry = symbol("src/entry.go#Entry", "Entry");
    const childA = symbol("src/a.go#A", "A");
    const childB = symbol("src/b.go#B", "B");
    const entryHit = { ...entry, relation: "calls", depth: 1 };
    const relationshipsAfterRoot = MAX_GRAFT_RELATIONSHIPS - 2;
    const childAHits = relationshipsAfterRoot / 2;
    const childBHits = childAHits + 1;
    const callerQueries: string[] = [];
    const runner: ProcessRunner = (request) => {
      if (request.args[0] === "--version") {
        return Promise.resolve({ exitCode: 0, stdout: "0.18.0", stderr: "" });
      }
      if (request.args[0] === "check") {
        return Promise.resolve({ exitCode: 0, stdout: check, stderr: "" });
      }
      const query = request.args.at(-2) ?? "";
      callerQueries.push(query);
      if (query === "Entry") {
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({
            query,
            matches: [
              {
                symbol: entry,
                hits: [
                  { ...childA, relation: "calls", depth: 1 },
                  { ...childB, relation: "calls", depth: 1 },
                ],
              },
            ],
          }),
          stderr: "",
        });
      }
      const child = query === "A" ? childA : childB;
      const hitCount = query === "A" ? childAHits : childBHits;
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          query,
          matches: [{ symbol: child, hits: Array.from({ length: hitCount }, () => entryHit) }],
        }),
        stderr: "",
      });
    };
    class SourcePolicy extends FixtureRepositoryPolicy {
      override readSource(): Promise<Buffer> {
        return Promise.resolve(Buffer.from("fixture\n"));
      }
    }
    const adapter = new GraftAdapter({
      graftExecutable: "/fixture/graft",
      runner,
      repositoryPolicy: new SourcePolicy({ runner }),
    });

    const draft = await adapter.discoverDraft(repository, {
      anchors: [
        {
          id: "entry",
          label: "Entry",
          role: "entry",
          nodeKind: "function",
          selector: { type: "symbol", value: "Entry" },
        },
      ],
      depth: 2,
      maximumNodes: 4,
    });

    expect(callerQueries).toEqual(["Entry", "A", "B"]);
    expect(draft.edges).toHaveLength(MAX_GRAFT_RELATIONSHIPS);
    expect(draft.evidence).toHaveLength(MAX_GRAFT_RELATIONSHIPS + 3);
    expect(draft.warnings).toContainEqual({
      code: "edge-limit",
      message: `Discovery was limited to ${String(MAX_GRAFT_RELATIONSHIPS)} Graft call relationships. Narrow the workflow anchors or depth to inspect omitted relationships.`,
      retryable: false,
    });
  });

  test("fails retryably when the Graft index changes during traversal", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "callflow-graft-drift-")));
    const indexPath = join(root, "graft/.graph/wiring.json");
    try {
      await mkdir(join(root, "graft/.graph"), { recursive: true });
      await writeFile(indexPath, '{"meta":{"version":1},"nodes":[{"id":"before"}]}\n');
      const context: RepositoryContext = {
        root,
        revision: {
          identity: `local:${root}`,
          commit: "fixture-commit",
          dirtyDigest: `sha256:${"0".repeat(64)}`,
        },
      };
      const check = await readFile(resolve(fixtureRoot, "check-clean.json"), "utf8");
      let indexMutated = false;
      const runner: ProcessRunner = async (request) => {
        if (request.args[0] === "--version") {
          return { exitCode: 0, stdout: "0.18.0", stderr: "" };
        }
        if (request.args[0] === "check") {
          return { exitCode: 0, stdout: check, stderr: "" };
        }
        await writeFile(indexPath, '{"meta":{"version":1},"nodes":[{"id":"after"}]}\n');
        indexMutated = true;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            query: "Entry",
            matches: [
              {
                symbol: {
                  id: "src/entry.go#Entry",
                  name: "Entry",
                  kind: "function",
                  path: "src/entry.go",
                  span: "L1",
                },
                hits: [],
              },
            ],
          }),
          stderr: "",
        };
      };
      class StablePolicy extends RepositoryPolicy {
        override resolveRepository(): Promise<RepositoryContext> {
          return Promise.resolve(context);
        }

        override readSource(): Promise<Buffer> {
          return Promise.resolve(Buffer.from("fixture\n"));
        }
      }
      const adapter = new GraftAdapter({
        graftExecutable: "/fixture/graft",
        runner,
        repositoryPolicy: new StablePolicy({ runner }),
      });

      let failure: unknown;
      try {
        await adapter.discoverDraft(context, {
          anchors: [
            {
              id: "entry",
              label: "Entry",
              role: "entry",
              nodeKind: "function",
              selector: { type: "symbol", value: "Entry" },
            },
          ],
          depth: 1,
          maximumNodes: 25,
        });
      } catch (error: unknown) {
        failure = error;
      }

      expect(indexMutated).toBe(true);
      expect(failure).toMatchObject({ code: "adapter_stale", retryable: true });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("fails retryably when the reported Graft index changes during source-literal fallback", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "callflow-fallback-drift-")));
    const indexPath = join(root, "graft/.graph/wiring.json");
    try {
      await mkdir(join(root, "graft/.graph"), { recursive: true });
      await writeFile(indexPath, '{"meta":{"version":1},"nodes":[{"id":"before"}]}\n');
      const context: RepositoryContext = {
        root,
        revision: {
          identity: `local:${root}`,
          commit: "fixture-commit",
          dirtyDigest: `sha256:${"0".repeat(64)}`,
        },
      };
      const staleCheck = JSON.stringify({
        context: { ok: false, missing: true },
        graph: { ok: false, missing: false, added: [], removed: [], changed: [], stale: ["x"] },
      });
      const match = JSON.stringify({
        type: "match",
        data: {
          path: { text: "src/entry.ts" },
          lines: { text: "Entry\n" },
          line_number: 1,
          submatches: [{ start: 0, end: 5 }],
        },
      });
      let indexMutated = false;
      const runner: ProcessRunner = async (request) => {
        if (request.executable === "/fixture/graft" && request.args[0] === "--version") {
          return { exitCode: 0, stdout: "0.18.0", stderr: "" };
        }
        if (request.executable === "/fixture/graft") {
          return { exitCode: 1, stdout: staleCheck, stderr: "stale" };
        }
        await writeFile(indexPath, '{"meta":{"version":1},"nodes":[{"id":"after"}]}\n');
        indexMutated = true;
        return { exitCode: 0, stdout: `${match}\n`, stderr: "" };
      };
      class StablePolicy extends RepositoryPolicy {
        override resolveRepository(): Promise<RepositoryContext> {
          return Promise.resolve(context);
        }

        override readSource(): Promise<Buffer> {
          return Promise.resolve(Buffer.from("Entry\n"));
        }
      }
      const adapter = new GraftAdapter({
        graftExecutable: "/fixture/graft",
        ripgrepExecutable: "/fixture/rg",
        runner,
        repositoryPolicy: new StablePolicy({ runner }),
      });

      let failure: unknown;
      try {
        await adapter.discoverDraft(context, {
          anchors: [
            {
              id: "entry",
              label: "Entry",
              role: "entry",
              nodeKind: "function",
              selector: { type: "symbol", value: "Entry" },
            },
          ],
          depth: 1,
          maximumNodes: 25,
        });
      } catch (error: unknown) {
        failure = error;
      }

      expect(indexMutated).toBe(true);
      expect(failure).toMatchObject({ code: "adapter_stale", retryable: true });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("fails retryably when the repository changes during source-literal fallback", async () => {
    const staleCheck = JSON.stringify({
      context: { ok: false, missing: true },
      graph: { ok: false, missing: true, added: [], removed: [], changed: [], stale: [] },
    });
    const match = JSON.stringify({
      type: "match",
      data: {
        path: { text: "src/entry.ts" },
        lines: { text: "Entry\n" },
        line_number: 1,
        submatches: [{ start: 0, end: 5 }],
      },
    });
    const runner: ProcessRunner = (request) => {
      if (request.executable === "/fixture/graft" && request.args[0] === "--version") {
        return Promise.resolve({ exitCode: 0, stdout: "0.18.0", stderr: "" });
      }
      if (request.executable === "/fixture/graft") {
        return Promise.resolve({ exitCode: 1, stdout: staleCheck, stderr: "stale" });
      }
      return Promise.resolve({ exitCode: 0, stdout: `${match}\n`, stderr: "" });
    };
    const changedRepository: RepositoryContext = {
      ...repository,
      revision: {
        ...repository.revision,
        dirtyDigest: `sha256:${"1".repeat(64)}`,
      },
    };
    class ChangingPolicy extends RepositoryPolicy {
      override resolveRepository(): Promise<RepositoryContext> {
        return Promise.resolve(changedRepository);
      }

      override readSource(): Promise<Buffer> {
        return Promise.resolve(Buffer.from("Entry\n"));
      }
    }
    const adapter = new GraftAdapter({
      graftExecutable: "/fixture/graft",
      ripgrepExecutable: "/fixture/rg",
      runner,
      repositoryPolicy: new ChangingPolicy({ runner }),
    });

    let failure: unknown;
    try {
      await adapter.discoverDraft(repository, {
        anchors: [
          {
            id: "entry",
            label: "Entry",
            role: "entry",
            nodeKind: "function",
            selector: { type: "symbol", value: "Entry" },
          },
        ],
        depth: 1,
        maximumNodes: 25,
      });
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "source_changed", retryable: true });
  });

  test("distinguishes failed Graft extraction from a healthy empty result", async () => {
    const check = await readFile(resolve(fixtureRoot, "check-clean.json"), "utf8");
    let callersFail = true;
    const runner: ProcessRunner = (request) => {
      if (request.args[0] === "--version") {
        return Promise.resolve({ exitCode: 0, stdout: "0.18.0", stderr: "" });
      }
      if (request.args[0] === "check") {
        return Promise.resolve({ exitCode: 0, stdout: check, stderr: "" });
      }
      return Promise.resolve(
        callersFail
          ? { exitCode: 1, stdout: "", stderr: "failed" }
          : { exitCode: 0, stdout: JSON.stringify({ query: "Entry", matches: [] }), stderr: "" },
      );
    };
    const adapter = new GraftAdapter({
      graftExecutable: "/fixture/graft",
      runner,
      repositoryPolicy: new FixtureRepositoryPolicy({ runner }),
    });
    const options = {
      anchors: [
        {
          id: "entry",
          label: "Entry",
          role: "entry" as const,
          nodeKind: "function" as const,
          selector: { type: "symbol" as const, value: "Entry" },
        },
      ],
      depth: 1,
      maximumNodes: 25,
    };

    const failed = await adapter.discoverDraft(repository, options);
    callersFail = false;
    const empty = await adapter.discoverDraft(repository, options);

    expect(failed.extraction).toEqual({
      status: "failed",
      code: "graft-query-failed",
      retryable: true,
    });
    expect(failed.warnings.some((warning) => warning.code === "graft-query-failed")).toBe(true);
    expect(empty.extraction).toEqual({ status: "succeeded", items: [] });
  });

  test("propagates cancellation into adapter evidence reads", async () => {
    const check = await readFile(resolve(fixtureRoot, "check-clean.json"), "utf8");
    const controller = new AbortController();
    const runner: ProcessRunner = (request) => {
      if (request.args[0] === "--version") {
        return Promise.resolve({ exitCode: 0, stdout: "0.18.0", stderr: "" });
      }
      if (request.args[0] === "check") {
        return Promise.resolve({ exitCode: 0, stdout: check, stderr: "" });
      }
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          query: "Entry",
          matches: [
            {
              symbol: {
                id: "src/entry.go#Entry",
                name: "Entry",
                kind: "function",
                path: "src/entry.go",
                span: "L1",
              },
              hits: [],
            },
          ],
        }),
        stderr: "",
      });
    };
    class CancellingSourcePolicy extends FixtureRepositoryPolicy {
      override readSource(_root: string, _path: string, signal?: AbortSignal): Promise<Buffer> {
        expect(signal).toBe(controller.signal);
        controller.abort();
        throw new CallFlowError("aborted", "cancelled", true);
      }
    }
    const adapter = new GraftAdapter({
      graftExecutable: "/fixture/graft",
      runner,
      repositoryPolicy: new CancellingSourcePolicy({ runner }),
    });

    let failure: unknown;
    try {
      await adapter.discoverDraft(repository, {
        anchors: [
          {
            id: "entry",
            label: "Entry",
            role: "entry",
            nodeKind: "function",
            selector: { type: "symbol", value: "Entry" },
          },
        ],
        depth: 1,
        maximumNodes: 25,
        signal: controller.signal,
      });
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "aborted", retryable: true });
  });
});

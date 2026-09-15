import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import {
  CallFlowSourceExcerptSchema,
  CallFlowUiPayloadSchema,
  WorkflowManifestSchema,
} from "@callflow/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const workspaceRoot = resolve(import.meta.dir, "../..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  return value as Readonly<Record<string, unknown>>;
}

function toolVisibility(value: unknown): unknown {
  return record(record(value)["ui"])["visibility"];
}

async function git(args: readonly string[]): Promise<void> {
  await execFileAsync(process.platform === "win32" ? "git.exe" : "/usr/bin/git", [...args], {
    env: { PATH: process.env["PATH"] ?? "" },
    timeout: 10_000,
  });
}

function launcherInvocation(
  launcher: string,
  args: readonly string[] = [],
): { readonly command: string; readonly args: readonly string[] } {
  if (process.platform !== "win32") return { command: launcher, args };
  if ([launcher, ...args].some((value) => value.includes('"'))) {
    throw new Error("Windows launcher test arguments cannot contain double quotes.");
  }
  const commandLine = `call "${launcher}"${args.map((value) => ` "${value}"`).join("")}`;
  return {
    command: process.env["ComSpec"] ?? "cmd.exe",
    args: ["/d", "/s", "/c", commandLine],
  };
}

describe("CallFlow in the shared FlowZone stdio server", () => {
  test("uses only the shared model router while graph and source data stay private", async () => {
    const repository = await mkdtemp(join(tmpdir(), "callflow-stdio-"));
    temporaryDirectories.push(repository);
    const canonicalRepository = await realpath(repository);
    await git(["init", "--quiet", repository]);
    await git(["-C", repository, "config", "user.email", "callflow@example.invalid"]);
    await git(["-C", repository, "config", "user.name", "CallFlow Test"]);
    await writeFile(
      join(repository, "workflow.ts"),
      "export function selectedEntry(): string {\n  return 'private-source-marker';\n}\n",
    );
    await git(["-C", repository, "add", "workflow.ts"]);
    await git(["-C", repository, "commit", "--quiet", "-m", "fixture"]);

    const dataDirectory = await mkdtemp(join(tmpdir(), "callflow-flowzone-data-"));
    temporaryDirectories.push(dataDirectory);
    const transport = new StdioClientTransport({
      command: "node",
      args: [resolve(workspaceRoot, "server/dist/server.cjs")],
      cwd: repository,
      env: { FLOWZONE_DATA_DIR: dataDirectory, PATH: process.env["PATH"] ?? "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "callflow-stdio-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      expect(client.getServerVersion()?.name).toBe("flowzone");
      expect(client.getInstructions()).toContain("one router tool");

      const listed = await client.listTools();
      const modelTools = listed.tools.filter(
        (tool) => JSON.stringify(toolVisibility(tool._meta)) === JSON.stringify(["model"]),
      );
      expect(modelTools.map((tool) => tool.name)).toEqual([
        "flowzone",
        "render_markdown_review",
        "render_dyna_dashboard",
      ]);
      const routerSchema = JSON.stringify(
        listed.tools.find((tool) => tool.name === "flowzone")?.inputSchema,
      );
      expect(routerSchema).toContain('"callflow"');
      expect(Buffer.byteLength(routerSchema, "utf8")).toBeLessThanOrEqual(8 * 1024);
      for (const removedName of [
        "callflow_discover",
        "render_callflow",
        "callflow_query",
        "callflow_validate",
        "callflow_diff",
        "callflow_export",
      ]) {
        expect(listed.tools.some((tool) => tool.name === removedName)).toBe(false);
      }
      for (const name of [
        "callflow_expand",
        "callflow_get_source",
        "callflow_search",
        "callflow_find_path",
        "callflow_relayout",
        "callflow_describe_visible",
      ]) {
        const tool = listed.tools.find((candidate) => candidate.name === name);
        expect(toolVisibility(tool?._meta)).toEqual(["app"]);
      }

      const resources = await client.listResources();
      expect(resources.resources.map((resource) => resource.uri)).toContain(
        "ui://flowzone/callflow/v1.html",
      );
      expect(resources.resources.map((resource) => resource.uri)).toContain(
        "ui://callflow/workflow/v1.html",
      );
      const resource = await client.readResource({ uri: "ui://flowzone/callflow/v1.html" });
      const content = resource.contents[0];
      expect(content?.mimeType).toBe("text/html;profile=mcp-app");
      const html = content && "text" in content ? content.text : "";
      expect(html).toContain('id="callflow-root"');
      expect(html).not.toContain("CALLFLOW_APP");

      const manifest = WorkflowManifestSchema.parse({
        schemaVersion: "callflow/workflow-manifest-v1",
        id: "stdio-workflow",
        name: "Stdio workflow",
        repository: { identity: `local:${repository}` },
        anchors: [
          {
            id: "selected-entry",
            label: "selectedEntry",
            role: "entry",
            nodeKind: "function",
            selector: { type: "symbol", value: "selectedEntry" },
            stageId: "execute",
          },
        ],
        stages: [{ id: "execute", label: "Execute", order: 0 }],
        exclusions: [],
        acceptedSemanticLinks: [],
        presentation: { direction: "RIGHT", defaultOverlay: "none" },
      });
      const validated = await client.callTool({
        name: "flowzone",
        arguments: { plugin: "callflow", action: "validate", input: { manifest } },
      });
      expect(validated.isError).toBeUndefined();
      const validatedEnvelope = record(validated.structuredContent);
      expect(validatedEnvelope).toMatchObject({ plugin: "callflow", action: "validate" });
      expect(record(validatedEnvelope["result"])["valid"]).toBe(true);

      const discovered = await client.callTool({
        name: "flowzone",
        arguments: {
          plugin: "callflow",
          action: "discover",
          input: { repositoryPath: repository, entries: ["selectedEntry"] },
        },
      });
      expect(discovered.isError).toBeUndefined();
      const discoveredEnvelope = record(discovered.structuredContent);
      expect(discoveredEnvelope).toMatchObject({ plugin: "callflow", action: "discover" });
      const summary = record(discoveredEnvelope["result"]);
      const sessionId = summary["sessionId"];
      const graphRevision = summary["graphRevision"];
      if (typeof sessionId !== "string" || typeof graphRevision !== "string") {
        throw new Error("CallFlow discovery did not return session identifiers");
      }
      const extractionStatus = summary["extractionStatus"];
      if (typeof extractionStatus !== "string") {
        throw new Error("CallFlow discovery did not return an extraction status");
      }
      expect(["succeeded", "failed", "unavailable"]).toContain(extractionStatus);
      expect(summary["runtimeEvidenceStatus"]).toBe("unavailable");
      expect(summary["warningCodes"]).toBeArray();
      expect(JSON.stringify(discovered.structuredContent)).not.toContain(repository);
      expect(JSON.stringify(discovered.structuredContent)).not.toContain(canonicalRepository);
      expect(JSON.stringify(discovered.content)).not.toContain("private-source-marker");
      const privateMetadata = record(discovered._meta);
      const flowzoneEnvelope = record(privateMetadata["flowzone"]);
      expect(flowzoneEnvelope).toMatchObject({
        schema: "flowzone/ui-v1",
        plugin: "callflow",
        action: "discover",
        view: "workflow",
      });
      const payload = CallFlowUiPayloadSchema.parse(flowzoneEnvelope["payload"]);
      expect(privateMetadata["callflowGraph"]).toBeUndefined();
      expect(payload.sessionId).toBe(sessionId);
      expect(payload.snapshot.repository.identity).toBe(`local:${canonicalRepository}`);
      expect(JSON.stringify(discovered.structuredContent)).not.toContain(repository);
      expect(JSON.stringify(discovered.structuredContent)).not.toContain(canonicalRepository);
      expect(JSON.stringify(discovered.content)).not.toContain(repository);
      expect(JSON.stringify(discovered.content)).not.toContain(canonicalRepository);

      const sourceEvidence = payload.snapshot.evidence.find(
        (evidence) => evidence.source.type === "source-span",
      );
      let activePayload = payload;
      if (sourceEvidence) {
        const source = await client.callTool({
          name: "callflow_get_source",
          arguments: {
            sessionId,
            capabilityToken: payload.capability.token,
            graphRevision,
            evidenceId: sourceEvidence.id,
            purpose: "Verify the user-selected evidence in this test.",
            maxBytes: 512,
          },
        });
        expect(source.isError).toBeUndefined();
        const excerpt = CallFlowSourceExcerptSchema.parse(record(source._meta)["callflowSource"]);
        expect(excerpt.content).toContain("selectedEntry");
        expect(JSON.stringify(source.structuredContent)).not.toContain(excerpt.content);
        expect(JSON.stringify(source.content)).not.toContain(excerpt.content);
        activePayload = CallFlowUiPayloadSchema.parse(record(source._meta)["callflowGraph"]);
        expect(activePayload.capability.token).not.toBe(payload.capability.token);
      }

      const selectedNode = activePayload.snapshot.nodes.find((node) => node.kind !== "stage");
      const expansion = await client.callTool({
        name: "callflow_expand",
        arguments: {
          sessionId,
          capabilityToken: activePayload.capability.token,
          graphRevision,
          nodeId: selectedNode?.id ?? activePayload.snapshot.nodes[0]?.id,
          direction: "both",
          depth: 1,
          limit: 25,
        },
      });
      expect(expansion.isError).toBeUndefined();
      const expandedPayload = CallFlowUiPayloadSchema.parse(
        record(expansion._meta)["callflowGraph"],
      );
      expect(record(expansion.structuredContent)["nodeIds"]).toBeArray();
      expect(expandedPayload.capability.token).not.toBe(activePayload.capability.token);

      const relayout = await client.callTool({
        name: "callflow_relayout",
        arguments: {
          sessionId,
          capabilityToken: expandedPayload.capability.token,
          graphRevision,
          visibleNodeIds: expandedPayload.snapshot.nodes.map((node) => node.id),
        },
      });
      expect(relayout.isError).toBeUndefined();
      expect(record(relayout.structuredContent)["engine"]).toBe("elk");
      expect(record(relayout.structuredContent)["positions"]).toBeArray();
      const relayoutPayload = CallFlowUiPayloadSchema.parse(
        record(relayout._meta)["callflowGraph"],
      );

      const described = await client.callTool({
        name: "callflow_describe_visible",
        arguments: {
          sessionId,
          capabilityToken: relayoutPayload.capability.token,
          graphRevision,
          visibleNodeIds: relayoutPayload.snapshot.nodes.map((node) => node.id),
        },
      });
      expect(described.isError).toBeUndefined();
      const description = record(described.structuredContent)["description"];
      expect(typeof description).toBe("string");
      expect(String(description)).toContain("selectedEntry");
      expect(String(description)).toContain("evidence=");
      expect(String(description)).not.toContain(repository);
      expect(String(description)).not.toContain(canonicalRepository);
      expect(Buffer.byteLength(String(description), "utf8")).toBeLessThanOrEqual(8_192);

      const queried = await client.callTool({
        name: "flowzone",
        arguments: {
          plugin: "callflow",
          action: "query",
          input: { sessionId, graphRevision, query: { text: "selectedEntry" } },
        },
      });
      expect(queried.isError).toBeUndefined();
      const queryResult = record(record(queried.structuredContent)["result"]);
      expect(queryResult["nodeIds"]).toBeArray();
      expect(queryResult["nodes"]).toBeArray();
      expect(JSON.stringify(queried)).not.toContain(canonicalRepository);

      const diffed = await client.callTool({
        name: "flowzone",
        arguments: {
          plugin: "callflow",
          action: "diff",
          input: { baseSessionId: sessionId, baseGraphRevision: graphRevision },
        },
      });
      expect(diffed.isError).toBeUndefined();
      expect(
        record(record(record(diffed.structuredContent)["result"])["summary"])["unverified"],
      ).toBeGreaterThan(0);

      const exported = await client.callTool({
        name: "flowzone",
        arguments: {
          plugin: "callflow",
          action: "export",
          input: { sessionId, graphRevision, format: "graph-json" },
        },
      });
      expect(exported.isError).toBeUndefined();
      expect(JSON.stringify(exported.structuredContent)).not.toContain(repository);
      expect(JSON.stringify(exported.structuredContent)).not.toContain(canonicalRepository);
      expect(JSON.stringify(exported.content)).not.toContain(repository);
      expect(JSON.stringify(exported.content)).not.toContain(canonicalRepository);
      const exportResult = record(record(exported.structuredContent)["result"]);
      expect(exportResult["schema"]).toBe("callflow/export-result-v1");
      expect(exportResult["content"]).toBeUndefined();
      const exportEnvelope = record(record(exported._meta)["flowzone"]);
      expect(exportEnvelope).toMatchObject({
        schema: "flowzone/ui-v1",
        plugin: "callflow",
        action: "export",
        view: "export",
      });
      const exportPayload = record(exportEnvelope["payload"]);
      expect(exportPayload).toMatchObject({
        schema: "callflow/export-payload-v1",
        graphRevision,
        format: "graph-json",
        contentDigest: exportResult["contentDigest"],
        byteLength: exportResult["byteLength"],
      });
      expect(typeof exportPayload["content"]).toBe("string");
      const exportByteLength = exportResult["byteLength"];
      if (typeof exportByteLength !== "number") {
        throw new Error("CallFlow export did not return a byte length");
      }
      expect(Buffer.byteLength(String(exportPayload["content"]), "utf8")).toBe(exportByteLength);
      expect(String(exportPayload["content"])).not.toContain(repository);
      expect(String(exportPayload["content"])).not.toContain(canonicalRepository);
    } finally {
      await client.close();
    }
  }, 60_000);
});

describe("CallFlow CLI process contract", () => {
  const cliLauncher = resolve(
    workspaceRoot,
    "bin",
    process.platform === "win32" ? "callflow.cmd" : "callflow",
  );

  async function executeCli(args: readonly string[]): Promise<void> {
    const invocation = launcherInvocation(cliLauncher, args);
    await execFileAsync(invocation.command, [...invocation.args], {
      encoding: "utf8",
      timeout: 30_000,
    });
  }

  test("ships hardened POSIX and Windows launchers inside FlowZone", async () => {
    const binRoot = resolve(workspaceRoot, "bin");
    const [cliShell, cliCmd, cliMode] = await Promise.all([
      readFile(resolve(binRoot, "callflow"), "utf8"),
      readFile(resolve(binRoot, "callflow.cmd"), "utf8"),
      stat(resolve(binRoot, "callflow")),
    ]);

    expect(cliShell).toContain("unset NODE_OPTIONS NODE_PATH");
    expect(cliShell).toContain("command -v node");
    expect(cliCmd).toContain('set "NODE_OPTIONS="');
    expect(cliCmd).toContain('set "NODE_PATH="');
    expect(cliCmd).toContain("where.exe node.exe");
    expect(cliCmd).toContain("..\\server\\dist\\callflow.cjs");
    if (process.platform === "win32") {
      expect(cliMode.isFile()).toBe(true);
    } else {
      expect(cliMode.mode & 0o111).not.toBe(0);
    }
  });

  test("returns stable JSON and a nonzero exit for a non-ready adapter", async () => {
    const repository = await mkdtemp(join(tmpdir(), "callflow-cli-status-"));
    temporaryDirectories.push(repository);
    await git(["init", "--quiet", repository]);
    await git(["-C", repository, "config", "user.email", "callflow@example.invalid"]);
    await git(["-C", repository, "config", "user.name", "CallFlow Test"]);
    await writeFile(join(repository, "workflow.ts"), "export const entry = true;\n");
    await git(["-C", repository, "add", "workflow.ts"]);
    await git(["-C", repository, "commit", "--quiet", "-m", "fixture"]);

    let observed:
      { readonly code: number; readonly stdout: string; readonly stderr: string } | undefined;
    try {
      await executeCli(["adapter", "status", "--repo", repository]);
    } catch (error: unknown) {
      const details = record(error);
      if (
        typeof details["code"] !== "number" ||
        typeof details["stdout"] !== "string" ||
        typeof details["stderr"] !== "string"
      ) {
        throw error;
      }
      observed = {
        code: details["code"],
        stdout: details["stdout"],
        stderr: details["stderr"],
      };
    }

    expect(observed?.code).toBe(1);
    expect(observed?.stderr).toBe("");
    const status = record(JSON.parse(observed?.stdout ?? "") as unknown);
    expect(status["schema"]).toBe("callflow/adapter-status-v1");
    expect(status["state"]).not.toBe("ready");
    expect(observed?.stdout.endsWith("\n")).toBe(true);
  }, 60_000);

  test("returns degraded discovery JSON and marks a missing comparison unverified", async () => {
    const repository = await mkdtemp(join(tmpdir(), "callflow-cli-degraded-"));
    temporaryDirectories.push(repository);
    await git(["init", "--quiet", repository]);
    await git(["-C", repository, "config", "user.email", "callflow@example.invalid"]);
    await git(["-C", repository, "config", "user.name", "CallFlow Test"]);
    await writeFile(join(repository, "workflow.ts"), "export const selectedEntry = true;\n");
    await git(["-C", repository, "add", "workflow.ts"]);
    await git(["-C", repository, "commit", "--quiet", "-m", "fixture"]);

    let discoveryFailure: Readonly<Record<string, unknown>> | undefined;
    try {
      await executeCli(["workflow", "discover", "--repo", repository, "--entry", "selectedEntry"]);
    } catch (error: unknown) {
      discoveryFailure = record(error);
    }
    expect(discoveryFailure?.["code"]).toBe(1);
    const discoveryStdout = discoveryFailure?.["stdout"];
    if (typeof discoveryStdout !== "string") throw new Error("Missing discovery JSON output");
    const discoveryOutput = record(JSON.parse(discoveryStdout) as unknown);
    expect(record(discoveryOutput["manifest"])["discoveryBounds"]).toEqual({
      depth: 2,
      maximumNodes: 30,
    });
    const discoveredSnapshot = record(discoveryOutput["snapshot"]);
    expect(record(discoveredSnapshot["extraction"])["status"]).toBeOneOf([
      "succeeded",
      "unavailable",
    ]);
    expect(record(discoveredSnapshot["runtimeEvidence"])["status"]).toBe("unavailable");

    const manifestPath = join(repository, "workflow.callflow.json");
    const manifest = WorkflowManifestSchema.parse({
      schemaVersion: "callflow/workflow-manifest-v1",
      id: "missing-comparison-workflow",
      name: "Missing comparison workflow",
      repository: { identity: "fixture:missing-comparison-workflow" },
      anchors: [
        {
          id: "entry",
          label: "selectedEntry",
          role: "entry",
          nodeKind: "function",
          selector: { type: "symbol", value: "selectedEntry" },
        },
      ],
      stages: [],
      exclusions: [],
      acceptedSemanticLinks: [],
      presentation: { direction: "RIGHT", defaultOverlay: "none" },
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await git(["-C", repository, "add", "workflow.callflow.json"]);
    await git(["-C", repository, "commit", "--quiet", "-m", "add manifest"]);
    const manifestArgument = relative(workspaceRoot, manifestPath);

    const generatedPath = join(repository, "workflow.callflow.generated.json");
    const generatedSnapshots: Buffer[] = [];
    for (let index = 0; index < 2; index += 1) {
      try {
        await executeCli(["workflow", "refresh", "--manifest", manifestArgument, "--write"]);
      } catch (error: unknown) {
        expect(record(error)["code"]).toBe(1);
      }
      generatedSnapshots.push(await readFile(generatedPath));
    }
    expect(generatedSnapshots[1]).toEqual(generatedSnapshots[0]);

    const generatedSnapshot = record(JSON.parse(generatedSnapshots[1]?.toString("utf8") ?? ""));
    const generatedNodes = generatedSnapshot["nodes"];
    if (!Array.isArray(generatedNodes) || generatedNodes.length === 0) {
      throw new Error("Missing generated graph nodes");
    }
    const nodeId = record(generatedNodes[0])["id"];
    if (typeof nodeId !== "string") throw new Error("Missing generated node ID");
    const exportPath = join(repository, "degraded-export.json");
    for (const command of [
      ["graph", "inspect", "--manifest", manifestArgument, "--node", nodeId],
      [
        "workflow",
        "export",
        "--manifest",
        manifestArgument,
        "--format",
        "graph-json",
        "--output",
        exportPath,
      ],
    ]) {
      let commandFailure: Readonly<Record<string, unknown>> | undefined;
      try {
        await executeCli(command);
      } catch (error: unknown) {
        commandFailure = record(error);
      }
      expect(commandFailure?.["code"]).toBe(1);
      expect(commandFailure?.["stderr"]).toBe("");
      const commandStdout = commandFailure?.["stdout"];
      expect(typeof commandStdout).toBe("string");
      expect(typeof commandStdout === "string" ? commandStdout.length : 0).toBeGreaterThan(1);
    }
    expect((await stat(exportPath)).isFile()).toBe(true);

    let diffFailure: Readonly<Record<string, unknown>> | undefined;
    try {
      await executeCli(["workflow", "diff", "--manifest", manifestArgument, "--against", "HEAD"]);
    } catch (error: unknown) {
      diffFailure = record(error);
    }
    expect(diffFailure).toMatchObject({ code: 1, stderr: "" });
    const diffStdout = diffFailure?.["stdout"];
    if (typeof diffStdout !== "string") throw new Error("Missing diff JSON output");
    const diff = record(JSON.parse(diffStdout) as unknown);
    expect(record(diff["summary"])["unverified"]).toBeGreaterThan(0);
    expect(JSON.stringify(diff["warnings"])).toContain("target_unavailable");
  }, 60_000);
});

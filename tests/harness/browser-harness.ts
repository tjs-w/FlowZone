import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

const ToolCallSchema = z
  .object({
    _meta: z.record(z.string(), z.unknown()).optional(),
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const pluginRoot = resolve(import.meta.dir, "../..");
let generatedDirectory: string | undefined;
let markdownPath: string;
if (process.argv[2] === "--generated-fixture") {
  generatedDirectory = await mkdtemp(join(tmpdir(), "markdown-review-browser-"));
  markdownPath = join(generatedDirectory, "review fixture.md");
  await writeFile(
    join(generatedDirectory, "fixture.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await writeFile(
    join(generatedDirectory, "fixture.jpg"),
    Buffer.from(
      "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAABwEBAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AL+AD//Z",
      "base64",
    ),
  );
  await writeFile(
    join(generatedDirectory, "fixture.webp"),
    Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64"),
  );
  await writeFile(
    markdownPath,
    "# Markdown Review Fixture\n\nSelect and review this paragraph.\n\n## Images\n\n![PNG pixel](fixture.png)\n\n![JPEG pixel](fixture.jpg)\n\n![WebP pixel](fixture.webp)\n\n## Tasks\n\n- [ ] Pending task\n- [x] Completed task\n- Ordinary list item\n\n## Mermaid\n\n```mermaid\nflowchart LR\n  A[Draft] --> B{Review}\n  B -->|Approve| C[Done]\n```\n",
  );
} else {
  markdownPath = resolve(process.argv[2] ?? resolve(pluginRoot, "scripts/fixture.md"));
}
const requestedPort = Number(process.env["MARKDOWN_REVIEW_PORT"] ?? 43_117);
const dynaDataDirectory =
  generatedDirectory ?? (await mkdtemp(join(tmpdir(), "flowzone-dyna-harness-")));
const transport = new StdioClientTransport({
  command: "node",
  args: [resolve(pluginRoot, "server/dist/server.cjs")],
  cwd: pluginRoot,
  env: { FLOWZONE_DATA_DIR: dynaDataDirectory, PATH: process.env["PATH"] ?? "" },
  stderr: "pipe",
});
const client = new Client({ name: "flowzone-browser-harness", version: "0.1.0" });
await client.connect(transport);

interface DynaHarnessBackend {
  readonly client: Client;
  readonly dataDirectory: string;
}

const dynaBackendPromises = new Map<string, Promise<DynaHarnessBackend>>();

function dynaPartition(request: IncomingMessage): string {
  const header = request.headers["x-flowzone-e2e-project"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return "default";
  if (!/^[a-z0-9-]{1,40}$/u.test(value)) {
    throw new Error("The Dyna harness project partition is invalid.");
  }
  return value;
}

async function dynaBackend(request: IncomingMessage): Promise<DynaHarnessBackend> {
  const partition = dynaPartition(request);
  if (partition === "default") return { client, dataDirectory: dynaDataDirectory };
  const existing = dynaBackendPromises.get(partition);
  if (existing) return existing;
  if (dynaBackendPromises.size >= 8) {
    throw new Error("The Dyna harness cannot create more than eight test partitions.");
  }
  const pending = (async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), `flowzone-dyna-${partition}-`));
    const partitionTransport = new StdioClientTransport({
      command: "node",
      args: [resolve(pluginRoot, "server/dist/server.cjs")],
      cwd: pluginRoot,
      env: { FLOWZONE_DATA_DIR: dataDirectory, PATH: process.env["PATH"] ?? "" },
      stderr: "pipe",
    });
    const partitionClient = new Client({
      name: `flowzone-browser-harness-${partition}`,
      version: "0.1.0",
    });
    try {
      await partitionClient.connect(partitionTransport);
      return { client: partitionClient, dataDirectory };
    } catch (error: unknown) {
      await rm(dataDirectory, { force: true, recursive: true });
      throw error;
    }
  })();
  dynaBackendPromises.set(partition, pending);
  return pending;
}

const resource = await client.readResource({ uri: "ui://flowzone/v5.html" });
const resourceContent = resource.contents[0];
if (!resourceContent || !("text" in resourceContent)) {
  throw new Error("The Markdown Review HTML resource was not returned");
}
const opened = await client.callTool({
  name: "render_markdown_review",
  arguments: { path: markdownPath },
});
if (opened.isError) throw new Error("Could not open the browser-harness Markdown fixture");

function resultRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an MCP result object");
  }
  return value as Readonly<Record<string, unknown>>;
}

const dynaResource = await client.readResource({ uri: "ui://flowzone/dyna/v5.html" });
const dynaResourceContent = dynaResource.contents[0];
if (!dynaResourceContent || !("text" in dynaResourceContent)) {
  throw new Error("The Dyna HTML resource was not returned");
}
async function createDynaFixture(
  client: Client,
  itemCount = 1,
  includePipeline = false,
  longContent = false,
  olderAnnotationMatch = false,
  failedSchedule = false,
): Promise<unknown> {
  const fixtureId = randomUUID();
  const now = new Date().toISOString();
  const sources = [
    {
      source: "scm",
      provider: "GitHub",
      instanceId: fixtureId,
      repository: "team/project",
      entityType: "pull_request",
      entityId: "123",
    },
    { source: "outlook", accountId: fixtureId, messageId: "quarterly-plan" },
    {
      source: "messaging",
      provider: "Discord",
      workspaceId: fixtureId,
      channelId: "architecture",
      messageId: "decision-42",
    },
    { source: "twg", contextId: "splunk.atlassian.net", resultType: "work", recordId: "JIRA-4242" },
  ] as const;
  const requiredSourceSlices = [
    { source: "scm", sourceScope: "team/project" },
    { source: "outlook", sourceScope: "team/project" },
    { source: "messaging", sourceScope: "team/project" },
    { source: "twg", sourceScope: "team/project" },
  ] as const;
  const createdDashboard = await client.callTool({
    name: "flowzone",
    arguments: {
      plugin: "dyna",
      action: "create-dashboard",
      input: { name: "Executive brief", description: "Decisions and risks across your work" },
    },
  });
  const dashboard = resultRecord(resultRecord(createdDashboard.structuredContent)["result"]);
  const dashboardId = dashboard["id"];
  const createdPublisher = await client.callTool({
    name: "flowzone",
    arguments: {
      plugin: "dyna",
      action: "create-publisher",
      input: {
        name: "Browser fixture schedule",
        requiredSourceSlices,
        credentialMode: "local_preview",
      },
    },
  });
  const publisherResult = resultRecord(resultRecord(createdPublisher.structuredContent)["result"]);
  const publisher = resultRecord(publisherResult["publisher"]);
  const publisherId = publisher["id"];
  const publisherSecret = publisherResult["secret"];
  if (
    typeof dashboardId !== "string" ||
    typeof publisherId !== "string" ||
    typeof publisherSecret !== "string"
  ) {
    throw new Error("Could not create the Dyna browser fixture");
  }
  const binding = await client.callTool({
    name: "flowzone",
    arguments: {
      plugin: "dyna",
      action: "bind-schedule",
      input: {
        dashboardId,
        publisherId,
        scheduleId: `browser-fixture-schedule-${fixtureId}`,
        scheduleTitle: "Browser fixture schedule",
        scheduleState: "active",
      },
    },
  });
  if (binding.isError) throw new Error("Could not bind the Dyna browser fixture schedule");
  const publication = await client.callTool({
    name: "flowzone",
    arguments: {
      plugin: "dyna",
      action: "publish-run",
      input: {
        publisherId,
        secret: publisherSecret,
        runId: "browser-fixture-run",
        sourceCompletedAt: now,
        mode: "replace",
        status: failedSchedule ? "failed" : "succeeded",
        ...(failedSchedule
          ? {
              failureMessage:
                "Outlook unavailable: saved read-only session expired and unattended authentication is not authorized. TWG rollup was also partial: Jira and Confluence reads succeeded, but GraphStore count failures left cross-source coverage incomplete.",
            }
          : {}),
        sourceSlices: requiredSourceSlices.map((slice) => ({
          ...slice,
          status: failedSchedule ? "failed" : "succeeded",
        })),
        items: failedSchedule
          ? []
          : Array.from({ length: itemCount }, (_, index) => {
              const source = sources[index % sources.length];
              if (!source) throw new Error("Dyna fixture source was not found");
              const sourceRef =
                source.source === "scm"
                  ? { ...source, entityId: `fixture-pr-${String(index)}` }
                  : source.source === "outlook"
                    ? { ...source, messageId: `quarterly-plan-${String(index)}` }
                    : source.source === "messaging"
                      ? { ...source, messageId: `decision-${String(index)}` }
                      : { ...source, recordId: `JIRA-${String(4_242 + index)}` };
              return {
                externalId: `fixture:${String(index)}`,
                sourceRef,
                sourceScope: "team/project",
                title:
                  index === 0
                    ? longContent
                      ? `Review-${"x".repeat(193)}`
                      : "Review the release merge request"
                    : `Additional priority ${String(index)}`,
                summary:
                  index === 0
                    ? longContent
                      ? `Context-${"y".repeat(992)}`
                      : "The change is ready and waiting for an executive review."
                    : "A cross-functional signal needs a clear owner and a bounded next move.",
                priority: index === 0 ? "critical" : index === 3 ? "high" : "normal",
                priorityReason: "The release window closes today.",
                sourceUpdatedAt: now,
                ...(index === 2
                  ? {}
                  : {
                      dueAt: new Date(
                        Date.parse(now) + (index === 0 ? 2 : index === 3 ? 4 : 24) * 60 * 60_000,
                      ).toISOString(),
                    }),
                labels: ["release", "decision"],
                people:
                  index === 2
                    ? [
                        {
                          displayName: "Architecture council",
                          leadershipLevel: "architect",
                          relationship: "neighboring_org",
                          involvement: "mentioned",
                          provenance: "source_metadata",
                          confidence: "medium",
                        },
                      ]
                    : [
                        {
                          displayName: index === 0 ? "Avery Chen" : "Morgan Lee",
                          title: index === 0 ? "Chief Technology Officer" : "Senior Director",
                          leadershipLevel: index === 0 ? "cto" : "senior_director",
                          relationship: index === 0 ? "management_chain" : "neighboring_org",
                          involvement: index === 0 ? "approver" : "sender",
                          provenance: "declared_source",
                          confidence: "high",
                        },
                      ],
                attention:
                  index === 0
                    ? "Confirm the risk posture and either approve the release or name the blocker."
                    : "Turn this signal into an owned decision before it becomes follow-up debt.",
                plan: ["Validate the latest context", "Resolve the decision owner"],
                nextSteps: [
                  {
                    label:
                      index === 0 ? "Review the release diff" : "Confirm the accountable owner",
                    owner: "You",
                  },
                  { label: "Record the decision in the source thread" },
                ],
              };
            }),
      },
    },
  });
  if (publication.isError) throw new Error("Could not publish the Dyna browser fixture");
  let openedDyna = await client.callTool({
    name: "render_dyna_dashboard",
    arguments: { dashboardId },
  });
  if (openedDyna.isError) throw new Error("Could not open the browser-harness Dyna fixture");
  if (itemCount > 1) {
    const metadata = resultRecord(openedDyna._meta);
    const payload = resultRecord(metadata["dynaDashboard"]);
    const snapshot = resultRecord(payload["snapshot"]);
    const cards = Array.isArray(snapshot["cards"]) ? snapshot["cards"] : [];
    const leadershipCard = cards
      .map(resultRecord)
      .find((card) => card["title"] === "Additional priority 1");
    const leadershipItemId = leadershipCard?.["id"];
    const leadershipFingerprint = leadershipCard?.["fingerprint"];
    if (typeof leadershipItemId === "string" && typeof leadershipFingerprint === "string") {
      await client.callTool({
        name: "flowzone",
        arguments: {
          plugin: "dyna",
          action: "apply-enrichment",
          input: {
            itemId: leadershipItemId,
            expectedFingerprint: leadershipFingerprint,
            expectedEnrichmentVersion: 0,
            people: [
              {
                displayName: "Morgan Lee",
                title: "Senior Director",
                leadershipLevel: "senior_director",
                relationship: "neighboring_org",
                involvement: "sender",
                provenance: "twg_org_tree",
                confidence: "high",
              },
            ],
            provenance: "browser-fixture-twg-org-tree",
          },
        },
      });
      openedDyna = await client.callTool({
        name: "render_dyna_dashboard",
        arguments: { dashboardId },
      });
    }
  }
  if (olderAnnotationMatch) {
    const metadata = resultRecord(openedDyna._meta);
    const payload = resultRecord(metadata["dynaDashboard"]);
    const viewToken = payload["viewToken"];
    const snapshot = resultRecord(payload["snapshot"]);
    const cards = Array.isArray(snapshot["cards"]) ? snapshot["cards"] : [];
    const firstCard = cards[0] ? resultRecord(cards[0]) : undefined;
    const itemId = firstCard?.["id"];
    if (typeof viewToken === "string" && typeof itemId === "string") {
      await client.callTool({
        name: "dyna_add_annotation",
        arguments: {
          viewToken,
          itemId,
          clientRequestId: randomUUID(),
          body: `buriedneedle ${"a".repeat(980)}`,
        },
      });
      for (let index = 0; index < 6; index += 1) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
        await client.callTool({
          name: "dyna_add_annotation",
          arguments: {
            viewToken,
            itemId,
            clientRequestId: randomUUID(),
            body: `newer-${String(index)}-${"b".repeat(980)}`,
          },
        });
      }
      openedDyna = await client.callTool({
        name: "render_dyna_dashboard",
        arguments: { dashboardId },
      });
    }
  }
  if (includePipeline) {
    const metadata = resultRecord(openedDyna._meta);
    const payload = resultRecord(metadata["dynaDashboard"]);
    const snapshot = resultRecord(payload["snapshot"]);
    const cards = Array.isArray(snapshot["cards"]) ? snapshot["cards"] : [];
    const taskStates = [
      { title: "Additional priority 1", state: "running" },
      { title: "Additional priority 2", state: "waiting" },
      { title: "Additional priority 3", state: "succeeded" },
    ] as const;
    for (const [offset, target] of taskStates.entries()) {
      const matchingCard = cards.map(resultRecord).find((card) => card["title"] === target.title);
      if (!matchingCard)
        throw new Error(`Dyna pipeline fixture card was not found: ${target.title}`);
      const card = matchingCard;
      const itemId = card["id"];
      if (typeof itemId !== "string") continue;
      await client.callTool({
        name: "flowzone",
        arguments: {
          plugin: "dyna",
          action: "attach-codex-task",
          input: {
            itemId,
            task: {
              taskId: `pipeline-task-${String(offset + 1)}`,
              hostId: "local",
              title: `Codex execution ${String(offset + 1)}`,
              state: target.state,
              statusUpdatedAt: now,
              observedAt: now,
              ...(target.state === "succeeded"
                ? { outcome: "Approved the release path and documented the remaining risk." }
                : {}),
            },
          },
        },
      });
    }
    openedDyna = await client.callTool({
      name: "render_dyna_dashboard",
      arguments: { dashboardId },
    });
  }
  return openedDyna;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

const hostScript = `<script>
(() => {
  const initialResult = ${safeJson(opened)};
  const query = new URLSearchParams(window.location.search);
  const reviewDocument = initialResult._meta.document;
  const updatedReviewDocument = {
    ...reviewDocument,
    reviewSessionId: "323e4567-e89b-42d3-a456-426614174000",
    revision: "browser-latest-revision",
    title: "Markdown Review Fixture",
    images: [],
    html: reviewDocument.html.replace(
      "Select and review this paragraph.",
      "Latest source revision is visible."
    )
  };
  const updatedResult = {
    ...initialResult,
    structuredContent: {
      ...initialResult.structuredContent.result,
      revision: updatedReviewDocument.revision
    },
    _meta: {
      document: updatedReviewDocument
    }
  };
  const seededWidgetState = query.get("seed") === "1"
    ? {
        privateContent: {
          path: reviewDocument.path,
          theme: "light",
          queue: [{
            id: "browser-harness-feedback-1",
            serial: 1,
            path: reviewDocument.path,
            revision: reviewDocument.revision,
            startLine: 3,
            endLine: 3,
            anchorX: 0.5,
            anchorY: 0.5,
            quote: "Select and review this paragraph.",
            feedback: "Make this sentence more specific.",
            createdAt: "2026-08-24T00:00:00.000Z"
          }],
          nextSerial: 2,
          lastSubmission: null,
          pendingSubmission: null
        }
      }
    : null;
  const state = window.__markdownReviewHost = {
    messages: [],
    directSubmissions: [],
    sizeChanges: [],
    externalLinks: [],
    toolCalls: [],
    toolResults: [],
    clipboardWrites: [],
    widgetState: seededWidgetState,
    setWidgetStateCalls: 0,
    documentUpdateAvailable: false
  };
  window.openai = {
    sendFollowUpMessage(request) {
      state.directSubmissions.push(request);
      document.documentElement.dataset.directSubmissionCount = String(state.directSubmissions.length);
      document.documentElement.dataset.lastDirectSubmission = JSON.stringify(request);
      return Promise.resolve();
    }
  };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText(text) {
        state.clipboardWrites.push(text);
        return Promise.resolve();
      }
    }
  });
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value(command) {
      if (command !== "copy") return false;
      const active = document.activeElement;
      const text = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
        ? active.value.slice(active.selectionStart ?? 0, active.selectionEnd ?? 0)
        : window.getSelection()?.toString() ?? "";
      state.clipboardWrites.push(text);
      return true;
    }
  });
  if (query.get("codex") === "1") {
    Object.assign(window.openai, {
      widgetState: seededWidgetState,
      setWidgetState(nextState) {
        state.setWidgetStateCalls += 1;
        window.openai.widgetState = nextState;
        state.widgetState = nextState;
      }
    });
  }
  const respond = (id, result) => window.postMessage({ jsonrpc: "2.0", id, result }, "*");
  const notify = (method, params) => window.postMessage({ jsonrpc: "2.0", method, params }, "*");
  window.addEventListener("message", async (event) => {
    const request = event.data;
    if (event.source !== window || !request || request.jsonrpc !== "2.0" || typeof request.method !== "string") return;
    if (request.id === undefined) {
      if (request.method === "ui/notifications/size-changed") {
        state.sizeChanges.push(request.params);
        document.documentElement.dataset.lastReportedHeight = String(request.params?.height ?? "");
        event.stopImmediatePropagation();
      } else if (request.method === "ui/notifications/initialized") {
        event.stopImmediatePropagation();
      }
      return;
    }
    // The harness hosts the app in the same top-level window. Prevent the app's
    // transport from seeing and rejecting its own outbound host request before
    // this mock host can respond. Real MCP Apps hosts use a parent iframe.
    event.stopImmediatePropagation();
    try {
      let result = {};
      if (request.method === "ui/initialize") {
        result = {
          protocolVersion: "2026-01-26",
          hostInfo: { name: "flowzone-browser-harness", version: "0.1.0" },
          hostCapabilities: {
            openLinks: {},
            serverTools: {},
            message: {}
          },
          hostContext: {
            theme: "light",
            displayMode: "inline",
            availableDisplayModes: query.get("inline-only") === "1"
              ? ["inline"]
              : ["inline", "fullscreen"]
          }
        };
        respond(request.id, result);
        setTimeout(() => notify("ui/notifications/tool-result", initialResult), 0);
        return;
      }
      if (request.method === "tools/call") {
        state.toolCalls.push(request.params);
        if (
          query.get("auto-update") === "1" &&
          request.params.name === "check_markdown_review_document"
        ) {
          const document = request.params.arguments;
          const changed = state.documentUpdateAvailable === true &&
            document.revision === reviewDocument.revision;
          result = {
            content: [],
            structuredContent: {
              kind: "markdown-review-update-status",
              reviewSessionId: document.reviewSessionId,
              path: document.path,
              revision: changed ? updatedReviewDocument.revision : document.revision,
              changed
            }
          };
        } else if (
          query.get("auto-update") === "1" &&
          request.params.name === "load_markdown_review_document"
        ) {
          state.documentUpdateAvailable = false;
          result = updatedResult;
        } else {
          const response = await fetch("/call", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request.params)
          });
          result = await response.json();
        }
        state.toolResults.push(result);
      } else if (request.method === "ui/message") {
        state.messages.push(request.params);
        document.documentElement.dataset.submittedMessageCount = String(state.messages.length);
        document.documentElement.dataset.lastSubmittedMessage = JSON.stringify(request.params);
        if (query.get("review-error") === "1") result = { isError: true };
      } else if (request.method === "ui/open-link") {
        state.externalLinks.push(request.params.url);
      } else if (request.method === "ui/request-display-mode") {
        result = { mode: request.params.mode };
        notify("ui/notifications/host-context-changed", { displayMode: request.params.mode });
      }
      respond(request.id, result);
    } catch (error) {
      window.postMessage({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: String(error instanceof Error ? error.message : error) }
      }, "*");
    }
  });
})();
</script>`;

const page = resourceContent.text.replace("<body>", `<body>${hostScript}`);

const dynaHostScript = (dynaResult: unknown) => `<script>
(() => {
  const initialResult = ${safeJson(dynaResult)};
  const query = new URLSearchParams(window.location.search);
  const state = window.__dynaHost = {
    messages: [],
    toolCalls: [],
    toolResults: [],
    displayModeRequests: [],
    snapshotResults: 0,
    replayedToolResults: 0,
    latestToolResult: initialResult,
    replayLatestToolResult() {
      state.replayedToolResults += 1;
      document.documentElement.dataset.dynaReplayedToolResultCount =
        String(state.replayedToolResults);
      notify("ui/notifications/tool-result", state.latestToolResult);
    }
  };
  const respond = (id, result) => window.postMessage({ jsonrpc: "2.0", id, result }, "*");
  const notify = (method, params) => window.postMessage({ jsonrpc: "2.0", method, params }, "*");
  window.addEventListener("message", async (event) => {
    const request = event.data;
    if (event.source !== window || !request || request.jsonrpc !== "2.0" || typeof request.method !== "string") return;
    if (request.id === undefined) {
      if (request.method === "ui/notifications/initialized") event.stopImmediatePropagation();
      return;
    }
    event.stopImmediatePropagation();
    try {
      let result = {};
      if (request.method === "ui/initialize") {
        const advertisedDisplayModes = Array.isArray(
          request.params?.appCapabilities?.availableDisplayModes,
        )
          ? request.params.appCapabilities.availableDisplayModes
          : ["inline"];
        const hostDisplayModes =
          query.get("inline-only") === "1" ? ["inline"] : ["inline", "fullscreen"];
        const availableDisplayModes = hostDisplayModes.filter((mode) =>
          advertisedDisplayModes.includes(mode),
        );
        document.documentElement.dataset.dynaAdvertisedDisplayModes =
          JSON.stringify(advertisedDisplayModes);
        result = {
          protocolVersion: "2026-01-26",
          hostInfo: { name: "flowzone-dyna-harness", version: "0.1.0" },
          hostCapabilities: {
            ...(query.get("no-server-tools") === "1" ? {} : { serverTools: {} }),
            ...(query.get("no-message") === "1"
              ? {}
              : { message: query.get("no-text-message") === "1" ? { image: {} } : { text: {} } })
          },
          hostContext: {
            theme: query.get("theme") === "dark" ? "dark" : "light",
            displayMode: "inline",
            availableDisplayModes,
            platform: "mobile",
            deviceCapabilities: { touch: true, hover: false },
            safeAreaInsets: { top: 8, right: 0, bottom: 10, left: 0 },
            locale: "en-US",
            timeZone: "America/Los_Angeles"
          }
        };
        respond(request.id, result);
        setTimeout(() => notify("ui/notifications/tool-result", initialResult), 0);
        if (query.get("initial-view") === "pipeline") {
          setTimeout(() => document.getElementById("dyna-tab-pipeline")?.click(), 300);
        }
        if (query.get("open-todo") === "1") {
          setTimeout(() => {
            const button = [...document.querySelectorAll("button")].find(
              (candidate) => candidate.textContent?.trim() === "Add to-do",
            );
            button?.click();
          }, 300);
        }
        return;
      }
      if (request.method === "tools/call") {
        state.toolCalls.push(request.params);
        if (query.get("tool-error") === request.params?.name) {
          result = { isError: true, content: [{ type: "text", text: "fixture failure" }] };
        } else {
          const response = await fetch("/call", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request.params)
          });
          result = await response.json();
        }
        state.toolResults.push(result);
        state.latestToolResult = result;
        if (request.params?.name === "dyna_get_snapshot") {
          state.snapshotResults += 1;
          document.documentElement.dataset.dynaSnapshotResultCount =
            String(state.snapshotResults);
        }
      } else if (request.method === "ui/message") {
        state.messages.push(request.params);
        document.documentElement.dataset.dynaMessageCount = String(state.messages.length);
        document.documentElement.dataset.dynaLastMessage = JSON.stringify(request.params);
        if (query.get("action-error") === "1") result = { isError: true };
      } else if (request.method === "ui/request-display-mode") {
        state.displayModeRequests.push(request.params);
        document.documentElement.dataset.dynaDisplayModeRequestCount = String(state.displayModeRequests.length);
        if (query.get("display-mode-delay") === "1") {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
        }
        if (query.get("display-mode-error") === "1") throw new Error("Display mode unavailable");
        const actualMode = query.get("display-mode-result") ?? request.params.mode;
        result = { mode: actualMode };
        notify("ui/notifications/host-context-changed", { displayMode: actualMode });
      }
      respond(request.id, result);
    } catch (error) {
      document.documentElement.dataset.dynaHostError = String(
        error instanceof Error ? error.message : error,
      );
      window.postMessage({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: String(error instanceof Error ? error.message : error) } }, "*");
    }
  });
})();
</script>`;

const dynaPage = (dynaResult: unknown) =>
  dynaResourceContent.text.replace("<body>", `<body>${dynaHostScript(dynaResult)}`);

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: unknown) => {
      if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
      else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
      else rejectBody(new TypeError("Received an unsupported HTTP request chunk"));
    });
    request.once("end", () => {
      resolveBody(Buffer.concat(chunks));
    });
    request.once("error", rejectBody);
  });
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && requestUrl.pathname === "/") {
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    });
    response.end(page);
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/dyna") {
    const backend = await dynaBackend(request);
    const dynaFixture = await createDynaFixture(
      backend.client,
      requestUrl.searchParams.get("dense") === "1"
        ? 9
        : requestUrl.searchParams.get("many-items") === "1" ||
            requestUrl.searchParams.get("pipeline") === "1"
          ? 4
          : 1,
      requestUrl.searchParams.get("pipeline") === "1",
      requestUrl.searchParams.get("long-content") === "1",
      requestUrl.searchParams.get("older-match") === "1",
      requestUrl.searchParams.get("failed-schedule") === "1",
    );
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    });
    response.end(dynaPage(dynaFixture));
    return;
  }
  if (request.method === "GET" && request.url === "/health") {
    json(response, 200, { ok: true });
    return;
  }
  if (request.method === "GET" && request.url === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method === "POST" && request.url === "/call") {
    try {
      const input = ToolCallSchema.parse(
        JSON.parse((await readRequestBody(request)).toString("utf8")),
      );
      const requestClient = input.name.startsWith("dyna_")
        ? (await dynaBackend(request)).client
        : client;
      const result = await requestClient.callTool({
        name: input.name,
        arguments: input.arguments ?? {},
      });
      json(response, 200, result);
    } catch (error: unknown) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  response.writeHead(404);
  response.end("Not found");
}

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error: unknown) => {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  });
});

await new Promise<void>((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(requestedPort, "127.0.0.1", () => {
    resolveListen();
  });
});
const address = server.address();
const port = typeof address === "object" && address ? address.port : requestedPort;
process.stdout.write(`FlowZone browser harness: http://127.0.0.1:${String(port)}\n`);

async function shutdown(): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
  const partitionBackends = await Promise.all(dynaBackendPromises.values());
  await Promise.all(partitionBackends.map((backend) => backend.client.close()));
  await client.close();
  await Promise.all([
    rm(dynaDataDirectory, { force: true, recursive: true }),
    ...partitionBackends.map((backend) =>
      rm(backend.dataDirectory, { force: true, recursive: true }),
    ),
  ]);
}

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

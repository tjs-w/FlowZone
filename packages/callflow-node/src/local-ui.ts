import { createHash, randomBytes } from "node:crypto";
import type { EventEmitter } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

import {
  CallFlowUiPayloadSchema,
  GraphSnapshotSchema,
  type GraphSnapshot,
} from "@callflow/contracts";
import { sanitizeGraphSnapshot } from "@callflow/core";

import { CallFlowError } from "./errors.js";
import { resolveExecutable, runBoundedProcess } from "./process.js";

const MAX_UI_ASSET_BYTES = Math.floor(1.25 * 1024 * 1024);

export interface LocalUiOptions {
  readonly host?: string;
  readonly port?: number;
  readonly open?: boolean;
  readonly signal?: AbortSignal;
  readonly onReady: (url: string) => void;
}

async function readUiAsset(path: string): Promise<string> {
  const details = await stat(path).catch(() => {
    throw new CallFlowError("unavailable", "The installed CallFlow UI assets are unavailable.");
  });
  if (!details.isFile() || details.size > MAX_UI_ASSET_BYTES) {
    throw new CallFlowError("unavailable", "An installed CallFlow UI asset is invalid.");
  }
  return await readFile(path, "utf8").catch(() => {
    throw new CallFlowError("unavailable", "An installed CallFlow UI asset could not be read.");
  });
}

function escapeApplicationJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > 8 * 1024 * 1024) {
    throw new CallFlowError("output_too_large", "The standalone CallFlow graph is too large.");
  }
  return serialized.replace(/[<>&\u2028\u2029]/g, (character) => {
    switch (character) {
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      case "&":
        return "\\u0026";
      case "\u2028":
        return "\\u2028";
      default:
        return "\\u2029";
    }
  });
}

export async function createStandaloneCallFlowHtml(
  snapshotValue: GraphSnapshot,
  webRootInput: string,
): Promise<string> {
  const snapshot = sanitizeGraphSnapshot(GraphSnapshotSchema.parse(snapshotValue));
  const webRoot = resolve(webRootInput);
  const [template, bundle, stylesheet] = await Promise.all([
    readUiAsset(resolve(webRoot, "callflow.html")),
    readUiAsset(resolve(webRoot, "dist/callflow.js")),
    readUiAsset(resolve(webRoot, "dist/callflow.css")),
  ]);
  const marker = "<!-- CALLFLOW_APP -->";
  if (!template.includes(marker) || template.indexOf(marker) !== template.lastIndexOf(marker)) {
    throw new CallFlowError("invalid_output", "The installed CallFlow UI template is invalid.");
  }
  if (Buffer.byteLength(template + bundle + stylesheet, "utf8") > MAX_UI_ASSET_BYTES) {
    throw new CallFlowError(
      "output_too_large",
      "The installed CallFlow UI exceeds its size limit.",
    );
  }
  const payload = CallFlowUiPayloadSchema.parse({
    schema: "callflow/ui-payload-v1",
    sessionId: `standalone-${snapshot.id}`.slice(0, 160),
    capability: {
      token: `standalone.${randomBytes(32).toString("base64url")}`,
      expiresAt: "9999-12-31T23:59:59.999Z",
      repositoryRevision: snapshot.repository.commit,
      graphRevision: snapshot.id,
      sourceByteBudget: 0,
    },
    snapshot,
  });
  const bootstrap = `<script id="callflow-bootstrap" type="application/json">${escapeApplicationJson(payload)}</script>`;
  return template
    .replace("</head>", `<style>${stylesheet.replaceAll("</style", "<\\/style")}</style></head>`)
    .replace(
      marker,
      () => `${bootstrap}${marker}<script>${bundle.replaceAll("</script", "<\\/script")}</script>`,
    );
}

function validateOptions(options: LocalUiOptions): { host: string; port: number } {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  if (host !== "127.0.0.1") {
    throw new CallFlowError("invalid_input", "CallFlow UI serves on 127.0.0.1 only.");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new CallFlowError("invalid_input", "The CallFlow UI port is invalid.");
  }
  return { host, port };
}

function inlineContentHashes(html: string, tag: "script" | "style"): string {
  const expression =
    tag === "script"
      ? /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g
      : /<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g;
  const hashes = [...html.matchAll(expression)].map((match) => {
    const content = match[1] ?? "";
    return `'sha256-${createHash("sha256").update(content, "utf8").digest("base64")}'`;
  });
  return hashes.length > 0 ? hashes.join(" ") : "'none'";
}

export function localBrowserCommand(
  platform: NodeJS.Platform,
  url: string,
): { candidates: readonly string[]; args: readonly string[] } {
  if (platform === "darwin") return { candidates: ["/usr/bin/open"], args: [url] };
  if (platform === "linux") {
    return {
      candidates: ["/usr/bin/xdg-open", "/usr/local/bin/xdg-open"],
      args: [url],
    };
  }
  if (platform === "win32") {
    return {
      candidates: [
        String.raw`C:\Windows\System32\rundll32.exe`,
        String.raw`C:\WINNT\System32\rundll32.exe`,
      ],
      args: ["url.dll,FileProtocolHandler", url],
    };
  }
  return { candidates: [], args: [] };
}

async function openUrl(url: string): Promise<void> {
  const command = localBrowserCommand(process.platform, url);
  const candidates = command.candidates;
  if (candidates.length === 0) {
    throw new CallFlowError("unavailable", "Automatic browser opening is unavailable.");
  }
  const executable = await resolveExecutable(candidates);
  const result = await runBoundedProcess({
    executable,
    args: command.args,
    cwd: process.cwd(),
    maximumOutputBytes: 64 * 1024,
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0) {
    throw new CallFlowError("unavailable", "The local browser could not be opened.", true);
  }
}

export async function serveCallFlowHtml(html: string, options: LocalUiOptions): Promise<void> {
  const { host, port } = validateOptions(options);
  const route = `/${randomBytes(24).toString("base64url")}`;
  const scriptPolicy = inlineContentHashes(html, "script");
  const stylePolicy = inlineContentHashes(html, "style");
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== route) {
      response.writeHead(404, {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      });
      response.end("Not found\n");
      return;
    }
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; script-src ${scriptPolicy}; style-src 'none'; style-src-elem ${stylePolicy}; style-src-attr 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    response.end(html);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  }).catch(() => {
    throw new CallFlowError("unavailable", "The local CallFlow UI server could not start.");
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new CallFlowError("unavailable", "The local CallFlow UI address is unavailable.");
  }
  const url = `http://${host}:${String(address.port)}${route}`;
  options.onReady(url);
  if (options.open === true) {
    try {
      await openUrl(url);
    } catch (error: unknown) {
      server.close();
      throw error;
    }
  }

  await new Promise<void>((resolve) => {
    const processEvents: EventEmitter = process;
    const stop = (): void => {
      server.close(() => {
        resolve();
      });
    };
    options.signal?.addEventListener("abort", stop, { once: true });
    processEvents.once("SIGINT", stop);
    processEvents.once("SIGTERM", stop);
    server.once("close", () => {
      options.signal?.removeEventListener("abort", stop);
      processEvents.removeListener("SIGINT", stop);
      processEvents.removeListener("SIGTERM", stop);
    });
  });
}

import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import {
  GraphQuerySchema,
  GraphSnapshotSchema,
  WorkflowManifestSchema,
  type GraphSnapshot,
} from "@callflow/contracts";
import { canonicalStringify } from "@callflow/core";

import { asCallFlowError, CallFlowError } from "./errors.js";
import {
  createJsonFile,
  createTextFile,
  generatedSnapshotPath,
  readBoundedStdin,
  replaceJsonFile,
  stableJson,
} from "./io.js";
import { createStandaloneCallFlowHtml, serveCallFlowHtml } from "./local-ui.js";
import { RepositoryPolicy, isWithinRoot } from "./repository.js";
import { CallFlowService, graphHasHealthyEvidence, type ExportFormat } from "./service.js";

interface CliIo {
  readonly stdout: { write(value: string): unknown };
  readonly stderr: { write(value: string): unknown };
  readonly stdin: NodeJS.ReadableStream;
}

interface ParsedFlags {
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly booleans: ReadonlySet<string>;
}

const BOOLEAN_FLAGS = new Set(["lsp", "write"]);
const EXPORT_FORMATS = new Set<ExportFormat>([
  "markdown",
  "graph-json",
  "bundle-json",
  "mermaid",
  "svg",
  "html",
]);

function parseFlags(args: readonly string[], allowed: readonly string[]): ParsedFlags {
  const allowedFlags = new Set(allowed);
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument?.startsWith("--") || argument.length <= 2) {
      throw new CallFlowError("invalid_input", "CallFlow accepts named options only.");
    }
    const name = argument.slice(2);
    if (!allowedFlags.has(name)) {
      throw new CallFlowError("invalid_input", `Unknown CallFlow option: --${name}.`);
    }
    if (BOOLEAN_FLAGS.has(name)) {
      booleans.add(name);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new CallFlowError("invalid_input", `CallFlow option --${name} requires a value.`);
    }
    if (value.includes("\0") || /[\r\n]/.test(value) || value.length > 4_096) {
      throw new CallFlowError("invalid_input", `CallFlow option --${name} is invalid.`);
    }
    values.set(name, [...(values.get(name) ?? []), value]);
    index += 1;
  }
  return { values, booleans };
}

function one(flags: ParsedFlags, name: string, required = true): string | undefined {
  const values = flags.values.get(name) ?? [];
  if (values.length > 1) {
    throw new CallFlowError("invalid_input", `CallFlow option --${name} may be passed once.`);
  }
  const value = values[0];
  if (required && value === undefined) {
    throw new CallFlowError("invalid_input", `CallFlow option --${name} is required.`);
  }
  return value;
}

function integerFlag(
  flags: ParsedFlags,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const raw = one(flags, name, false);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new CallFlowError(
      "invalid_input",
      `CallFlow option --${name} must be between ${String(minimum)} and ${String(maximum)}.`,
    );
  }
  return value;
}

function writeResult(io: CliIo, value: unknown): void {
  io.stdout.write(stableJson(value));
}

async function comparisonSnapshot(
  service: CallFlowService,
  repositoryPolicy: RepositoryPolicy,
  manifestPath: string,
  against: string,
): Promise<
  | { readonly status: "succeeded"; readonly snapshot: GraphSnapshot }
  | { readonly status: "unavailable"; readonly reason: string }
> {
  if (isAbsolute(against)) {
    try {
      return { status: "succeeded", snapshot: await service.loadSnapshot(against) };
    } catch {
      return {
        status: "unavailable",
        reason: "The comparison snapshot is unavailable or schema-invalid.",
      };
    }
  }
  const manifest = await service.loadManifest(manifestPath);
  const absoluteManifestPath = resolve(manifestPath);
  const repositoryPath = manifest.repository.identity.startsWith("local:")
    ? manifest.repository.identity.slice("local:".length)
    : dirname(absoluteManifestPath);
  const repository = await repositoryPolicy.resolveRepository(repositoryPath);
  const generatedPath = generatedSnapshotPath(absoluteManifestPath);
  const snapshotPath = resolve(await realpath(dirname(generatedPath)), basename(generatedPath));
  if (!isWithinRoot(repository.root, snapshotPath)) {
    throw new CallFlowError(
      "path_denied",
      "The generated snapshot must be inside the repository for Git comparison.",
    );
  }
  const repositoryRelativePath = relative(repository.root, snapshotPath).split("\\").join("/");
  try {
    const raw = await repositoryPolicy.readFileAtRevision(
      repository.root,
      against,
      repositoryRelativePath,
    );
    return {
      status: "succeeded",
      snapshot: GraphSnapshotSchema.parse(JSON.parse(raw) as unknown),
    };
  } catch {
    return {
      status: "unavailable",
      reason: "The comparison revision does not contain a valid generated snapshot.",
    };
  }
}

async function handleAdapter(
  action: string | undefined,
  args: readonly string[],
  service: CallFlowService,
  io: CliIo,
): Promise<number> {
  if (action === "status") {
    const flags = parseFlags(args, ["repo"]);
    const status = await service.adapterStatus(one(flags, "repo") ?? "");
    writeResult(io, status);
    return status.state === "ready" ? 0 : 1;
  }
  if (action === "build") {
    const flags = parseFlags(args, ["repo", "lsp"]);
    const status = await service.buildAdapter(one(flags, "repo") ?? "", flags.booleans.has("lsp"));
    writeResult(io, status);
    return status.state === "ready" ? 0 : 1;
  }
  throw new CallFlowError("invalid_input", "Expected adapter status or adapter build.");
}

async function handleWorkflow(
  action: string | undefined,
  args: readonly string[],
  service: CallFlowService,
  repositoryPolicy: RepositoryPolicy,
  io: CliIo,
): Promise<number> {
  if (action === "discover") {
    const flags = parseFlags(args, ["repo", "entry", "sink", "name", "depth", "max-nodes"]);
    const sink = one(flags, "sink", false);
    const name = one(flags, "name", false);
    const depth = integerFlag(flags, "depth", 1, 8);
    const maximumNodes = integerFlag(flags, "max-nodes", 1, 250);
    const result = await service.discover({
      repositoryPath: one(flags, "repo") ?? "",
      entries: flags.values.get("entry") ?? [],
      ...(sink === undefined ? {} : { sink }),
      ...(name === undefined ? {} : { name }),
      ...(depth === undefined ? {} : { depth }),
      ...(maximumNodes === undefined ? {} : { maximumNodes }),
    });
    writeResult(io, { manifest: result.manifest, snapshot: result.snapshot });
    return graphHasHealthyEvidence(result.snapshot) ? 0 : 1;
  }
  if (action === "create") {
    const flags = parseFlags(args, ["repo", "manifest"]);
    const repositoryPath = one(flags, "repo") ?? "";
    const repository = await repositoryPolicy.resolveRepository(repositoryPath);
    const manifest = WorkflowManifestSchema.parse(await readBoundedStdin(io.stdin));
    if (
      manifest.repository.identity !== repository.revision.identity &&
      manifest.repository.identity !== `local:${repository.root}`
    ) {
      throw new CallFlowError(
        "invalid_manifest",
        "The manifest repository does not match the selected repository.",
      );
    }
    const path = await createJsonFile(one(flags, "manifest") ?? "", manifest);
    writeResult(io, { schema: "callflow/create-result-v1", manifestId: manifest.id, path });
    return 0;
  }
  if (action === "validate") {
    const flags = parseFlags(args, ["manifest"]);
    const manifest = await service.loadManifest(one(flags, "manifest") ?? "");
    writeResult(io, {
      schema: "callflow/validation-result-v1",
      valid: true,
      manifestId: manifest.id,
      anchorCount: manifest.anchors.length,
      stageCount: manifest.stages.length,
    });
    return 0;
  }
  if (action === "refresh") {
    const flags = parseFlags(args, ["manifest", "against", "write"]);
    const manifestPath = one(flags, "manifest") ?? "";
    const refreshed = await service.refreshManifestPath(manifestPath);
    const against = one(flags, "against", false);
    const comparison = against
      ? await comparisonSnapshot(service, repositoryPolicy, manifestPath, against)
      : undefined;
    const diff =
      comparison?.status === "succeeded"
        ? service.diff(comparison.snapshot, refreshed.snapshot)
        : comparison?.status === "unavailable"
          ? service.diff(refreshed.snapshot, undefined, comparison.reason)
          : undefined;
    const outputPath = flags.booleans.has("write")
      ? await replaceJsonFile(service.generatedSnapshotPath(manifestPath), refreshed.snapshot)
      : undefined;
    writeResult(io, {
      schema: "callflow/refresh-result-v1",
      snapshot: refreshed.snapshot,
      ...(diff ? { diff } : {}),
      ...(outputPath ? { outputPath } : {}),
      wrote: outputPath !== undefined,
    });
    return graphHasHealthyEvidence(refreshed.snapshot) && comparison?.status !== "unavailable"
      ? 0
      : 1;
  }
  if (action === "diff") {
    const flags = parseFlags(args, ["manifest", "against"]);
    const manifestPath = one(flags, "manifest") ?? "";
    const refreshed = await service.refreshManifestPath(manifestPath);
    const comparison = await comparisonSnapshot(
      service,
      repositoryPolicy,
      manifestPath,
      one(flags, "against") ?? "",
    );
    writeResult(
      io,
      comparison.status === "succeeded"
        ? service.diff(comparison.snapshot, refreshed.snapshot)
        : service.diff(refreshed.snapshot, undefined, comparison.reason),
    );
    return graphHasHealthyEvidence(refreshed.snapshot) && comparison.status === "succeeded" ? 0 : 1;
  }
  if (action === "export") {
    const flags = parseFlags(args, ["manifest", "format", "output"]);
    const format = one(flags, "format") as ExportFormat | undefined;
    if (!format || !EXPORT_FORMATS.has(format)) {
      throw new CallFlowError("invalid_input", "The requested export format is unsupported.");
    }
    const manifestPath = one(flags, "manifest") ?? "";
    const snapshot = await service.loadGeneratedSnapshot(manifestPath);
    const outputPath = await createTextFile(
      one(flags, "output") ?? "",
      service.export(snapshot, format),
    );
    writeResult(io, {
      schema: "callflow/export-result-v1",
      graphRevision: snapshot.id,
      format,
      outputPath,
    });
    return graphHasHealthyEvidence(snapshot) ? 0 : 1;
  }
  throw new CallFlowError(
    "invalid_input",
    "Expected workflow discover, create, validate, refresh, diff, or export.",
  );
}

async function handleGraph(
  action: string | undefined,
  args: readonly string[],
  service: CallFlowService,
  io: CliIo,
): Promise<number> {
  if (action === "inspect") {
    const flags = parseFlags(args, ["manifest", "node", "edge"]);
    const nodeId = one(flags, "node", false);
    const edgeId = one(flags, "edge", false);
    if ((nodeId === undefined) === (edgeId === undefined)) {
      throw new CallFlowError("invalid_input", "Select exactly one --node or --edge.");
    }
    const snapshot = await service.loadGeneratedSnapshot(one(flags, "manifest") ?? "");
    const result = nodeId
      ? snapshot.nodes.find((node) => node.id === nodeId)
      : snapshot.edges.find((edge) => edge.id === edgeId);
    if (!result) throw new CallFlowError("not_found", "The selected graph element was not found.");
    writeResult(io, result);
    return graphHasHealthyEvidence(snapshot) ? 0 : 1;
  }
  if (action === "query") {
    const flags = parseFlags(args, ["manifest"]);
    const snapshot = await service.loadGeneratedSnapshot(one(flags, "manifest") ?? "");
    const query = GraphQuerySchema.parse(await readBoundedStdin(io.stdin));
    writeResult(io, service.query(snapshot, query));
    return graphHasHealthyEvidence(snapshot) ? 0 : 1;
  }
  throw new CallFlowError("invalid_input", "Expected graph inspect or graph query.");
}

async function handleUi(
  action: string | undefined,
  args: readonly string[],
  service: CallFlowService,
  io: CliIo,
): Promise<void> {
  if (action !== "serve" && action !== "open") {
    throw new CallFlowError("invalid_input", "Expected ui serve or ui open.");
  }
  const flags = parseFlags(args, ["manifest", "listen", "port"]);
  const snapshot = await service.loadGeneratedSnapshot(one(flags, "manifest") ?? "");
  const host = one(flags, "listen", false);
  const port = integerFlag(flags, "port", 0, 65_535);
  const bundlePath = process.argv[1];
  if (!bundlePath || !isAbsolute(bundlePath)) {
    throw new CallFlowError("unavailable", "The installed CallFlow bundle path is unavailable.");
  }
  const html = await createStandaloneCallFlowHtml(
    snapshot,
    resolve(dirname(bundlePath), "../../web"),
  );
  await serveCallFlowHtml(html, {
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    open: action === "open",
    onReady(url) {
      writeResult(io, {
        schema: "callflow/ui-server-v1",
        graphRevision: snapshot.id,
        url,
      });
    },
  });
}

export async function runCallFlowCli(
  args: readonly string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin },
): Promise<number> {
  const service = new CallFlowService();
  const repositoryPolicy = new RepositoryPolicy();
  try {
    const [group, action, ...rest] = args;
    let exitCode = 0;
    if (group === "adapter") exitCode = await handleAdapter(action, rest, service, io);
    else if (group === "workflow") {
      exitCode = await handleWorkflow(action, rest, service, repositoryPolicy, io);
    } else if (group === "graph") exitCode = await handleGraph(action, rest, service, io);
    else if (group === "ui") await handleUi(action, rest, service, io);
    else throw new CallFlowError("invalid_input", "Expected adapter, workflow, graph, or ui.");
    return exitCode;
  } catch (error: unknown) {
    const failure = asCallFlowError(error);
    io.stderr.write(
      `${canonicalStringify({
        schema: "callflow/error-v1",
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
      })}\n`,
    );
    return failure.code === "invalid_input" || failure.code === "invalid_manifest" ? 2 : 1;
  }
}

function main(): void {
  runCallFlowCli(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    () => {
      process.stderr.write(
        `${canonicalStringify({
          schema: "callflow/error-v1",
          code: "failed",
          message: "CallFlow failed unexpectedly.",
          retryable: false,
        })}\n`,
      );
      process.exitCode = 1;
    },
  );
}

main();

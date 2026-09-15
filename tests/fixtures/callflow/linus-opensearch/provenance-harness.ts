import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export const PINNED_LINUS_COMMIT = "cd2949c1e4a686359900a3f47e8dbd2e2b44b861";

export interface PinnedSourceFile {
  readonly path: string;
  readonly bytes: number;
  readonly digest: `sha256:${string}`;
}

export interface ReadCommandResult {
  readonly id: string;
  readonly stdoutDigest: `sha256:${string}`;
  readonly observed: readonly string[];
}

export interface AcceptanceCapture {
  readonly commit: string;
  readonly graftVersion: string;
  readonly cleanBefore: boolean;
  readonly cleanAfter: boolean;
  readonly indexBefore: TreeFingerprint;
  readonly indexAfter: TreeFingerprint;
  readonly wiring: PinnedSourceFile;
  readonly sources: readonly PinnedSourceFile[];
  readonly commands: readonly ReadCommandResult[];
}

export interface TreeFingerprint {
  readonly files: number;
  readonly bytes: number;
  readonly digest: `sha256:${string}`;
}

interface CallersCommand {
  readonly id: string;
  readonly command: "callers";
  readonly query: string;
  readonly sourceId: string;
  readonly targets: readonly string[];
  readonly absentTargets?: readonly string[];
}

interface GrepCommand {
  readonly id: string;
  readonly command: "grep";
  readonly query: string;
  readonly path: string;
  readonly line: number;
}

interface CheckCommand {
  readonly id: string;
  readonly command: "check";
}

export type PinnedReadCommand = CallersCommand | GrepCommand | CheckCommand;

export const PINNED_SOURCE_FILES = [
  "internal/db/opensearch_outbox.go",
  "internal/app/service.go",
  "internal/search/outbox/worker.go",
  "internal/search/outbox/process.go",
  "internal/db/opensearch_reread.go",
  "internal/search/outbox/project.go",
  "internal/search/service.go",
  "internal/search/client.go",
] as const;

/** Fixed, read-only Graft 0.18 commands. Repository data never supplies executable arguments. */
export const PINNED_READ_COMMANDS: readonly PinnedReadCommand[] = [
  { id: "check", command: "check" },
  {
    id: "callers-enqueue",
    command: "callers",
    query: "enqueueOpenSearchOutboxTx",
    sourceId: "internal/db/opensearch_outbox.go#Store.enqueueOpenSearchOutboxTx",
    targets: ["internal/db/opensearch_outbox.go#Store.EnqueueOpenSearchOutboxTx"],
  },
  {
    id: "callers-process-one",
    command: "callers",
    query: "internal/search/outbox/process.go#Worker.ProcessOneRecord",
    sourceId: "internal/search/outbox/process.go#Worker.ProcessOneRecord",
    targets: ["internal/search/outbox/process.go#Worker.processClaim"],
  },
  {
    id: "callers-process-claim",
    command: "callers",
    query: "internal/search/outbox/process.go#Worker.processClaim",
    sourceId: "internal/search/outbox/process.go#Worker.processClaim",
    targets: ["internal/search/outbox/process.go#Worker.deliver"],
  },
  {
    id: "callers-deliver",
    command: "callers",
    query: "internal/search/outbox/process.go#Worker.deliver",
    sourceId: "internal/search/outbox/process.go#Worker.deliver",
    targets: ["internal/search/outbox/process.go#Worker.project"],
  },
  {
    id: "callers-project",
    command: "callers",
    query: "internal/search/outbox/process.go#Worker.project",
    sourceId: "internal/search/outbox/process.go#Worker.project",
    targets: [
      "internal/search/outbox/project.go#projectFinding",
      "internal/search/outbox/project.go#projectIncident",
    ],
  },
  {
    id: "callers-worker-run-gap",
    command: "callers",
    query: "internal/search/outbox/worker.go#Worker.Run",
    sourceId: "internal/search/outbox/worker.go#Worker.Run",
    targets: [],
    absentTargets: ["internal/search/outbox/process.go#Worker.ProcessOneRecord"],
  },
  {
    id: "callers-signal-gap",
    command: "callers",
    query: "internal/app/service.go#Service.signalOpenSearch",
    sourceId: "internal/app/service.go#Service.signalOpenSearch",
    targets: [],
    absentTargets: ["internal/search/outbox/worker.go#Worker.Run"],
  },
  {
    id: "grep-worker-process-one",
    command: "grep",
    query: "w.ProcessOneRecord(ctx)",
    path: "internal/search/outbox/worker.go",
    line: 244,
  },
  {
    id: "grep-claim",
    command: "grep",
    query: "SelectAndClaimOneOpenSearchRecordTx",
    path: "internal/search/outbox/process.go",
    line: 64,
  },
  {
    id: "grep-reread-finding",
    command: "grep",
    query: "ReadFindingForProjectionTx",
    path: "internal/search/outbox/process.go",
    line: 249,
  },
  {
    id: "grep-reread-incident",
    command: "grep",
    query: "ReadIncidentForProjectionTx",
    path: "internal/search/outbox/process.go",
    line: 259,
  },
  {
    id: "grep-index-for",
    command: "grep",
    query: "search.IndexFor",
    path: "internal/search/outbox/process.go",
    line: 198,
  },
  {
    id: "grep-index-doc",
    command: "grep",
    query: "w.client.IndexDoc",
    path: "internal/search/outbox/process.go",
    line: 213,
  },
  {
    id: "grep-delivered",
    command: "grep",
    query: "claim.DeleteDelivered",
    path: "internal/search/outbox/process.go",
    line: 216,
  },
  {
    id: "grep-retrying",
    command: "grep",
    query: "claim.MarkRetrying",
    path: "internal/search/outbox/process.go",
    line: 285,
  },
  {
    id: "grep-dead",
    command: "grep",
    query: "claim.MarkDead",
    path: "internal/search/outbox/process.go",
    line: 308,
  },
  {
    id: "grep-signal-send",
    command: "grep",
    query: "s.openSearchNotify <-",
    path: "internal/app/service.go",
    line: 210,
  },
  {
    id: "grep-signal-receive",
    command: "grep",
    query: "<-w.notifyCh",
    path: "internal/search/outbox/worker.go",
    line: 236,
  },
] as const;

function sha256(bytes: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function runBounded(executable: string, args: readonly string[]): Promise<string> {
  const process = Bun.spawn([executable, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, NO_COLOR: "1" },
  });
  const timer = setTimeout(() => {
    process.kill();
  }, 30_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).arrayBuffer(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (stdout.byteLength > 8 * 1024 * 1024) throw new Error("Acceptance output exceeded 8 MiB.");
    if (exitCode !== 0) {
      throw new Error(`Acceptance command failed (${String(exitCode)}): ${stderr.slice(0, 512)}`);
    }
    return new TextDecoder().decode(stdout);
  } finally {
    clearTimeout(timer);
  }
}

async function fingerprintTree(root: string): Promise<TreeFingerprint> {
  const entries: { path: string; bytes: Uint8Array }[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) {
        entries.push({
          path: relative(root, absolutePath).split("\\").join("/"),
          bytes: await readFile(absolutePath),
        });
      } else {
        throw new Error("The pinned Graft index contains an unsupported filesystem entry.");
      }
    }
  };
  await visit(root);
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const identity = entries
    .map((entry) => `${entry.path}\0${sha256(entry.bytes)}\0${String(entry.bytes.byteLength)}\n`)
    .join("");
  return {
    files: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes.byteLength, 0),
    digest: sha256(identity),
  };
}

function verifyCallers(command: CallersCommand, value: unknown): readonly string[] {
  const response = value as {
    readonly matches?: readonly {
      readonly symbol?: { readonly id?: unknown };
      readonly hits?: readonly { readonly id?: unknown; readonly relation?: unknown }[];
    }[];
  };
  const match = response.matches?.find((candidate) => candidate.symbol?.id === command.sourceId);
  if (match?.hits === undefined) {
    throw new Error(`Graft did not return the pinned source symbol for ${command.id}.`);
  }
  const targets = match.hits.flatMap((hit) =>
    hit.relation === "calls" && typeof hit.id === "string" ? [hit.id] : [],
  );
  for (const target of command.targets) {
    if (!targets.includes(target))
      throw new Error(`Missing Graft relation ${command.id}: ${target}.`);
  }
  for (const target of command.absentTargets ?? []) {
    if (targets.includes(target))
      throw new Error(`Unexpected Graft relation ${command.id}: ${target}.`);
  }
  return command.targets.map((target) => `${command.sourceId}->${target}`);
}

function verifyGrep(command: GrepCommand, value: unknown): readonly string[] {
  const response = value as {
    readonly groups?: readonly {
      readonly path?: unknown;
      readonly hits?: readonly { readonly line?: unknown }[];
    }[];
  };
  const observed = response.groups?.some(
    (group) =>
      group.path === command.path && group.hits?.some((hit) => hit.line === command.line) === true,
  );
  if (observed !== true) {
    throw new Error(`Graft fixed grep did not return ${command.path}:${String(command.line)}.`);
  }
  return [`${command.path}:${String(command.line)}`];
}

export async function capturePinnedLinusAcceptance(options: {
  readonly repositoryPath: string;
  readonly graftExecutable: string;
  readonly gitExecutable?: string;
}): Promise<AcceptanceCapture> {
  const repository = await realpath(resolve(options.repositoryPath));
  const graftRoot = await realpath(join(repository, "graft"));
  const git = options.gitExecutable ?? "git";
  const gitOutput = async (...args: readonly string[]): Promise<string> =>
    await runBounded(git, ["-C", repository, ...args]);
  const commit = (await gitOutput("rev-parse", "HEAD")).trim();
  const statusBefore = await gitOutput("status", "--porcelain=v1", "--untracked-files=all");
  const indexBefore = await fingerprintTree(graftRoot);
  const wiringBytes = await readFile(join(graftRoot, ".graph/wiring.json"));
  const wiring = {
    path: "graft/.graph/wiring.json",
    bytes: wiringBytes.byteLength,
    digest: sha256(wiringBytes),
  };
  const sources = await Promise.all(
    PINNED_SOURCE_FILES.map(async (path) => {
      const bytes = await readFile(join(repository, path));
      return { path, bytes: bytes.byteLength, digest: sha256(bytes) };
    }),
  );
  const graftVersion = (await runBounded(options.graftExecutable, ["--version"])).trim();
  const commands: ReadCommandResult[] = [];

  for (const command of PINNED_READ_COMMANDS) {
    const args =
      command.command === "check"
        ? ["check", "--json", "--", repository]
        : command.command === "callers"
          ? [
              "callers",
              "--direction",
              "out",
              "--depth",
              "1",
              "--json",
              "--no-refresh",
              "--",
              command.query,
              repository,
            ]
          : ["grep", "--fixed", "--json", "--no-refresh", "--", command.query, repository];
    const stdout = await runBounded(options.graftExecutable, args);
    const parsed = JSON.parse(stdout) as unknown;
    const observed =
      command.command === "check"
        ? ["graph-index-readable"]
        : command.command === "callers"
          ? verifyCallers(command, parsed)
          : verifyGrep(command, parsed);
    if (command.command === "check") {
      const check = parsed as { readonly graph?: { readonly ok?: unknown } };
      if (check.graph?.ok !== true) throw new Error("The pinned Graft graph is not fresh.");
    }
    commands.push({ id: command.id, stdoutDigest: sha256(stdout), observed });
  }

  const statusAfter = await gitOutput("status", "--porcelain=v1", "--untracked-files=all");
  const indexAfter = await fingerprintTree(graftRoot);
  return {
    commit,
    graftVersion,
    cleanBefore: statusBefore.length === 0,
    cleanAfter: statusAfter.length === 0,
    indexBefore,
    indexAfter,
    wiring,
    sources,
    commands,
  };
}

import {
  DynaArchiveReasonSchema,
  DynaItemArchiveResultSchema,
  DynaItemEnrichResultSchema,
  DynaItemPlaceResultSchema,
  DynaItemRestoreResultSchema,
  DynaItemShowResultSchema,
  DynaItemUpdateResultSchema,
  DynaFollowUpCreateResultSchema,
  DynaNextStepSchema,
  DynaPersonSignalSchema,
  DynaPrioritySchema,
  DynaPublishedItemSchema,
  DynaTodoInputSchema,
  DynaWorkUpdateInputSchema,
  DynaCliHelpResultSchema,
  DynaCliSetupResultSchema,
  DynaCliVersionResultSchema,
  DynaCliErrorSchema,
} from "@flowzone/dyna-contracts";
import { DynaCliStoreError, DynaService } from "@flowzone/dyna-node";
import { spawnSync } from "node:child_process";
import { z } from "zod";

const MAX_INPUT_BYTES = 32 * 1024;
const UUID = z.uuid();
const FINGERPRINT = z.string().regex(/^[a-f0-9]{64}$/);
const CLI_VERSION = "0.1.0";
const MINIMUM_NODE_VERSION = "22.13.0";

function restoreLauncherTerminal(): void {
  const state = process.env["FLOWZONE_DYNA_TTY_STATE"]?.trim();
  if (!state || !process.stdin.isTTY) return;
  spawnSync("/bin/stty", [state], { stdio: [process.stdin, "ignore", "ignore"] });
}

// Non-interactive POSIX shells may defer or ignore SIGTSTP while waiting for a
// child. Handle terminal-generated Ctrl-Z in the foreground Node process so a
// mutation cannot remain suspended with input echo disabled.
process.once("SIGTSTP", () => {
  restoreLauncherTerminal();
  process.exit(148);
});

const CLI_COMMANDS = [
  {
    command: "dyna item show --dashboard-id D --item-id I",
    readsStdin: false,
    description: "Read bounded current item context and control versions.",
  },
  {
    command: "dyna item update --dashboard-id D --item-id I --expected-fingerprint F",
    readsStdin: true,
    description: "Append one typed durable work update.",
  },
  {
    command:
      "dyna item enrich --dashboard-id D --item-id I --expected-fingerprint F --expected-enrichment-version N",
    readsStdin: true,
    description: "Replace the bounded evidence-based enrichment overlay.",
  },
  {
    command:
      "dyna item place --dashboard-id D --item-id I --expected-fingerprint F --expected-revision N",
    readsStdin: true,
    description: "Change dashboard-local priority and sequence.",
  },
  {
    command:
      "dyna item archive --dashboard-id D --item-id I --expected-fingerprint F --expected-revision N",
    readsStdin: true,
    description: "Archive with an explicit disposition.",
  },
  {
    command:
      "dyna item restore --dashboard-id D --item-id I --expected-fingerprint F --expected-revision N",
    readsStdin: true,
    description: "Restore an archived item without losing history.",
  },
  {
    command:
      "dyna follow-up create --dashboard-id D --item-id I --expected-fingerprint F --expected-revision N",
    readsStdin: true,
    description: "Create linked active work from an unchanged original.",
  },
  {
    command: "dyna setup",
    readsStdin: false,
    description: "Check the local runtime and store readiness.",
  },
  {
    command: "dyna --help",
    readsStdin: false,
    description: "Describe every allowlisted command and stdin requirement.",
  },
  {
    command: "dyna --version",
    readsStdin: false,
    description: "Report bounded CLI and Node.js compatibility versions.",
  },
] as const;

const EnrichInputSchema = z
  .object({
    requestId: UUID,
    summary: DynaPublishedItemSchema.shape.summary.optional(),
    priority: DynaPrioritySchema.optional(),
    priorityReason: DynaPublishedItemSchema.shape.priorityReason.optional(),
    dueAt: DynaPublishedItemSchema.shape.dueAt.nullable().optional(),
    labels: DynaPublishedItemSchema.shape.labels.optional(),
    people: z.array(DynaPersonSignalSchema).max(8).optional(),
    attention: DynaPublishedItemSchema.shape.attention.optional(),
    plan: DynaPublishedItemSchema.shape.plan.optional(),
    nextSteps: z.array(DynaNextStepSchema).max(4).optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).some((key) => key !== "requestId"), {
    message: "An enrichment must include at least one replacement field.",
  });

const PlaceInputSchema = z
  .object({
    requestId: UUID,
    targetPriority: DynaPrioritySchema,
    beforeItemId: UUID.optional(),
  })
  .strict();

const ArchiveInputSchema = z
  .object({
    requestId: UUID,
    reason: DynaArchiveReasonSchema,
    reasonDetail: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.reason === "other" && !input.reasonDetail) {
      context.addIssue({
        code: "custom",
        path: ["reasonDetail"],
        message: "Other requires a reason detail.",
      });
    }
    if (input.reason !== "other" && input.reasonDetail) {
      context.addIssue({
        code: "custom",
        path: ["reasonDetail"],
        message: "Reason detail is only allowed for Other.",
      });
    }
  });

const RestoreInputSchema = z.object({ requestId: UUID }).strict();
const FollowUpInputSchema = DynaTodoInputSchema.omit({ followUpOfItemId: true })
  .extend({ requestId: UUID })
  .strict();

type ParsedCommand =
  | { readonly kind: "help" | "version" | "setup" }
  | { readonly kind: "show"; readonly dashboardId: string; readonly itemId: string }
  | {
      readonly kind: "update";
      readonly dashboardId: string;
      readonly itemId: string;
      readonly expectedFingerprint: string;
    }
  | {
      readonly kind: "enrich";
      readonly dashboardId: string;
      readonly itemId: string;
      readonly expectedFingerprint: string;
      readonly expectedEnrichmentVersion: number;
    }
  | {
      readonly kind: "place" | "archive" | "restore" | "follow-up";
      readonly dashboardId: string;
      readonly itemId: string;
      readonly expectedFingerprint: string;
      readonly expectedRevision: number;
    };

function exactFlags(
  arguments_: readonly string[],
  required: readonly string[],
): Map<string, string> {
  if (arguments_.length !== required.length * 2) throw new Error("usage");
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag || !value || !required.includes(flag) || values.has(flag)) throw new Error("usage");
    values.set(flag, value);
  }
  if (required.some((flag) => !values.has(flag))) throw new Error("usage");
  return values;
}

function nonnegativeInteger(value: string | undefined): number {
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("usage");
  return z.number().int().nonnegative().parse(Number(value));
}

function parseCommand(arguments_: readonly string[]): ParsedCommand {
  if (
    arguments_.length === 1 &&
    (arguments_[0] === "--help" || arguments_[0] === "-h" || arguments_[0] === "help")
  ) {
    return { kind: "help" };
  }
  if (arguments_.length === 1 && (arguments_[0] === "--version" || arguments_[0] === "version")) {
    return { kind: "version" };
  }
  if (arguments_.length === 1 && arguments_[0] === "setup") return { kind: "setup" };
  const [noun, verb, ...rest] = arguments_;
  const command = noun === "follow-up" && verb === "create" ? "follow-up" : verb;
  if ((noun !== "item" && noun !== "follow-up") || !command) throw new Error("usage");
  const common = ["--dashboard-id", "--item-id"];
  if (noun === "item" && command === "show") {
    const flags = exactFlags(rest, common);
    return {
      kind: "show",
      dashboardId: UUID.parse(flags.get("--dashboard-id")),
      itemId: UUID.parse(flags.get("--item-id")),
    };
  }
  if (noun === "item" && command === "update") {
    const flags = exactFlags(rest, [...common, "--expected-fingerprint"]);
    return {
      kind: "update",
      dashboardId: UUID.parse(flags.get("--dashboard-id")),
      itemId: UUID.parse(flags.get("--item-id")),
      expectedFingerprint: FINGERPRINT.parse(flags.get("--expected-fingerprint")),
    };
  }
  if (noun === "item" && command === "enrich") {
    const flags = exactFlags(rest, [
      ...common,
      "--expected-fingerprint",
      "--expected-enrichment-version",
    ]);
    return {
      kind: "enrich",
      dashboardId: UUID.parse(flags.get("--dashboard-id")),
      itemId: UUID.parse(flags.get("--item-id")),
      expectedFingerprint: FINGERPRINT.parse(flags.get("--expected-fingerprint")),
      expectedEnrichmentVersion: nonnegativeInteger(flags.get("--expected-enrichment-version")),
    };
  }
  if (
    (noun === "item" && ["place", "archive", "restore"].includes(command)) ||
    (noun === "follow-up" && command === "follow-up")
  ) {
    const flags = exactFlags(rest, [...common, "--expected-fingerprint", "--expected-revision"]);
    return {
      kind: command as "place" | "archive" | "restore" | "follow-up",
      dashboardId: UUID.parse(flags.get("--dashboard-id")),
      itemId: UUID.parse(flags.get("--item-id")),
      expectedFingerprint: FINGERPRINT.parse(flags.get("--expected-fingerprint")),
      expectedRevision: nonnegativeInteger(flags.get("--expected-revision")),
    };
  }
  throw new Error("usage");
}

function nodeRuntimeIsSupported(version = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  return major > 22 || (major === 22 && minor >= 13);
}

async function readBoundedJson(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const value: unknown = chunk;
    if (!(value instanceof Uint8Array) && typeof value !== "string") throw new Error("input");
    const bytes = Buffer.from(value);
    size += bytes.length;
    if (size > MAX_INPUT_BYTES) throw new Error("input");
    chunks.push(bytes);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) throw new Error("input");
  return JSON.parse(text) as unknown;
}

async function main(): Promise<void> {
  if (!nodeRuntimeIsSupported()) throw new Error("runtime");
  const command = parseCommand(process.argv.slice(2));
  if (command.kind === "help") {
    process.stdout.write(
      `${JSON.stringify(DynaCliHelpResultSchema.parse({ schema: "dyna/help-v1", commands: CLI_COMMANDS }))}\n`,
    );
    return;
  }
  if (command.kind === "version") {
    process.stdout.write(
      `${JSON.stringify(
        DynaCliVersionResultSchema.parse({
          schema: "dyna/version-v1",
          version: CLI_VERSION,
          nodeVersion: process.versions.node,
          minimumNodeVersion: MINIMUM_NODE_VERSION,
        }),
      )}\n`,
    );
    return;
  }
  const service = new DynaService();
  try {
    let result: unknown;
    switch (command.kind) {
      case "setup":
        service.store.listDashboards();
        result = DynaCliSetupResultSchema.parse({
          schema: "dyna/setup-v1",
          ready: true,
          store: "available",
          credentialBoundary: "local-user",
        });
        break;
      case "show":
        result = DynaItemShowResultSchema.parse(
          service.showItem(command.dashboardId, command.itemId),
        );
        break;
      case "update": {
        const input = DynaWorkUpdateInputSchema.parse(await readBoundedJson());
        result = DynaItemUpdateResultSchema.parse(
          service.recordWorkUpdate(
            command.dashboardId,
            command.itemId,
            command.expectedFingerprint,
            input,
          ),
        );
        break;
      }
      case "enrich": {
        const input = EnrichInputSchema.parse(await readBoundedJson());
        result = DynaItemEnrichResultSchema.parse(
          service.enrichItem(
            command.dashboardId,
            command.itemId,
            command.expectedFingerprint,
            command.expectedEnrichmentVersion,
            { ...input, provenance: "codex-task" },
          ),
        );
        break;
      }
      case "place": {
        const input = PlaceInputSchema.parse(await readBoundedJson());
        result = DynaItemPlaceResultSchema.parse(
          service.placeItem(
            command.dashboardId,
            command.itemId,
            command.expectedRevision,
            command.expectedFingerprint,
            input,
          ),
        );
        break;
      }
      case "archive": {
        const input = ArchiveInputSchema.parse(await readBoundedJson());
        result = DynaItemArchiveResultSchema.parse(
          service.archiveItem(
            command.dashboardId,
            command.itemId,
            command.expectedRevision,
            command.expectedFingerprint,
            input,
          ),
        );
        break;
      }
      case "restore": {
        const input = RestoreInputSchema.parse(await readBoundedJson());
        result = DynaItemRestoreResultSchema.parse(
          service.restoreItem(
            command.dashboardId,
            command.itemId,
            command.expectedRevision,
            command.expectedFingerprint,
            input.requestId,
          ),
        );
        break;
      }
      case "follow-up": {
        const input = FollowUpInputSchema.parse(await readBoundedJson());
        result = DynaFollowUpCreateResultSchema.parse(
          service.createFollowUp(
            command.dashboardId,
            command.itemId,
            command.expectedRevision,
            command.expectedFingerprint,
            input,
          ),
        );
        break;
      }
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    service.close();
  }
}

function isSqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const sqliteError = error as { readonly code?: unknown; readonly errcode?: unknown };
  return (
    sqliteError.code === "SQLITE_BUSY" ||
    sqliteError.code === "SQLITE_LOCKED" ||
    (sqliteError.code === "ERR_SQLITE_ERROR" &&
      (sqliteError.errcode === 5 || sqliteError.errcode === 6))
  );
}

main().catch((error: unknown) => {
  const code =
    error instanceof DynaCliStoreError
      ? error.code
      : error instanceof z.ZodError ||
          error instanceof SyntaxError ||
          (error instanceof Error && ["usage", "input"].includes(error.message))
        ? "invalid_input"
        : error instanceof Error && error.message === "runtime"
          ? "unsupported_runtime"
          : isSqliteBusy(error)
            ? "busy"
            : "internal";
  const message =
    error instanceof DynaCliStoreError
      ? error.message
      : code === "busy"
        ? "Dyna is busy; retry with the same request ID."
        : code === "unsupported_runtime"
          ? `Dyna requires Node.js ${MINIMUM_NODE_VERSION} or newer.`
          : code === "invalid_input"
            ? "Dyna rejected the command or JSON input."
            : "Dyna could not complete the command.";
  const output = DynaCliErrorSchema.parse({ schema: "dyna/error-v1", code, message });
  process.stderr.write(`${JSON.stringify(output)}\n`);
  process.exitCode = 1;
});

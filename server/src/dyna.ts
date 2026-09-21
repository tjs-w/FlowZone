import {
  DynaCliAnnotationAddInputSchema,
  DynaCliAnnotationDeleteInputSchema,
  DynaCliAnnotationEditInputSchema,
  DynaCliAnnotationMutationResultSchema,
  DynaDashboardListResultSchema,
  DynaDashboardShowResultSchema,
  DynaFollowUpCreateInputSchema,
  DynaFollowUpCreateResultSchema,
  DynaItemActivityResultSchema,
  DynaItemArchiveResultSchema,
  DynaItemEnrichResultSchema,
  DynaItemHistoryResultSchema,
  DynaItemPlaceResultSchema,
  DynaItemRestoreResultSchema,
  DynaItemSearchResultSchema,
  DynaItemSearchScopeSchema,
  DynaItemShowResultSchema,
  DynaItemUpdateResultSchema,
  DynaLifecycleArchiveInputSchema,
  DynaLifecycleRestoreInputSchema,
  DynaOrganizePlaceInputSchema,
  DynaOrganizePlaceManyInputSchema,
  DynaPageCursorSchema,
  DynaPlaceManyResultSchema,
  DynaTodoCreateInputSchema,
  DynaTodoCreateResultSchema,
  DynaTaskWorkEnrichInputSchema,
  DynaWorkCompleteInputSchema,
  DynaWorkCompleteResultSchema,
  DynaWorkUpdateInputSchema,
  DynaCliHelpResultSchema,
  DynaCliSetupResultSchema,
  DynaCliVersionResultSchema,
  DynaCliErrorSchema,
} from "@flowzone/dyna-contracts";
import {
  DynaApplicationService,
  DynaCliStoreError,
  type DynaApplicationActor,
} from "@flowzone/dyna-node";
import { spawnSync } from "node:child_process";
import { z } from "zod";

const MAX_INPUT_BYTES = 32 * 1024;
const UUID = z.uuid();
const FINGERPRINT = z.string().regex(/^[a-f0-9]{64}$/);
const CLI_VERSION = "0.1.0";
const MINIMUM_NODE_VERSION = "22.13.0";
const DYNA_CLI_ACTOR = {
  kind: "codex_task",
  capabilities: [
    "dashboard:read",
    "item:read",
    "work:update",
    "work:enrich",
    "work:complete",
    "annotation:manage",
    "item:organize",
    "item:lifecycle",
    "follow-up:create",
    "todo:create",
  ],
} as const satisfies DynaApplicationActor;

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
    command: "dyna dashboard list",
    readsStdin: false,
    description: "List up to 100 bounded dashboard records.",
  },
  {
    command: "dyna dashboard show --dashboard-id D",
    readsStdin: false,
    description: "Read one dashboard by exact ID.",
  },
  {
    command: "dyna item search --dashboard-id D [--query Q] [--scope active|archive]",
    readsStdin: false,
    description: "Search bounded active or archived dashboard items.",
  },
  {
    command: "dyna item show --dashboard-id D --item-id I",
    readsStdin: false,
    description: "Read bounded current item context and control versions.",
  },
  {
    command:
      "dyna item history --dashboard-id D --item-id I [--limit N] [--archive-cursor C] [--order-cursor C] [--status-cursor C] [--annotation-cursor C] [--work-cursor C]",
    readsStdin: false,
    description: "Read paginated lifecycle, placement, status, and work history.",
  },
  {
    command: "dyna item activity --dashboard-id D --item-id I [--cursor C] [--limit N]",
    readsStdin: false,
    description: "Read paginated durable work activity.",
  },
  {
    command: "dyna work update --dashboard-id D --item-id I --expected-fingerprint F",
    readsStdin: true,
    description: "Append one typed durable work update.",
  },
  {
    command:
      "dyna work enrich --dashboard-id D --item-id I --expected-fingerprint F --expected-enrichment-version N",
    readsStdin: true,
    description: "Patch the bounded evidence-based enrichment overlay.",
  },
  {
    command:
      "dyna work complete --dashboard-id D --item-id I --expected-fingerprint F --expected-revision N",
    readsStdin: true,
    description: "Record an outcome and explicitly close the assigned Dyna item.",
  },
  {
    command: "dyna annotation add --dashboard-id D --item-id I --expected-fingerprint F",
    readsStdin: true,
    description: "Add one editable task-attributed item annotation.",
  },
  {
    command:
      "dyna annotation edit --dashboard-id D --item-id I --expected-fingerprint F --annotation-id A --expected-version N",
    readsStdin: true,
    description: "Edit an item annotation at its exact version.",
  },
  {
    command:
      "dyna annotation delete --dashboard-id D --item-id I --expected-fingerprint F --annotation-id A --expected-version N",
    readsStdin: true,
    description: "Delete an item annotation at its exact version.",
  },
  {
    command:
      "dyna organize place --dashboard-id D --item-id I --expected-fingerprint F --expected-revision N",
    readsStdin: true,
    description: "Change dashboard-local priority and sequence.",
  },
  {
    command: "dyna organize place-many --dashboard-id D --expected-revision N",
    readsStdin: true,
    description: "Atomically change the priority group of bounded selected items.",
  },
  {
    command:
      "dyna lifecycle archive --dashboard-id D --item-id I --expected-fingerprint F --expected-revision N",
    readsStdin: true,
    description: "Archive with an explicit disposition.",
  },
  {
    command:
      "dyna lifecycle restore --dashboard-id D --item-id I --expected-fingerprint F --expected-revision N",
    readsStdin: true,
    description: "Restore an archived item without losing history.",
  },
  {
    command: "dyna todo create --dashboard-id D",
    readsStdin: true,
    description: "Create one active dashboard to-do.",
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

const MAX_ARGUMENTS = 20;
const MAX_ARGUMENT_BYTES = 8 * 1024;
const MAX_FLAG_VALUE_BYTES = 2 * 1024;
const QUERY = z.string().trim().max(500);

interface ItemIdentity {
  readonly dashboardId: string;
  readonly itemId: string;
}

interface MutationPreconditions extends ItemIdentity {
  readonly expectedFingerprint: string;
  readonly expectedRevision: number;
}

type ParsedCommand =
  | { readonly kind: "help" | "version" | "setup" }
  | { readonly kind: "dashboard-list" }
  | { readonly kind: "dashboard-show"; readonly dashboardId: string }
  | {
      readonly kind: "item-search";
      readonly dashboardId: string;
      readonly query: string;
      readonly scope: "active" | "archive";
    }
  | ({ readonly kind: "item-show" } & ItemIdentity)
  | ({
      readonly kind: "item-history";
      readonly limit: number;
      readonly archiveCursor?: string;
      readonly orderCursor?: string;
      readonly statusCursor?: string;
      readonly annotationCursor?: string;
      readonly workCursor?: string;
    } & ItemIdentity)
  | ({
      readonly kind: "item-activity";
      readonly cursor?: string;
      readonly limit: number;
    } & ItemIdentity)
  | ({ readonly kind: "work-update" } & Omit<MutationPreconditions, "expectedRevision">)
  | ({
      readonly kind: "work-enrich";
      readonly expectedEnrichmentVersion: number;
    } & Omit<MutationPreconditions, "expectedRevision">)
  | ({ readonly kind: "work-complete" } & MutationPreconditions)
  | ({ readonly kind: "annotation-add" } & Omit<MutationPreconditions, "expectedRevision">)
  | ({
      readonly kind: "annotation-edit" | "annotation-delete";
      readonly annotationId: string;
      readonly expectedVersion: number;
    } & Omit<MutationPreconditions, "expectedRevision">)
  | ({
      readonly kind:
        "organize-place" | "lifecycle-archive" | "lifecycle-restore" | "follow-up-create";
    } & MutationPreconditions)
  | {
      readonly kind: "organize-place-many";
      readonly dashboardId: string;
      readonly expectedRevision: number;
    }
  | { readonly kind: "todo-create"; readonly dashboardId: string };

function commandFlags(
  arguments_: readonly string[],
  required: readonly string[],
  optional: readonly string[] = [],
): Map<string, string> {
  if (arguments_.length % 2 !== 0) throw new Error("usage");
  const allowed = new Set([...required, ...optional]);
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !flag ||
      value === undefined ||
      !allowed.has(flag) ||
      values.has(flag) ||
      value.includes("\0") ||
      value.includes("\r") ||
      value.includes("\n") ||
      Buffer.byteLength(value, "utf8") > MAX_FLAG_VALUE_BYTES
    ) {
      throw new Error("usage");
    }
    values.set(flag, value);
  }
  if (required.some((flag) => !values.has(flag))) throw new Error("usage");
  return values;
}

function nonnegativeInteger(value: string | undefined): number {
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("usage");
  return z.number().int().nonnegative().parse(Number(value));
}

function positiveInteger(value: string | undefined, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("usage");
  return z.number().int().positive().max(maximum).parse(Number(value));
}

function optionalCursor(value: string | undefined): string | undefined {
  return value === undefined ? undefined : DynaPageCursorSchema.parse(value);
}

function itemIdentity(flags: ReadonlyMap<string, string>): ItemIdentity {
  return {
    dashboardId: UUID.parse(flags.get("--dashboard-id")),
    itemId: UUID.parse(flags.get("--item-id")),
  };
}

function mutationPreconditions(flags: ReadonlyMap<string, string>): MutationPreconditions {
  return {
    ...itemIdentity(flags),
    expectedFingerprint: FINGERPRINT.parse(flags.get("--expected-fingerprint")),
    expectedRevision: nonnegativeInteger(flags.get("--expected-revision")),
  };
}

function parseCommand(arguments_: readonly string[]): ParsedCommand {
  if (
    arguments_.length > MAX_ARGUMENTS ||
    arguments_.reduce((total, argument) => total + Buffer.byteLength(argument, "utf8"), 0) >
      MAX_ARGUMENT_BYTES
  ) {
    throw new Error("usage");
  }
  if (arguments_.length === 1 && arguments_[0] === "--help") {
    return { kind: "help" };
  }
  if (arguments_.length === 1 && arguments_[0] === "--version") {
    return { kind: "version" };
  }
  if (arguments_.length === 1 && arguments_[0] === "setup") return { kind: "setup" };

  const [noun, verb, ...rest] = arguments_;
  if (!noun || !verb) throw new Error("usage");
  const common = ["--dashboard-id", "--item-id"] as const;
  const preconditionFlags = [...common, "--expected-fingerprint", "--expected-revision"];

  if (noun === "dashboard" && verb === "list") {
    commandFlags(rest, []);
    return { kind: "dashboard-list" };
  }
  if (noun === "dashboard" && verb === "show") {
    const flags = commandFlags(rest, ["--dashboard-id"]);
    return { kind: "dashboard-show", dashboardId: UUID.parse(flags.get("--dashboard-id")) };
  }
  if (noun === "item" && verb === "search") {
    const flags = commandFlags(rest, ["--dashboard-id"], ["--query", "--scope"]);
    return {
      kind: "item-search",
      dashboardId: UUID.parse(flags.get("--dashboard-id")),
      query: QUERY.parse(flags.get("--query") ?? ""),
      scope: DynaItemSearchScopeSchema.parse(flags.get("--scope") ?? "active"),
    };
  }
  if (noun === "item" && verb === "show") {
    return { kind: "item-show", ...itemIdentity(commandFlags(rest, common)) };
  }
  if (noun === "item" && verb === "history") {
    const flags = commandFlags(rest, common, [
      "--limit",
      "--archive-cursor",
      "--order-cursor",
      "--status-cursor",
      "--annotation-cursor",
      "--work-cursor",
    ]);
    const archiveCursor = optionalCursor(flags.get("--archive-cursor"));
    const orderCursor = optionalCursor(flags.get("--order-cursor"));
    const statusCursor = optionalCursor(flags.get("--status-cursor"));
    const annotationCursor = optionalCursor(flags.get("--annotation-cursor"));
    const workCursor = optionalCursor(flags.get("--work-cursor"));
    return {
      kind: "item-history",
      ...itemIdentity(flags),
      limit: positiveInteger(flags.get("--limit"), 50, 25),
      ...(archiveCursor ? { archiveCursor } : {}),
      ...(orderCursor ? { orderCursor } : {}),
      ...(statusCursor ? { statusCursor } : {}),
      ...(annotationCursor ? { annotationCursor } : {}),
      ...(workCursor ? { workCursor } : {}),
    };
  }
  if (noun === "item" && verb === "activity") {
    const flags = commandFlags(rest, common, ["--cursor", "--limit"]);
    const cursor = optionalCursor(flags.get("--cursor"));
    return {
      kind: "item-activity",
      ...itemIdentity(flags),
      limit: positiveInteger(flags.get("--limit"), 25, 25),
      ...(cursor ? { cursor } : {}),
    };
  }
  if (noun === "work" && verb === "update") {
    const flags = commandFlags(rest, [...common, "--expected-fingerprint"]);
    return {
      kind: "work-update",
      ...itemIdentity(flags),
      expectedFingerprint: FINGERPRINT.parse(flags.get("--expected-fingerprint")),
    };
  }
  if (noun === "work" && verb === "enrich") {
    const flags = commandFlags(rest, [
      ...common,
      "--expected-fingerprint",
      "--expected-enrichment-version",
    ]);
    return {
      kind: "work-enrich",
      ...itemIdentity(flags),
      expectedFingerprint: FINGERPRINT.parse(flags.get("--expected-fingerprint")),
      expectedEnrichmentVersion: nonnegativeInteger(flags.get("--expected-enrichment-version")),
    };
  }
  if (noun === "work" && verb === "complete") {
    const flags = commandFlags(rest, preconditionFlags);
    return { kind: "work-complete", ...mutationPreconditions(flags) };
  }
  if (noun === "annotation" && verb === "add") {
    const flags = commandFlags(rest, [...common, "--expected-fingerprint"]);
    return {
      kind: "annotation-add",
      ...itemIdentity(flags),
      expectedFingerprint: FINGERPRINT.parse(flags.get("--expected-fingerprint")),
    };
  }
  if (noun === "annotation" && (verb === "edit" || verb === "delete")) {
    const flags = commandFlags(rest, [
      ...common,
      "--expected-fingerprint",
      "--annotation-id",
      "--expected-version",
    ]);
    return {
      kind: verb === "edit" ? "annotation-edit" : "annotation-delete",
      ...itemIdentity(flags),
      expectedFingerprint: FINGERPRINT.parse(flags.get("--expected-fingerprint")),
      annotationId: UUID.parse(flags.get("--annotation-id")),
      expectedVersion: positiveInteger(flags.get("--expected-version"), Number.MAX_SAFE_INTEGER, 1),
    };
  }
  if (noun === "organize" && verb === "place") {
    const flags = commandFlags(rest, preconditionFlags);
    return { kind: "organize-place", ...mutationPreconditions(flags) };
  }
  if (noun === "organize" && verb === "place-many") {
    const flags = commandFlags(rest, ["--dashboard-id", "--expected-revision"]);
    return {
      kind: "organize-place-many",
      dashboardId: UUID.parse(flags.get("--dashboard-id")),
      expectedRevision: nonnegativeInteger(flags.get("--expected-revision")),
    };
  }
  if (noun === "lifecycle" && (verb === "archive" || verb === "restore")) {
    const flags = commandFlags(rest, preconditionFlags);
    return {
      kind: verb === "archive" ? "lifecycle-archive" : "lifecycle-restore",
      ...mutationPreconditions(flags),
    };
  }
  if (noun === "todo" && verb === "create") {
    const flags = commandFlags(rest, ["--dashboard-id"]);
    return { kind: "todo-create", dashboardId: UUID.parse(flags.get("--dashboard-id")) };
  }
  if (noun === "follow-up" && verb === "create") {
    const flags = commandFlags(rest, preconditionFlags);
    return { kind: "follow-up-create", ...mutationPreconditions(flags) };
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
  const service = new DynaApplicationService({ actor: DYNA_CLI_ACTOR });
  try {
    let result: unknown;
    switch (command.kind) {
      case "setup":
        service.listDashboards();
        result = DynaCliSetupResultSchema.parse({
          schema: "dyna/setup-v1",
          ready: true,
          store: "available",
          credentialBoundary: "local-user",
        });
        break;
      case "dashboard-list":
        result = DynaDashboardListResultSchema.parse(service.listDashboards());
        break;
      case "dashboard-show":
        result = DynaDashboardShowResultSchema.parse(service.showDashboard(command.dashboardId));
        break;
      case "item-search":
        result = DynaItemSearchResultSchema.parse(
          service.searchItems(command.dashboardId, command.query, command.scope),
        );
        break;
      case "item-show":
        result = DynaItemShowResultSchema.parse(
          service.showItem(command.dashboardId, command.itemId),
        );
        break;
      case "item-history": {
        const history = service.itemHistory(command.dashboardId, command.itemId, {
          limit: command.limit,
          ...(command.archiveCursor ? { archiveCursor: command.archiveCursor } : {}),
          ...(command.orderCursor ? { orderCursor: command.orderCursor } : {}),
          ...(command.statusCursor ? { statusCursor: command.statusCursor } : {}),
          ...(command.annotationCursor ? { annotationCursor: command.annotationCursor } : {}),
          ...(command.workCursor ? { workCursor: command.workCursor } : {}),
        });
        result = DynaItemHistoryResultSchema.parse({
          schema: "dyna/item-history-result-v2",
          dashboardId: command.dashboardId,
          history,
        });
        break;
      }
      case "item-activity": {
        const activity = service.itemActivityPage(command.dashboardId, command.itemId, {
          limit: command.limit,
          ...(command.cursor ? { cursor: command.cursor } : {}),
        });
        result = DynaItemActivityResultSchema.parse({
          schema: "dyna/item-activity-result-v2",
          dashboardId: command.dashboardId,
          activity,
        });
        break;
      }
      case "work-update": {
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
      case "work-enrich": {
        const input = DynaTaskWorkEnrichInputSchema.parse(await readBoundedJson());
        result = DynaItemEnrichResultSchema.parse(
          service.enrichItemPatch(
            command.dashboardId,
            command.itemId,
            command.expectedFingerprint,
            command.expectedEnrichmentVersion,
            input,
          ),
        );
        break;
      }
      case "work-complete": {
        const input = DynaWorkCompleteInputSchema.parse(await readBoundedJson());
        result = DynaWorkCompleteResultSchema.parse(
          service.completeWork(
            command.dashboardId,
            command.itemId,
            command.expectedRevision,
            command.expectedFingerprint,
            input,
          ),
        );
        break;
      }
      case "annotation-add": {
        const input = DynaCliAnnotationAddInputSchema.parse(await readBoundedJson());
        result = DynaCliAnnotationMutationResultSchema.parse(
          service.addTaskAnnotation(
            command.dashboardId,
            command.itemId,
            command.expectedFingerprint,
            input,
          ),
        );
        break;
      }
      case "annotation-edit": {
        const input = DynaCliAnnotationEditInputSchema.parse(await readBoundedJson());
        result = DynaCliAnnotationMutationResultSchema.parse(
          service.editTaskAnnotation(
            command.dashboardId,
            command.itemId,
            command.annotationId,
            command.expectedVersion,
            command.expectedFingerprint,
            input,
          ),
        );
        break;
      }
      case "annotation-delete": {
        const input = DynaCliAnnotationDeleteInputSchema.parse(await readBoundedJson());
        result = DynaCliAnnotationMutationResultSchema.parse(
          service.deleteTaskAnnotation(
            command.dashboardId,
            command.itemId,
            command.annotationId,
            command.expectedVersion,
            command.expectedFingerprint,
            input,
          ),
        );
        break;
      }
      case "organize-place": {
        const input = DynaOrganizePlaceInputSchema.parse(await readBoundedJson());
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
      case "organize-place-many": {
        const input = DynaOrganizePlaceManyInputSchema.parse(await readBoundedJson());
        result = DynaPlaceManyResultSchema.parse(
          service.placeMany(command.dashboardId, command.expectedRevision, input),
        );
        break;
      }
      case "lifecycle-archive": {
        const input = DynaLifecycleArchiveInputSchema.parse(await readBoundedJson());
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
      case "lifecycle-restore": {
        const input = DynaLifecycleRestoreInputSchema.parse(await readBoundedJson());
        result = DynaItemRestoreResultSchema.parse(
          service.restoreItem(
            command.dashboardId,
            command.itemId,
            command.expectedRevision,
            command.expectedFingerprint,
            input,
          ),
        );
        break;
      }
      case "todo-create": {
        const input = DynaTodoCreateInputSchema.parse(await readBoundedJson());
        result = DynaTodoCreateResultSchema.parse(service.createTodo(command.dashboardId, input));
        break;
      }
      case "follow-up-create": {
        const input = DynaFollowUpCreateInputSchema.parse(await readBoundedJson());
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

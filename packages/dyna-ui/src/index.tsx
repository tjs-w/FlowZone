import "./styles.css";

import { Alert } from "@openai/apps-sdk-ui/components/Alert";
import { Badge } from "@openai/apps-sdk-ui/components/Badge";
import { Button } from "@openai/apps-sdk-ui/components/Button";
import { Input } from "@openai/apps-sdk-ui/components/Input";
import { Textarea } from "@openai/apps-sdk-ui/components/Textarea";
import { applyDocumentTheme } from "@openai/apps-sdk-ui/theme";
import {
  App,
  type AppEventMap,
  type McpUiHostCapabilities,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import {
  DynaWorkActivityPageSchema,
  DynaUiPayloadSchema,
  dynaSourceUrl,
  type DynaCodexSessionCandidate,
  type DynaSourceRef,
  type DynaWorkActivityPage,
  type DynaUiPayload,
} from "@flowzone/dyna-contracts";
import {
  createContext,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";

interface DynaIconProps {
  readonly className?: string;
  readonly "aria-hidden"?: boolean | "true" | "false";
}

function dynaIcon(path: string) {
  return function DynaIcon(props: DynaIconProps) {
    return (
      <svg
        {...props}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
        focusable="false"
      >
        <path d={path} />
      </svg>
    );
  };
}

const Archive = dynaIcon("M3 5h10v9H3zM2 2h12v3H2M6 8h4");
const ArrowLeft = dynaIcon("M13 8H3m4-4L3 8l4 4");
const CheckSquare = dynaIcon(
  "M3 2h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1m2 6 2 2 4-4",
);
const ChevronRight = dynaIcon("m6 3 5 5-5 5");
const Copy = dynaIcon("M5 5h9v9H5zM2 11V2h9");
const ExternalLink = dynaIcon("M9 2h5v5m0-5L7 9m5 0v5H2V4h5");
const Plus = dynaIcon("M8 3v10M3 8h10");
const RefreshCw = dynaIcon("M13 4V1h-3m2 2a6 6 0 1 0 2 6");
const RestoreUntrash = dynaIcon("M3 8a5 5 0 1 0 2-4M3 2v4h4");
const Search = dynaIcon("M7 2a5 5 0 1 0 0 10A5 5 0 0 0 7 2m4 9 3 3");
const X = dynaIcon("M3 3l10 10M13 3 3 13");

type ActionName =
  | "annotate"
  | "open_source"
  | "create_codex_task"
  | "open_codex_task"
  | "refresh_codex_status"
  | "list_codex_sessions"
  | "attach_codex_task";

type TodoPriority = "critical" | "high" | "normal" | "low";
type WorkflowStage = "todo" | "executing" | "needs_you" | "completed";
type WorkflowChoice = WorkflowStage | "follow_up";
type ManualWorkflowStage = "todo" | "needs_you" | "done";
type PriorityFilter = TodoPriority | "all";
type WorkflowFilter = WorkflowStage | "blocked" | "all";
type DashboardView = "queue" | "pipeline" | "archive";
type ScrollSurface = DashboardView;
type ArchiveReason = "invalid" | "duplicate" | "no_action_needed" | "superseded" | "other";

const INLINE_SUMMARY_MAX_LENGTH = 240;
const CARD_MATCH_MAX_LENGTH = 180;
const DYNA_DRAG_TYPE = "application/x-flowzone-dyna-item";

interface DynaBulkPlacementItem {
  readonly itemId: string;
  readonly expectedFingerprint: string;
}

type DynaHostContext = McpUiHostContext & {
  readonly locale?: string;
  readonly timeZone?: string;
  readonly platform?: string;
  readonly deviceCapabilities?: McpUiHostContext["deviceCapabilities"] & {
    readonly touch?: boolean;
  };
};

interface DynaUiController {
  annotate(itemId: string, trigger: HTMLElement): void;
  closeDetails(): void;
  openDetails(itemId: string, trigger: HTMLElement): Promise<void>;
  startTodo(
    trigger: HTMLElement,
    title?: string,
    summary?: string,
    followUpOfItemId?: string,
  ): void;
  organize(
    itemId: string,
    fingerprint: string,
    action: "bump" | "lower" | "earlier" | "later",
    trigger: HTMLElement,
  ): Promise<void>;
  place(
    itemId: string,
    fingerprint: string,
    targetPriority: TodoPriority,
    beforeItemId: string | undefined,
    trigger: HTMLElement,
  ): Promise<void>;
  bulkPlace(
    items: readonly DynaBulkPlacementItem[],
    targetPriority: TodoPriority,
    trigger: HTMLElement,
  ): Promise<void>;
  moveToStage(
    itemId: string,
    fingerprint: string,
    target: WorkflowChoice,
    trigger: HTMLElement,
  ): Promise<void>;
  copyContext(card: CardViewProps): Promise<void>;
  refreshLatest(trigger: HTMLElement): Promise<void>;
  readonly loadActivity: (itemId: string, cursor?: string) => Promise<DynaActivityPage>;
  loadCodexSessions(
    itemId: string,
    fingerprint: string,
    trigger: HTMLElement,
  ): Promise<DynaCodexSessionList>;
  associateCodexSession(
    itemId: string,
    fingerprint: string,
    candidate: DynaCodexSessionCandidate,
    sessionListRequestId: string,
    trigger: HTMLElement,
  ): Promise<void>;
  archive(
    itemId: string,
    fingerprint: string,
    title: string,
    trigger: HTMLElement,
    reason?: "completed",
  ): void;
  restore(itemId: string, fingerprint: string, title: string, trigger: HTMLElement): void;
  request(
    itemId: string,
    fingerprint: string,
    kind: Exclude<ActionName, "annotate">,
    taskId?: string,
    taskHostId?: string,
    trigger?: HTMLElement,
  ): Promise<void>;
  readonly busy: boolean;
  readonly refreshing: boolean;
  readonly blocked: boolean;
  readonly codexActionsBlocked: boolean;
  readonly readOnly: boolean;
  readonly messageUnavailable: boolean;
  readonly displayMode: "inline" | "fullscreen" | "pip";
  readonly inspectorPresentation: "route" | "split";
  readonly modalOpen: boolean;
  readonly canExpand: boolean;
  readonly condenseInline: boolean;
  readonly initialExpansionPending: boolean;
  readonly inlineCardLimit: 4 | 5;
  readonly locale: string;
  readonly leadershipOnly: boolean;
  readonly bulkMode: boolean;
  readonly bulkSelectedIds: readonly string[];
  readonly priorityFilter: PriorityFilter;
  readonly query: string;
  readonly selectedItemId: string | undefined;
  readonly serverQuery: string;
  readonly sourceFilter: string;
  readonly workflowFilter: WorkflowFilter;
  readonly externalLinks: boolean;
  readonly view: DashboardView;
  clearFilters(): void;
  setBulkMode(value: boolean): void;
  setBulkItemsSelected(itemIds: readonly string[], selected: boolean): void;
  setLeadershipOnly(value: boolean): void;
  setPriorityFilter(value: PriorityFilter): void;
  setQuery(value: string): void;
  setSourceFilter(value: string): void;
  setWorkflowFilter(value: WorkflowFilter): void;
  setView(value: DashboardView): void;
  openExternal(url: string): Promise<void>;
  expand(trigger?: HTMLElement): Promise<void>;
}

const ControllerContext = createContext<DynaUiController | null>(null);

function useController(): DynaUiController {
  const controller = useContext(ControllerContext);
  if (!controller) throw new Error("Dyna UI controller is unavailable.");
  return controller;
}

function handleExternalAnchorClick(
  event: ReactMouseEvent<HTMLAnchorElement>,
  url: string,
  controller: DynaUiController,
): void {
  if (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    !controller.externalLinks
  ) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  void controller.openExternal(url);
}

function relativeTime(value: string, locale?: string): string {
  const seconds = Math.round((Date.parse(value) - Date.now()) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function exactDateTime(value: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

async function writeClipboardText(value: string): Promise<void> {
  try {
    const clipboard = Reflect.get(navigator, "clipboard") as Clipboard | undefined;
    if (clipboard && typeof clipboard.writeText === "function") {
      await clipboard.writeText(value);
      return;
    }
  } catch {
    // Fall through to the locally scoped legacy browser path.
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto -9999px";
  document.body.append(textarea);
  textarea.select();
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- Required for older host webviews without the Clipboard API.
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard access is unavailable.");
}

function humanize(value: string): string {
  return value
    .split("_")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function sourceReferenceLabel(sourceRef: unknown): string {
  if (!sourceRef || typeof sourceRef !== "object" || Array.isArray(sourceRef)) {
    return "Stored source record";
  }
  const source = sourceRef as Readonly<Record<string, unknown>>;
  const parts = [
    source["projectPath"],
    source["repository"],
    source["entityType"],
    source["iid"],
    source["entityId"],
    source["channelId"],
    source["messageId"],
    source["resultType"],
    source["recordId"],
    source["taskId"],
    source["skillName"],
  ].filter((value): value is string | number =>
    typeof value === "string" ? value.length > 0 : typeof value === "number",
  );
  return parts.length > 0 ? parts.slice(0, 4).join(" · ") : "Stored source record";
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      "a[href], button:not([disabled]), input:not([disabled]):not([type='hidden']), textarea:not([disabled]), select:not([disabled]), summary:not([aria-disabled='true']), [tabindex]:not([tabindex='-1'])",
    ),
  ].filter((element) => {
    const closedDetails = element.closest<HTMLDetailsElement>("details:not([open])");
    if (closedDetails && closedDetails.querySelector(":scope > summary") !== element) return false;
    const style = getComputedStyle(element);
    return element.getClientRects().length > 0 && style.visibility !== "hidden";
  });
}

function closeOrganizationMenus(
  options: {
    readonly except?: HTMLDetailsElement;
    readonly restoreFocus?: boolean;
  } = {},
): void {
  const open = [...document.querySelectorAll<HTMLDetailsElement>(".dyna-row-organize[open]")];
  const focusTarget = options.restoreFocus
    ? open.find((menu) => menu !== options.except)?.querySelector<HTMLElement>("summary")
    : undefined;
  for (const menu of open) {
    if (menu !== options.except) menu.open = false;
  }
  if (focusTarget?.isConnected) {
    window.setTimeout(() => {
      focusTarget.focus({ preventScroll: true });
    }, 0);
  }
}

function lockBodyScroll(): () => void {
  const previousOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  return () => {
    document.body.style.overflow = previousOverflow;
  };
}

function InspectorShell({
  id,
  labelledBy,
  onClose,
  children,
}: {
  readonly id: string;
  readonly labelledBy: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const controller = useController();
  const panel = useRef<HTMLDivElement | null>(null);
  const routePresentation = controller.inspectorPresentation === "route";

  useEffect(() => {
    const inspector = panel.current;
    inspector
      ?.querySelector<HTMLElement>(
        routePresentation ? "[data-dyna-inspector-back]" : "[data-dyna-inspector-close]",
      )
      ?.focus();
  }, [routePresentation]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector(".dyna-context-menu")) return;
      if (event.key === "Escape") {
        if (document.querySelector(".dyna-dialog")) return;
        event.preventDefault();
        onClose();
        return;
      }
      const inspector = panel.current;
      if (!routePresentation || event.key !== "Tab" || !inspector) return;
      const focusable = focusableElements(inspector);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, routePresentation]);

  return createPortal(
    <div className="dyna-inspector-layer" data-presentation={routePresentation ? "route" : "split"}>
      <div
        id={id}
        ref={panel}
        className="dyna-inspector"
        role={routePresentation ? "dialog" : "region"}
        aria-modal={routePresentation ? true : undefined}
        aria-labelledby={labelledBy}
        aria-hidden={controller.modalOpen ? true : undefined}
        inert={controller.modalOpen ? true : undefined}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

function toolResultFailed(result: unknown): boolean {
  return Boolean(
    result &&
    typeof result === "object" &&
    (result as Readonly<Record<string, unknown>>)["isError"] === true,
  );
}

interface DynaCodexSessionList {
  readonly requestId: string;
  readonly candidates: readonly DynaCodexSessionCandidate[];
}

interface DynaActionDispatch {
  readonly requestId: string;
  readonly state: string;
}

interface DynaActionStatus {
  readonly state: string;
  readonly candidates?: readonly DynaCodexSessionCandidate[];
}

function codexSessionKey(candidate: Pick<DynaCodexSessionCandidate, "hostId" | "taskId">): string {
  return JSON.stringify([candidate.hostId, candidate.taskId]);
}

function parseCodexSessionCandidates(
  value: unknown,
): readonly DynaCodexSessionCandidate[] | undefined {
  if (!Array.isArray(value) || value.length > 50) return undefined;
  const candidates: DynaCodexSessionCandidate[] = [];
  const keys = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    const record = candidate as Readonly<Record<string, unknown>>;
    const taskId = record["taskId"];
    const hostId = record["hostId"];
    const title = record["title"];
    const updatedAt = record["updatedAt"];
    const projectId = record["projectId"];
    if (
      typeof taskId !== "string" ||
      taskId.length === 0 ||
      taskId.length > 256 ||
      typeof hostId !== "string" ||
      hostId.length === 0 ||
      hostId.length > 256 ||
      typeof title !== "string" ||
      title.trim().length === 0 ||
      title.length > 200 ||
      typeof updatedAt !== "string" ||
      updatedAt.length > 64 ||
      !Number.isFinite(Date.parse(updatedAt)) ||
      (projectId !== undefined &&
        (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 256))
    ) {
      return undefined;
    }
    const parsed: DynaCodexSessionCandidate = {
      taskId,
      hostId,
      title: title.trim(),
      updatedAt,
      ...(typeof projectId === "string" ? { projectId } : {}),
    };
    const key = codexSessionKey(parsed);
    if (!keys.has(key)) {
      keys.add(key);
      candidates.push(parsed);
    }
  }
  return candidates;
}

function parseDynaActionStatus(result: unknown): DynaActionStatus | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const resultRecord = result as Readonly<Record<string, unknown>>;
  const structured = resultRecord["structuredContent"];
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return undefined;
  const record = structured as Readonly<Record<string, unknown>>;
  const state = record["state"];
  if (typeof state !== "string") return undefined;
  const metadata = resultRecord["_meta"];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return { state };
  const metadataRecord = metadata as Readonly<Record<string, unknown>>;
  if (!("dynaCodexSessionCandidates" in metadataRecord)) return { state };
  const candidates = parseCodexSessionCandidates(metadataRecord["dynaCodexSessionCandidates"]);
  return candidates ? { state, candidates } : undefined;
}

type DynaSnapshot = DynaUiPayload["snapshot"];
type DynaCard = DynaSnapshot["cards"][number];
type DynaSchedule = DynaSnapshot["schedules"][number];
type DynaSourceSlice = NonNullable<DynaSchedule["lastSourceSlices"]>[number];
type DynaTask = DynaCard["linkedTasks"][number];
type DynaWorkUpdate = DynaCard["workUpdates"][number];

type DynaActivityPage = DynaWorkActivityPage;

interface DynaCardUxFields {
  readonly workUpdateCount?: number;
  readonly workConditionSummary?: string;
  readonly workConditionTask?: {
    readonly taskId: string;
    readonly hostId: string;
  };
  readonly matchedActivity?: string;
}

function sourceSliceLabel(source: DynaSourceSlice["source"]): string {
  return {
    slack: "Slack",
    outlook: "Outlook",
    gitlab: "GitLab",
    codex: "Codex",
    email: "Email",
    messaging: "Messaging",
    scm: "Source control",
    twg: "TWG",
    skill: "Skill",
  }[source];
}

function workUpdateKindLabel(kind: DynaWorkUpdate["kind"]): string {
  return {
    note: "Note",
    progress: "Progress",
    decision: "Decision",
    needs_input: "Needs input",
    blocked: "Blocked",
    completion_reported: "Completion reported",
    handoff: "Handoff",
  }[kind];
}

function workUpdateTaskLabel(update: DynaWorkUpdate): string | undefined {
  if (!update.task) return undefined;
  return update.task.title ?? `Codex task ${update.task.taskId}`;
}

function compactLine(value: string, maximum = CARD_MATCH_MAX_LENGTH): string {
  const line = value.replaceAll(/\s+/gu, " ").trim();
  if (line.length <= maximum) return line;
  return `${line.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}

function activityPage(value: unknown, expectedItemId: string): DynaActivityPage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const metadata = (value as Readonly<Record<string, unknown>>)["_meta"];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const page = (metadata as Readonly<Record<string, unknown>>)["dynaWorkActivity"];
  const parsed = DynaWorkActivityPageSchema.safeParse(page);
  return parsed.success && parsed.data.itemId === expectedItemId ? parsed.data : undefined;
}

function untrustedPromptText(value: string): string {
  return value
    .replaceAll("BEGIN UNTRUSTED DYNA CONTEXT", "[escaped BEGIN UNTRUSTED DYNA CONTEXT]")
    .replaceAll("END UNTRUSTED DYNA CONTEXT", "[escaped END UNTRUSTED DYNA CONTEXT]");
}

const SOURCE_ICONS = {
  bitbucket: ["#2684ff", "M1 1h14l-2 14H3Zm4 4 1 6h4l1-6"],
  codex: ["currentColor", "M8 1l7 4v6l-7 4-7-4V5Zm0 4L4 7v3l4 2 4-2V7Z"],
  confluence: ["#0052cc", "M1 11q4-7 14-1l-2 4q-7-4-10 1Zm14-6Q11 12 1 6l2-4q7 4 10-1Z"],
  discord: ["#5865f2", "M3 4q5-3 10 0l2 8-3 2-2-2H6l-2 2-3-2 2-8Zm2 3v2h2V7Zm4 0v2h2V7Z"],
  email: ["#687078", "M1 3h14v10H1Zm2 2 5 4 5-4"],
  github: ["currentColor", "M3 6 2 2l4 2h4l4-2-1 4q0 4-4 5v3l-3-2-3 2v-3Q2 10 3 6Z"],
  gitlab: ["#e24329", "M1 6 3 1l2 5h6l2-5 2 5-7 9"],
  jira: ["#1868db", "M8 1l7 7-7 7-7-7Zm0 4 3 3-3 3-3-3"],
  messaging: ["#27736f", "M1 2h14v10H5l-4 3Zm3 4h8v2H4Z"],
  outlook: ["#0078d4", "M1 3h6v10H1Zm8 1h6v8H9l3-4"],
  scm: ["#525866", "M1 1h4v4H1Zm10 0h4v4h-4ZM6 11h4v4H6ZM4 3h8v2H9v6H7V5H4Z"],
  skill: ["#8b6217", "M8 1l2 5 5 2-5 2-2 5-2-5-5-2 5-2Z"],
  slack: ["#4a154b", "M4 1h3v5h3V3h3v3h2v3h-2v4h-3V9H7v3H4V9H1V6h3Z"],
  twg: ["#6554c0", "M1 1h4v4H1Zm10 5h4v4h-4ZM1 11h4v4H1ZM5 3l6 4-6 6Z"],
} as const;

type SourceIconKind = keyof typeof SOURCE_ICONS;

function sourceIcon(sourceRef: DynaSourceRef): SourceIconKind {
  if (sourceRef.source === "twg") {
    const kind = sourceRef.resultType;
    return /^(jira|confluence|bitbucket)$/.test(kind) ? (kind as SourceIconKind) : "twg";
  }
  if ("provider" in sourceRef) {
    const provider = sourceRef.provider.toLowerCase();
    const kind = /github|gitlab|bitbucket|slack|discord/.exec(provider)?.[0];
    if (kind) return kind as SourceIconKind;
    if (/outlook|microsoft/.test(provider)) return "outlook";
  }
  return sourceRef.source === "manual" ? "skill" : sourceRef.source;
}

function SourceFavicon({
  kind,
  label,
}: {
  readonly kind: SourceIconKind;
  readonly label?: string;
}): ReactNode {
  const [color, path] = SOURCE_ICONS[kind];
  return (
    <svg
      className="dyna-source-favicon"
      data-source-icon={kind}
      viewBox="0 0 16 16"
      fill={color}
      role="img"
      aria-hidden={!label || undefined}
      aria-label={label}
    >
      <path d={path} />
    </svg>
  );
}

function readDragItem(dataTransfer: DataTransfer):
  | {
      readonly itemId: string;
      readonly fingerprint: string;
      readonly workflowStage: WorkflowStage;
    }
  | undefined {
  const raw = dataTransfer.getData(DYNA_DRAG_TYPE);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Readonly<Record<string, unknown>>;
    return typeof parsed["itemId"] === "string" &&
      typeof parsed["fingerprint"] === "string" &&
      typeof parsed["workflowStage"] === "string" &&
      PIPELINE_STAGES.some(([stage]) => stage === parsed["workflowStage"]) &&
      /^[a-f0-9]{64}$/.test(parsed["fingerprint"])
      ? {
          itemId: parsed["itemId"],
          fingerprint: parsed["fingerprint"],
          workflowStage: parsed["workflowStage"] as WorkflowStage,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

interface ActionDescriptor {
  readonly name: ActionName;
  readonly label: string;
  readonly taskId?: string;
  readonly taskHostId?: string;
}

type CardViewProps = Omit<DynaCard, "id" | "annotations" | "linkedTasks"> &
  DynaCardUxFields & {
    readonly dashboardId: string;
    readonly dashboardName: string;
    readonly itemId: string;
    readonly searchText: string;
    readonly annotationPreview: readonly {
      readonly body: string;
      readonly createdAt: string;
    }[];
    readonly actions: readonly ActionDescriptor[];
    readonly linkedTasks: readonly DynaTask[];
    readonly workflowStage: WorkflowStage;
    readonly workflowCondition?: string;
    readonly workflowSummary?: string;
    readonly sourceUrl?: string;
  };

type DynaContextMenuKind = "selection" | "link" | "item" | "task" | "dashboard";

interface DynaContextMenuState {
  readonly kind: DynaContextMenuKind;
  readonly x: number;
  readonly y: number;
  readonly invoker: HTMLElement;
  readonly keyboard: boolean;
  readonly inspector?: boolean;
  readonly itemId?: string;
  readonly linkUrl?: string;
  readonly selection?: string;
  readonly taskId?: string;
  readonly taskHostId?: string;
}

function contextSelection(
  target: Element,
  x: number,
  y: number,
  keyboard: boolean,
): string | undefined {
  const field = target.closest<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
  if (field) {
    const start = field.selectionStart;
    const end = field.selectionEnd;
    return start !== null && end !== null && end > start
      ? field.value.slice(start, end)
      : undefined;
  }
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  const text = selection.toString();
  if (!text) return undefined;
  const range = selection.getRangeAt(0);
  if (keyboard) {
    try {
      return range.intersectsNode(target) ? text : undefined;
    } catch {
      return undefined;
    }
  }
  return [...range.getClientRects()].some(
    (rect) =>
      rect.width > 0 &&
      rect.height > 0 &&
      x >= rect.left - 2 &&
      x <= rect.right + 2 &&
      y >= rect.top - 2 &&
      y <= rect.bottom + 2,
  )
    ? text
    : undefined;
}

function contextLink(target: Element): string | undefined {
  const href = target.closest<HTMLAnchorElement>("a[href]")?.href;
  if (!href) return undefined;
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

interface ComponentArgs<Props> {
  readonly props: Props;
  readonly children?: ReactNode;
}

interface DynaComponentCatalog {
  readonly Dashboard: (
    args: ComponentArgs<{
      readonly dashboardId: string;
      readonly name: string;
      readonly description: string;
      readonly freshness: DynaSnapshot["freshness"];
      readonly generatedAt: string;
      readonly revision: number;
      readonly sourceOptions: readonly string[];
      readonly sourceAttention: boolean;
    }>,
  ) => ReactNode;
  readonly SummaryStrip: (
    args: ComponentArgs<{
      readonly needsYou: number;
      readonly inCodex: number;
      readonly blocked: number;
      readonly shown: number;
      readonly total: number;
    }>,
  ) => ReactNode;
  readonly ExecutiveSummary: (
    args: ComponentArgs<{
      readonly model: ExecutiveSummaryModel;
      readonly condensed: boolean;
    }>,
  ) => ReactNode;
  readonly Section: (
    args: ComponentArgs<{
      readonly title: string;
      readonly emptyMessage: string;
      readonly count: number;
      readonly attention?: boolean;
      readonly priority?: TodoPriority;
      readonly itemIds?: readonly string[];
    }>,
  ) => ReactNode;
  readonly QueueView: (args: ComponentArgs<Record<string, never>>) => ReactNode;
  readonly PipelineView: (
    args: ComponentArgs<{
      readonly stages: readonly {
        readonly state: WorkflowStage;
        readonly title: string;
        readonly count: number;
      }[];
    }>,
  ) => ReactNode;
  readonly PipelineStage: (
    args: ComponentArgs<{
      readonly state: WorkflowStage;
      readonly title: string;
      readonly count: number;
    }>,
  ) => ReactNode;
  readonly ArchiveView: (args: ComponentArgs<{ readonly count: number }>) => ReactNode;
  readonly PriorityCard: (args: ComponentArgs<CardViewProps>) => ReactNode;
  readonly TaskStatus: (
    args: ComponentArgs<
      DynaTask & {
        readonly itemId: string;
        readonly itemFingerprint: string;
      }
    >,
  ) => ReactNode;
  readonly ScheduleStatus: (args: ComponentArgs<DynaSchedule>) => ReactNode;
  readonly EmptyState: (args: ComponentArgs<{ readonly message: string }>) => ReactNode;
}

function OrganizationMenu({
  card,
  trigger,
  label,
}: {
  readonly card: CardViewProps;
  readonly trigger: RefObject<HTMLElement | null>;
  readonly label: string;
}) {
  const controller = useController();
  const organize = (
    event: ReactMouseEvent<HTMLButtonElement>,
    action: "bump" | "lower" | "earlier" | "later",
  ) => {
    event.currentTarget.closest("details")?.removeAttribute("open");
    if (trigger.current) {
      void controller.organize(card.itemId, card.fingerprint, action, trigger.current);
    }
  };
  return (
    <div className="dyna-overflow-menu" aria-label={label}>
      <button
        type="button"
        disabled={controller.busy || controller.blocked || card.priority === "critical"}
        onClick={(event) => {
          organize(event, "bump");
        }}
      >
        Raise priority
      </button>
      <button
        type="button"
        disabled={controller.busy || controller.blocked || card.priority === "low"}
        onClick={(event) => {
          organize(event, "lower");
        }}
      >
        Lower priority
      </button>
      <div className="dyna-overflow-separator" role="separator" />
      <button
        type="button"
        disabled={controller.busy || controller.blocked || !card.canMoveEarlier}
        onClick={(event) => {
          organize(event, "earlier");
        }}
      >
        Move earlier in group
      </button>
      <button
        type="button"
        disabled={controller.busy || controller.blocked || !card.canMoveLater}
        onClick={(event) => {
          organize(event, "later");
        }}
      >
        Move later in group
      </button>
    </div>
  );
}

function BulkActions({ cards }: { readonly cards: readonly DynaCard[] }) {
  const controller = useController();
  const [targetPriority, setTargetPriority] = useState<TodoPriority | "">("");
  const selected = new Set(controller.bulkSelectedIds);
  const selectedCards = cards.filter((card) => selected.has(card.id));
  const allVisibleSelected = cards.length > 0 && cards.every((card) => selected.has(card.id));
  const targetDisabled =
    targetPriority !== "" &&
    selectedCards.length > 0 &&
    selectedCards.every((card) => card.priority === targetPriority);

  return (
    <section className="dyna-bulk-bar" aria-label="Bulk queue actions">
      <span className="dyna-bulk-count" role="status" aria-live="polite">
        <strong>{selectedCards.length}</strong> selected
      </span>
      <button
        type="button"
        className="dyna-bulk-select-all"
        disabled={cards.length === 0 || controller.busy}
        onClick={() => {
          controller.setBulkItemsSelected(
            cards.map((card) => card.id),
            !allVisibleSelected,
          );
        }}
      >
        {allVisibleSelected ? "Clear shown" : `Select all ${cards.length} shown`}
      </button>
      <label className="dyna-bulk-destination">
        <span className="dyna-visually-hidden">Move selected items to group</span>
        <select
          aria-label="Move selected items to group"
          value={targetPriority}
          disabled={selectedCards.length === 0 || controller.busy || controller.blocked}
          onChange={(event) => {
            setTargetPriority(event.currentTarget.value as TodoPriority | "");
          }}
        >
          <option value="">Move to group…</option>
          {PRIORITY_GROUPS.map(([priority, title]) => (
            <option
              key={priority}
              value={priority}
              disabled={
                selectedCards.length > 0 &&
                selectedCards.every((card) => card.priority === priority)
              }
            >
              {title}
            </option>
          ))}
        </select>
      </label>
      <Button
        color="primary"
        size="sm"
        disabled={
          selectedCards.length === 0 ||
          targetPriority === "" ||
          targetDisabled ||
          controller.busy ||
          controller.blocked
        }
        onClick={(event) => {
          if (!targetPriority) return;
          void controller.bulkPlace(
            selectedCards.map((card) => ({
              itemId: card.id,
              expectedFingerprint: card.fingerprint,
            })),
            targetPriority,
            event.currentTarget,
          );
        }}
      >
        Move
      </Button>
      <Button
        color="secondary"
        size="sm"
        variant="ghost"
        disabled={controller.busy}
        onClick={() => {
          controller.setBulkMode(false);
        }}
      >
        Cancel
      </Button>
    </section>
  );
}

function StatusSelect({ card }: { readonly card: CardViewProps }) {
  const controller = useController();
  const [engaged, setEngaged] = useState(false);
  const linked = card.linkedTasks.length > 0;
  const completed = card.workflowStage === "completed";
  // Keep the 200-item queue light: native options are only needed once the
  // control is about to be used. Progress and the selected item's inspector
  // keep their options mounted for deterministic keyboard and test behavior.
  const showOptions =
    engaged || controller.view !== "queue" || controller.selectedItemId === card.itemId;
  return card.archive ? (
    <span className="dyna-row-status">Archived</span>
  ) : (
    <label className="dyna-status-control">
      <span className="dyna-row-status" aria-hidden="true">
        {workflowStageLabel(card.workflowStage)}
      </span>
      <select
        className="dyna-status-select"
        data-dyna-status-item={card.itemId}
        data-dyna-action={`${card.itemId}:status`}
        aria-label={`Change status for ${card.title}`}
        value={card.workflowStage}
        disabled={controller.busy || controller.blocked}
        onFocus={() => {
          setEngaged(true);
        }}
        onBlur={() => {
          setEngaged(false);
        }}
        onPointerDownCapture={() => {
          setEngaged(true);
        }}
        onChange={(event) => {
          const target = event.currentTarget.value as WorkflowChoice;
          void controller.moveToStage(card.itemId, card.fingerprint, target, event.currentTarget);
        }}
      >
        {showOptions ? (
          <>
            <option value="todo" disabled={linked || completed}>
              {linked ? "To Do — linked to Codex" : "To Do"}
            </option>
            <option value="executing" disabled={completed}>
              {linked
                ? card.workflowStage === "needs_you"
                  ? "Open in Codex…"
                  : "In Codex"
                : "Start in Codex…"}
            </option>
            <option value="needs_you" disabled={linked || completed}>
              {linked ? "Needs You — set by Codex" : "Needs You"}
            </option>
            <option value="completed" disabled={completed}>
              {linked ? "Verify Done…" : "Done…"}
            </option>
            {completed ? <option value="follow_up">Create follow-up…</option> : null}
          </>
        ) : null}
      </select>
    </label>
  );
}

function RefreshButton() {
  const controller = useController();
  const label = controller.refreshing ? "Refreshing dashboard" : "Refresh dashboard";
  return (
    <Button
      className="dyna-refresh-action"
      data-dyna-refresh="true"
      color="secondary"
      size="xs"
      variant="ghost"
      uniform
      aria-label={label}
      aria-busy={controller.refreshing}
      title="Refresh dashboard"
      disabled={controller.busy || controller.refreshing || controller.readOnly}
      onClick={(event) => {
        event.currentTarget.focus({ preventScroll: true });
        void controller.refreshLatest(event.currentTarget);
      }}
    >
      <RefreshCw className="dyna-icon" aria-hidden="true" />
    </Button>
  );
}

function InspectorActions({ card }: { readonly card: CardViewProps }) {
  const controller = useController();
  const primaryAction = card.actions.find(
    (action) => action.name === "create_codex_task" || action.name === "open_codex_task",
  );
  const sourceAction = card.actions.find((action) => action.name === "open_source");
  const noteAction = card.actions.find((action) => action.name === "annotate");

  const runAction = (action: ActionDescriptor, trigger: HTMLElement) => {
    if (action.name === "annotate") {
      controller.annotate(card.itemId, trigger);
      return;
    }
    void controller.request(
      card.itemId,
      card.fingerprint,
      action.name,
      action.taskId,
      action.taskHostId,
      trigger,
    );
  };

  return (
    <div className="dyna-inspector-actions">
      <div className="dyna-actions">
        {card.workflowStage === "completed" || card.archive ? (
          <Button
            className="dyna-primary-action"
            color="primary"
            size="xs"
            onClick={(event) => {
              controller.startTodo(
                event.currentTarget,
                `Follow up: ${card.title}`,
                `Continue from historical work: ${card.outcome ?? card.summary}`,
                card.itemId,
              );
            }}
            disabled={controller.busy || controller.blocked}
          >
            <Plus className="dyna-icon" aria-hidden="true" />
            Create follow-up
          </Button>
        ) : primaryAction ? (
          <Button
            className="dyna-primary-action"
            data-dyna-action={`${card.itemId}:${primaryAction.name}`}
            color="primary"
            size="xs"
            onClick={(event) => {
              runAction(primaryAction, event.currentTarget);
            }}
            disabled={controller.busy || controller.codexActionsBlocked}
          >
            {primaryAction.name === "create_codex_task" ? (
              <Plus className="dyna-icon" aria-hidden="true" />
            ) : (
              <ExternalLink className="dyna-icon" aria-hidden="true" />
            )}
            {primaryAction.label}
          </Button>
        ) : null}
        {sourceAction && card.sourceUrl ? (
          <a
            className="dyna-action-link"
            data-dyna-source-link={card.itemId}
            href={card.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => {
              handleExternalAnchorClick(event, card.sourceUrl ?? "", controller);
            }}
          >
            <ExternalLink className="dyna-icon" aria-hidden="true" />
            Open source
          </a>
        ) : sourceAction ? (
          <Button
            data-dyna-action={`${card.itemId}:${sourceAction.name}`}
            color="secondary"
            size="xs"
            variant="outline"
            onClick={(event) => {
              runAction(sourceAction, event.currentTarget);
            }}
            disabled={controller.busy || controller.codexActionsBlocked}
          >
            <ExternalLink className="dyna-icon" aria-hidden="true" />
            {sourceAction.label}
          </Button>
        ) : null}
        {noteAction ? (
          <Button
            className="dyna-note-action"
            data-dyna-action={`${card.itemId}:${noteAction.name}`}
            data-dyna-annotation-item={card.itemId}
            color="secondary"
            size="xs"
            variant="ghost"
            onClick={(event) => {
              runAction(noteAction, event.currentTarget);
            }}
            disabled={controller.busy || controller.blocked}
          >
            Add note
          </Button>
        ) : null}
      </div>
      <div className="dyna-utility-actions">
        <Button
          className="dyna-icon-action"
          color="secondary"
          size="xs"
          variant="ghost"
          uniform
          aria-label="Copy work prompt"
          title="Copy work prompt"
          data-dyna-copy-context={card.itemId}
          onClick={() => {
            void controller.copyContext(card);
          }}
        >
          <Copy className="dyna-icon" aria-hidden="true" />
        </Button>
        {card.archive ? (
          <Button
            className="dyna-icon-action"
            color="secondary"
            size="xs"
            variant="ghost"
            uniform
            aria-label="Restore to active board"
            title="Restore to active board"
            onClick={(event) => {
              controller.restore(card.itemId, card.fingerprint, card.title, event.currentTarget);
            }}
            disabled={controller.busy || controller.blocked}
          >
            <RestoreUntrash className="dyna-icon" aria-hidden="true" />
          </Button>
        ) : (
          <Button
            className="dyna-icon-action dyna-archive-action"
            color="danger"
            size="xs"
            variant="ghost"
            uniform
            aria-label={card.workflowStage === "completed" ? "Archive now" : "Archive item"}
            title={card.workflowStage === "completed" ? "Archive now" : "Archive item"}
            onClick={(event) => {
              controller.archive(
                card.itemId,
                card.fingerprint,
                card.title,
                event.currentTarget,
                card.workflowStage === "completed" ? "completed" : undefined,
              );
            }}
            disabled={controller.busy || controller.blocked}
          >
            <Archive className="dyna-icon" aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );
}

function DynaContextMenu({
  state,
  card,
  onClose,
  onCopy,
}: {
  readonly state: DynaContextMenuState;
  readonly card?: CardViewProps;
  readonly onClose: (restoreFocus: boolean) => void;
  readonly onCopy: (value: string, message: string) => Promise<void>;
}) {
  const controller = useController();
  const menu = useRef<HTMLDivElement | null>(null);
  const actions: ReactNode[] = [];
  const primaryAction = card?.actions.find(
    (action) => action.name === "create_codex_task" || action.name === "open_codex_task",
  );
  const sourceAction = card?.actions.find((action) => action.name === "open_source");
  const noteAction = card?.actions.find((action) => action.name === "annotate");
  const task = card?.linkedTasks.find(
    (candidate) => candidate.taskId === state.taskId && candidate.hostId === state.taskHostId,
  );
  const add = (
    key: string,
    label: string,
    action: () => void,
    disabled = false,
    danger = false,
  ) => {
    actions.push(
      <button
        key={key}
        type="button"
        role="menuitem"
        disabled={disabled}
        data-danger={danger || undefined}
        onClick={(event) => {
          event.stopPropagation();
          onClose(false);
          action();
        }}
      >
        {label}
      </button>,
    );
  };
  const divide = () => {
    actions.push(<div key={`separator-${String(actions.length)}`} role="separator" />);
  };

  if (state.kind === "selection" && state.selection) {
    add("copy-selection", "Copy selected text", () => {
      void onCopy(state.selection ?? "", "Selected text copied.");
    });
    if (state.linkUrl) {
      add("copy-link", "Copy link", () => {
        void onCopy(state.linkUrl ?? "", "Link copied.");
      });
    }
  } else if (state.kind === "link" && state.linkUrl) {
    add(
      "open-link",
      "Open link",
      () => {
        void controller.openExternal(state.linkUrl ?? "");
      },
      !controller.externalLinks,
    );
    add("copy-link", "Copy link", () => {
      void onCopy(state.linkUrl ?? "", "Link copied.");
    });
  } else if (state.kind === "task" && card && task) {
    add(
      "open-task",
      "Open task",
      () => {
        void controller.request(
          card.itemId,
          card.fingerprint,
          "open_codex_task",
          task.taskId,
          task.hostId,
          state.invoker,
        );
      },
      controller.busy || controller.codexActionsBlocked,
    );
    add(
      "refresh-task",
      "Refresh task status",
      () => {
        void controller.request(
          card.itemId,
          card.fingerprint,
          "refresh_codex_status",
          task.taskId,
          task.hostId,
          state.invoker,
        );
      },
      controller.busy || controller.codexActionsBlocked,
    );
  } else if (state.kind === "item" && card) {
    if (!state.inspector) {
      add("details", "Open details", () => {
        void controller.openDetails(card.itemId, state.invoker);
      });
    }
    if (card.workflowStage === "completed" || card.archive) {
      add(
        "follow-up",
        "Create follow-up",
        () => {
          controller.startTodo(
            state.invoker,
            `Follow up: ${card.title}`,
            `Continue from historical work: ${card.outcome ?? card.summary}`,
            card.itemId,
          );
        },
        controller.busy || controller.blocked,
      );
    } else if (primaryAction) {
      add(
        "codex",
        primaryAction.label,
        () => {
          void controller.request(
            card.itemId,
            card.fingerprint,
            primaryAction.name as Exclude<ActionName, "annotate">,
            primaryAction.taskId,
            primaryAction.taskHostId,
            state.invoker,
          );
        },
        controller.busy || controller.codexActionsBlocked,
      );
    }
    add("copy-work", "Copy work prompt", () => {
      void controller.copyContext(card);
    });
    if (sourceAction) {
      add(
        "source",
        "Open source",
        () => {
          if (card.sourceUrl) void controller.openExternal(card.sourceUrl);
          else
            void controller.request(
              card.itemId,
              card.fingerprint,
              sourceAction.name as Exclude<ActionName, "annotate">,
              undefined,
              undefined,
              state.invoker,
            );
        },
        card.sourceUrl
          ? !controller.externalLinks
          : controller.busy || controller.codexActionsBlocked,
      );
    }
    if (noteAction) {
      add(
        "note",
        "Add note",
        () => {
          controller.annotate(card.itemId, state.invoker);
        },
        controller.busy || controller.blocked,
      );
    }
    divide();
    if (card.archive) {
      add(
        "restore",
        "Restore…",
        () => {
          controller.restore(card.itemId, card.fingerprint, card.title, state.invoker);
        },
        controller.busy || controller.blocked,
      );
    } else {
      add(
        "archive",
        card.workflowStage === "completed" ? "Archive now" : "Archive…",
        () => {
          controller.archive(
            card.itemId,
            card.fingerprint,
            card.title,
            state.invoker,
            card.workflowStage === "completed" ? "completed" : undefined,
          );
        },
        controller.busy || controller.blocked,
        true,
      );
    }
  } else if (state.kind === "dashboard") {
    add(
      "new-todo",
      "New to-do",
      () => {
        controller.startTodo(state.invoker);
      },
      controller.busy || controller.blocked,
    );
    add(
      "refresh",
      "Refresh dashboard",
      () => {
        void controller.refreshLatest(state.invoker);
      },
      controller.busy || controller.refreshing || controller.readOnly,
    );
  }

  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    element.style.left = `${String(Math.max(8, Math.min(state.x, innerWidth - rect.width - 8)))}px`;
    element.style.top = `${String(Math.max(8, Math.min(state.y, innerHeight - rect.height - 8)))}px`;
    element
      .querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus({ preventScroll: true });
  }, [state]);

  useEffect(() => {
    const openedAt = performance.now();
    const dismiss = (event?: Event) => {
      if (event?.target instanceof Node && menu.current?.contains(event.target)) return;
      onClose(false);
    };
    const dismissAfterSettling = (event: Event) => {
      if (performance.now() - openedAt < 120) return;
      dismiss(event);
    };
    document.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismissAfterSettling, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismissAfterSettling, true);
    };
  }, [onClose]);

  if (actions.length === 0) return null;
  const label =
    state.kind === "selection"
      ? "Selected text actions"
      : state.kind === "link"
        ? "Link actions"
        : state.kind === "task"
          ? `Actions for ${task?.title ?? "Codex task"}`
          : state.kind === "item"
            ? `Actions for ${card?.title ?? "item"}`
            : "Dashboard actions";
  return createPortal(
    <div className="dyna-context-layer" role="region" aria-label="Context actions">
      <div
        ref={menu}
        className="dyna-context-menu"
        role="menu"
        aria-label={label}
        onContextMenu={(event) => {
          event.preventDefault();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            onClose(true);
            return;
          }
          if (event.key === "Tab") {
            onClose(false);
            return;
          }
          const items = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
          ];
          const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
          const nextIndex =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : event.key === "ArrowDown"
                  ? (currentIndex + 1) % items.length
                  : event.key === "ArrowUp"
                    ? (currentIndex - 1 + items.length) % items.length
                    : -1;
          if (nextIndex >= 0) {
            event.preventDefault();
            items[nextIndex]?.focus({ preventScroll: true });
          }
        }}
      >
        {actions}
      </div>
    </div>,
    document.body,
  );
}

function CodexWork({
  card,
  children,
}: {
  readonly card: CardViewProps;
  readonly children: ReactNode;
}) {
  const controller = useController();
  const [linking, setLinking] = useState(false);
  const [candidates, setCandidates] = useState<readonly DynaCodexSessionCandidate[]>([]);
  const [sessionListRequestId, setSessionListRequestId] = useState<string>();
  const [selectedKey, setSelectedKey] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [associating, setAssociating] = useState(false);
  const [error, setError] = useState<string>();
  const requestInFlight = useRef(false);
  const linkedKeys = useMemo(
    () => new Set(card.linkedTasks.map((task) => codexSessionKey(task))),
    [card.linkedTasks],
  );
  const available = useMemo(
    () => candidates.filter((candidate) => !linkedKeys.has(codexSessionKey(candidate))),
    [candidates, linkedKeys],
  );
  const matches = useMemo(() => {
    const terms = query.toLocaleLowerCase(controller.locale).trim().split(/\s+/u).filter(Boolean);
    if (terms.length === 0) return available;
    return available.filter((candidate) => {
      const text = [candidate.title, candidate.projectId ?? "", candidate.hostId, candidate.taskId]
        .join(" ")
        .toLocaleLowerCase(controller.locale);
      return terms.every((term) => text.includes(term));
    });
  }, [available, controller.locale, query]);
  const selected = matches.find((candidate) => codexSessionKey(candidate) === selectedKey);
  const atLimit = card.linkedTasks.length >= 8;
  const unavailable = controller.codexActionsBlocked || controller.busy;
  const canLink = !card.archive && card.workflowStage !== "completed";
  const showSearch = available.length > 8;

  useEffect(() => {
    if (selectedKey && !available.some((candidate) => codexSessionKey(candidate) === selectedKey)) {
      setSelectedKey("");
    }
  }, [available, selectedKey]);

  const load = async (trigger: HTMLElement) => {
    if (requestInFlight.current || loading || associating || atLimit || unavailable) return;
    requestInFlight.current = true;
    setLoading(true);
    setError(undefined);
    try {
      const result = await controller.loadCodexSessions(card.itemId, card.fingerprint, trigger);
      setCandidates(result.candidates);
      setSessionListRequestId(result.requestId);
      setSelectedKey((current) =>
        result.candidates.some((candidate) => codexSessionKey(candidate) === current)
          ? current
          : "",
      );
    } catch {
      setError(
        candidates.length > 0
          ? "Couldn’t refresh Codex sessions. Your current selection is unchanged."
          : "Couldn’t load Codex sessions. Try again.",
      );
    } finally {
      requestInFlight.current = false;
      setLoading(false);
    }
  };

  const associate = async (trigger: HTMLElement) => {
    if (
      requestInFlight.current ||
      !selected ||
      !sessionListRequestId ||
      loading ||
      associating ||
      atLimit ||
      unavailable
    ) {
      return;
    }
    requestInFlight.current = true;
    setAssociating(true);
    setError(undefined);
    const taskAction = `${card.itemId}:open_codex_task:${selected.taskId}`;
    try {
      await controller.associateCodexSession(
        card.itemId,
        card.fingerprint,
        selected,
        sessionListRequestId,
        trigger,
      );
      setCandidates([]);
      setSessionListRequestId(undefined);
      setSelectedKey("");
      setQuery("");
      setLinking(false);
      window.requestAnimationFrame(() => {
        window.setTimeout(() => {
          [...document.querySelectorAll<HTMLElement>("[data-dyna-action]")]
            .find((element) => element.dataset["dynaAction"] === taskAction)
            ?.focus();
        }, 0);
      });
    } catch {
      setError("Couldn’t associate this session. Refresh sessions and try again.");
    } finally {
      requestInFlight.current = false;
      setAssociating(false);
    }
  };

  const status = atLimit
    ? "This item already has the maximum of 8 associated sessions."
    : unavailable
      ? "Session association is unavailable on this host."
      : !sessionListRequestId
        ? "Load recent sessions to link one."
        : available.length === 0
          ? candidates.length === 0
            ? "No recent Codex sessions are available."
            : "All loaded sessions are already associated."
          : query.trim()
            ? `${String(matches.length)} matching session${matches.length === 1 ? "" : "s"}.`
            : `${String(available.length)} recent session${available.length === 1 ? "" : "s"}.`;

  return (
    <section className="dyna-inspector-section dyna-codex-work">
      <div className="dyna-codex-work-heading">
        <h3>Codex Work</h3>
        {canLink && !atLimit ? (
          <Button
            color="secondary"
            size="xs"
            variant="ghost"
            aria-expanded={linking}
            aria-controls={`dyna-session-picker-${card.itemId}`}
            disabled={unavailable}
            onClick={() => {
              setLinking((current) => !current);
              setError(undefined);
            }}
          >
            {linking ? "Close" : "Link existing session"}
          </Button>
        ) : null}
      </div>
      {card.linkedTasks.length > 0 ? (
        <div className="dyna-task-list">{children}</div>
      ) : (
        <p className="dyna-codex-work-empty">
          {canLink ? "No session linked." : "No Codex session was linked."}
        </p>
      )}
      {canLink && linking ? (
        <div
          id={`dyna-session-picker-${card.itemId}`}
          className="dyna-session-picker"
          aria-busy={loading || associating}
        >
          <div className="dyna-session-picker-heading">
            <p
              className="dyna-session-picker-status"
              data-error={Boolean(error)}
              role="status"
              aria-live="polite"
            >
              {loading
                ? "Loading recent Codex sessions…"
                : associating
                  ? "Linking session…"
                  : (error ?? status)}
            </p>
            <Button
              color="secondary"
              size="xs"
              variant="ghost"
              loading={loading}
              aria-label={sessionListRequestId ? "Refresh session list" : "Load sessions"}
              disabled={loading || associating || atLimit || unavailable}
              data-dyna-action={`${card.itemId}:list_codex_sessions`}
              onClick={(event) => {
                void load(event.currentTarget);
              }}
            >
              {sessionListRequestId ? "Refresh" : "Load sessions"}
            </Button>
          </div>
          {sessionListRequestId && available.length > 0 && showSearch ? (
            <Input
              className="dyna-session-search"
              aria-label="Find Codex sessions"
              type="search"
              size="sm"
              value={query}
              maxLength={200}
              placeholder="Find a session…"
              disabled={loading || associating}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
              }}
            />
          ) : null}
          {sessionListRequestId && available.length > 0 ? (
            <select
              className="dyna-native-select dyna-session-select"
              aria-label="Codex session"
              value={selected ? selectedKey : ""}
              disabled={loading || associating}
              onChange={(event) => {
                setSelectedKey(event.currentTarget.value);
                setError(undefined);
              }}
            >
              <option value="">Choose a recent session…</option>
              {matches.map((candidate) => (
                <option key={codexSessionKey(candidate)} value={codexSessionKey(candidate)}>
                  {candidate.title}
                  {` · ${candidate.hostId}`}
                  {candidate.projectId ? ` · ${candidate.projectId}` : ""}
                  {` · ${relativeTime(candidate.updatedAt, controller.locale)}`}
                </option>
              ))}
            </select>
          ) : null}
          {sessionListRequestId && available.length > 0 ? (
            <div className="dyna-session-picker-actions">
              <span aria-hidden="true" />
              <Button
                color="primary"
                size="xs"
                loading={associating}
                disabled={!selected || loading || associating || atLimit || unavailable}
                data-dyna-action={`${card.itemId}:attach_codex_task`}
                onClick={(event) => {
                  void associate(event.currentTarget);
                }}
              >
                Link
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {atLimit ? <p className="dyna-session-picker-status">Maximum of 8 sessions linked.</p> : null}
    </section>
  );
}

function mergeWorkUpdates(
  current: readonly DynaWorkUpdate[],
  incoming: readonly DynaWorkUpdate[],
): DynaWorkUpdate[] {
  const byId = new Map(current.map((update) => [update.id, update]));
  for (const update of incoming) byId.set(update.id, update);
  return [...byId.values()].sort((left, right) => {
    const byTime = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    return byTime !== 0 ? byTime : right.id.localeCompare(left.id);
  });
}

function WorkActivity({
  itemId,
  initialUpdates,
  workUpdateCount,
}: {
  readonly itemId: string;
  readonly initialUpdates: readonly DynaWorkUpdate[];
  readonly workUpdateCount: number;
}) {
  const controller = useController();
  const loadActivity = controller.loadActivity;
  const [updates, setUpdates] = useState(() => [...initialUpdates]);
  const [total, setTotal] = useState(Math.max(workUpdateCount, initialUpdates.length));
  const [nextCursor, setNextCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const updatesRef = useRef<readonly DynaWorkUpdate[]>(initialUpdates);
  const requestGeneration = useRef(0);
  const initialUpdateIds = initialUpdates.map((update) => update.id).join(":");
  const snapshotRef = useRef({
    itemId,
    updateIds: initialUpdateIds,
    total: workUpdateCount,
  });
  const snapshotInitialized = useRef(false);

  const applyUpdates = useCallback((next: readonly DynaWorkUpdate[]) => {
    updatesRef.current = next;
    setUpdates([...next]);
  }, []);

  useEffect(() => {
    const previous = snapshotRef.current;
    const itemChanged = !snapshotInitialized.current || previous.itemId !== itemId;
    snapshotInitialized.current = true;
    snapshotRef.current = { itemId, updateIds: initialUpdateIds, total: workUpdateCount };
    const generation = ++requestGeneration.current;

    if (itemChanged) {
      applyUpdates(initialUpdates);
      setNextCursor(undefined);
    } else {
      applyUpdates(mergeWorkUpdates(updatesRef.current, initialUpdates));
    }
    setTotal(Math.max(workUpdateCount, initialUpdates.length));
    setLoadError(false);
    if (workUpdateCount <= initialUpdates.length) {
      setLoading(false);
      return;
    }

    setLoading(true);
    void loadActivity(itemId)
      .then((page) => {
        if (requestGeneration.current !== generation || snapshotRef.current.itemId !== itemId) {
          return;
        }
        const merged = mergeWorkUpdates(updatesRef.current, page.updates);
        applyUpdates(merged);
        setTotal(Math.max(page.total, merged.length));
        setNextCursor(merged.length < page.total ? page.nextCursor : undefined);
      })
      .catch(() => {
        if (requestGeneration.current === generation && snapshotRef.current.itemId === itemId) {
          setLoadError(true);
        }
      })
      .finally(() => {
        if (requestGeneration.current === generation && snapshotRef.current.itemId === itemId) {
          setLoading(false);
        }
      });
    return () => {
      if (requestGeneration.current === generation) requestGeneration.current += 1;
    };
  }, [applyUpdates, initialUpdateIds, itemId, loadActivity, workUpdateCount]);

  const loadMore = async () => {
    if (loading || (!nextCursor && !loadError)) return;
    const generation = requestGeneration.current;
    const requestedItemId = itemId;
    setLoading(true);
    setLoadError(false);
    try {
      const page = await loadActivity(itemId, nextCursor);
      if (
        requestGeneration.current !== generation ||
        snapshotRef.current.itemId !== requestedItemId
      ) {
        return;
      }
      const merged = mergeWorkUpdates(updatesRef.current, page.updates);
      applyUpdates(merged);
      setTotal(Math.max(page.total, merged.length));
      setNextCursor(merged.length < page.total ? page.nextCursor : undefined);
    } catch {
      if (
        requestGeneration.current === generation &&
        snapshotRef.current.itemId === requestedItemId
      ) {
        setLoadError(true);
      }
    } finally {
      if (
        requestGeneration.current === generation &&
        snapshotRef.current.itemId === requestedItemId
      ) {
        setLoading(false);
      }
    }
  };

  const remaining = Math.max(0, total - updates.length);
  return (
    <section
      className="dyna-inspector-section dyna-work-activity"
      aria-busy={loading}
      data-work-update-count={total}
    >
      <h3>Work Activity</h3>
      <ol className="dyna-note-list dyna-work-list" aria-label="Work Activity">
        {updates.map((update) => {
          const taskLabel = workUpdateTaskLabel(update);
          return (
            <li key={update.id} data-work-update-kind={update.kind}>
              <div className="dyna-work-meta">
                <span className="dyna-work-kind">{workUpdateKindLabel(update.kind)}</span>
                {taskLabel ? (
                  <span
                    className="dyna-work-task"
                    title={`Identity matched to linked Codex task ${update.task?.taskId ?? ""} on ${update.task?.hostId ?? ""}`}
                    aria-label={`Update from linked Codex task ${taskLabel}; task identity ${update.task?.taskId ?? ""} on host ${update.task?.hostId ?? ""} was verified, but the update content was not independently verified`}
                  >
                    From linked task · {taskLabel}
                  </span>
                ) : null}
                <time dateTime={update.createdAt} title={update.createdAt}>
                  {exactDateTime(update.createdAt, controller.locale)}
                </time>
              </div>
              <p>{update.body}</p>
              {update.outcome ? (
                <div className="dyna-outcome dyna-work-outcome">
                  <span>Reported outcome</span>
                  <p>{update.outcome}</p>
                </div>
              ) : null}
              {update.artifacts.length > 0 ? (
                <ul className="dyna-work-artifacts" aria-label="Result links">
                  {update.artifacts.map((artifact, index) => (
                    <li key={`${artifact.kind}:${artifact.url}:${String(index)}`}>
                      <a
                        className="dyna-origin-link dyna-artifact-link"
                        data-dyna-artifact-link={update.id}
                        href={artifact.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open artifact: ${artifact.label}`}
                        onClick={(event) => {
                          handleExternalAnchorClick(event, artifact.url, controller);
                        }}
                      >
                        <ExternalLink className="dyna-source-link-icon" aria-hidden="true" />
                        <span>{artifact.label}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ol>
      {loadError ? (
        <p className="dyna-activity-status" role="alert">
          Older activity could not be loaded. Try again.
        </p>
      ) : null}
      {nextCursor || (loadError && total > updates.length) ? (
        <Button
          className="dyna-activity-more"
          color="secondary"
          size="xs"
          variant="ghost"
          loading={loading}
          disabled={loading}
          onClick={() => {
            void loadMore();
          }}
        >
          {nextCursor
            ? `Load older activity${remaining > 0 ? ` (${String(remaining)})` : ""}`
            : "Retry activity"}
        </Button>
      ) : loading ? (
        <span className="dyna-activity-status" role="status">
          Loading activity…
        </span>
      ) : null}
    </section>
  );
}

const dynaComponents: DynaComponentCatalog = {
  Dashboard: ({ props, children }) => {
    const controller = useController();
    const activeFilterCount =
      Number(controller.priorityFilter !== "all") +
      Number(controller.sourceFilter !== "all") +
      Number(controller.workflowFilter !== "all") +
      Number(controller.leadershipOnly);
    const health = controller.readOnly
      ? { color: "warning" as const, label: "Read only" }
      : controller.blocked
        ? { color: "danger" as const, label: "Offline" }
        : !props.sourceAttention && props.freshness === "fresh"
          ? { color: "success" as const, label: "Live" }
          : { color: "warning" as const, label: "Delayed" };
    return (
      <main
        className="dyna"
        data-display-mode={controller.displayMode}
        data-dashboard-view={controller.view}
        data-has-selection={Boolean(controller.selectedItemId)}
        data-bulk-mode={controller.bulkMode}
        data-condensed={controller.condenseInline}
      >
        <header className="dyna-header">
          <div className="dyna-title-row">
            <div className="dyna-heading">
              <h1>{props.name}</h1>
              <div className="dyna-header-meta">
                Updated {relativeTime(props.generatedAt, controller.locale)} · revision{" "}
                {props.revision}
              </div>
            </div>
            <div className="dyna-header-actions">
              <Badge className="dyna-health-badge" color={health.color} pill>
                {health.label}
              </Badge>
            </div>
          </div>
          {props.description ? <p className="dyna-description">{props.description}</p> : null}
          {controller.condenseInline ? (
            <div className="dyna-inline-controls">
              <RefreshButton />
              <Button
                color="secondary"
                variant="ghost"
                size="sm"
                onClick={(event) => {
                  controller.startTodo(event.currentTarget);
                }}
                disabled={controller.busy || controller.blocked}
              >
                <Plus className="dyna-icon" aria-hidden="true" />
                New to-do
              </Button>
              {!controller.initialExpansionPending ? (
                <Button
                  color="secondary"
                  variant="outline"
                  size="sm"
                  data-dyna-expand="true"
                  loading={controller.busy}
                  disabled={controller.busy}
                  aria-label="Open full dashboard"
                  title="Open full dashboard"
                  onClick={(event) => {
                    void controller.expand(event.currentTarget);
                  }}
                >
                  <ExternalLink className="dyna-icon" aria-hidden="true" />
                  <span className="dyna-expand-label">Open full dashboard</span>
                </Button>
              ) : null}
            </div>
          ) : null}
        </header>
        {!controller.condenseInline ? (
          <div className="dyna-commandbar">
            <div className="dyna-tabs" role="tablist" aria-label="Dashboard view">
              <button
                id="dyna-tab-queue"
                type="button"
                role="tab"
                aria-label="Priority queue"
                aria-selected={controller.view === "queue"}
                aria-controls="dyna-panel-queue"
                tabIndex={controller.view === "queue" ? 0 : -1}
                onClick={() => {
                  controller.setView("queue");
                }}
                onKeyDown={(event) => {
                  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const next =
                    event.key === "End"
                      ? "archive"
                      : event.key === "Home"
                        ? "queue"
                        : event.key === "ArrowLeft"
                          ? "archive"
                          : "pipeline";
                  controller.setView(next);
                  document.getElementById(`dyna-tab-${next}`)?.focus();
                }}
              >
                Queue
              </button>
              <button
                id="dyna-tab-pipeline"
                type="button"
                role="tab"
                aria-label="Progress pipeline"
                aria-selected={controller.view === "pipeline"}
                aria-controls="dyna-panel-pipeline"
                tabIndex={controller.view === "pipeline" ? 0 : -1}
                onClick={() => {
                  controller.setView("pipeline");
                }}
                onKeyDown={(event) => {
                  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const next =
                    event.key === "Home" || event.key === "ArrowLeft" ? "queue" : "archive";
                  controller.setView(next);
                  document.getElementById(`dyna-tab-${next}`)?.focus();
                }}
              >
                Progress
              </button>
              <button
                id="dyna-tab-archive"
                type="button"
                role="tab"
                aria-label="Archive"
                aria-selected={controller.view === "archive"}
                aria-controls="dyna-panel-archive"
                tabIndex={controller.view === "archive" ? 0 : -1}
                onClick={() => {
                  controller.setView("archive");
                }}
                onKeyDown={(event) => {
                  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? "queue"
                      : event.key === "ArrowLeft"
                        ? "pipeline"
                        : "archive";
                  controller.setView(next);
                  document.getElementById(`dyna-tab-${next}`)?.focus();
                }}
              >
                Archive
              </button>
            </div>
            <div className="dyna-search">
              <Search className="dyna-search-icon" aria-hidden="true" />
              <Input
                className="dyna-search-control"
                aria-label="Search dashboard"
                type="search"
                size="md"
                value={controller.query}
                maxLength={500}
                placeholder="Find people, requests, MRs…"
                onChange={(event) => {
                  controller.setQuery(event.currentTarget.value);
                }}
              />
              {controller.query ? (
                <Button
                  className="dyna-search-clear"
                  color="secondary"
                  size="xs"
                  variant="ghost"
                  aria-label="Clear search"
                  onClick={() => {
                    controller.setQuery("");
                  }}
                >
                  <X className="dyna-icon" aria-hidden="true" />
                </Button>
              ) : null}
            </div>
            <details className="dyna-filters">
              <summary aria-label="Filters">
                <span>Filters</span>
                {activeFilterCount > 0 ? (
                  <span className="dyna-filter-count" aria-hidden="true">
                    {activeFilterCount}
                  </span>
                ) : null}
                <ChevronRight className="dyna-disclosure" aria-hidden="true" />
              </summary>
              <div className="dyna-filter-panel" aria-label="Dashboard filters">
                <label className="dyna-filter-field">
                  <span>Priority</span>
                  <select
                    aria-label="Priority"
                    value={controller.priorityFilter}
                    onChange={(event) => {
                      controller.setPriorityFilter(event.currentTarget.value as PriorityFilter);
                    }}
                  >
                    <option value="all">All priorities</option>
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="normal">Normal</option>
                    <option value="low">Low</option>
                  </select>
                </label>
                <label className="dyna-filter-field">
                  <span>Source</span>
                  <select
                    aria-label="Source"
                    value={controller.sourceFilter}
                    onChange={(event) => {
                      controller.setSourceFilter(event.currentTarget.value);
                    }}
                  >
                    <option value="all">All sources</option>
                    {props.sourceOptions.map((source) => (
                      <option value={source} key={source}>
                        {source}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="dyna-filter-field">
                  <span>Status</span>
                  <select
                    aria-label="Status"
                    value={controller.workflowFilter}
                    onChange={(event) => {
                      controller.setWorkflowFilter(event.currentTarget.value as WorkflowFilter);
                    }}
                  >
                    <option value="all">All statuses</option>
                    <option value="todo">To Do</option>
                    <option value="executing">In Codex</option>
                    <option value="needs_you">Needs You</option>
                    <option value="blocked">Blocked</option>
                    <option value="completed">Done</option>
                  </select>
                </label>
                <div className="dyna-filter-actions">
                  <button
                    type="button"
                    className="dyna-leadership-filter"
                    aria-pressed={controller.leadershipOnly}
                    onClick={() => {
                      controller.setLeadershipOnly(!controller.leadershipOnly);
                    }}
                  >
                    Leadership only
                  </button>
                  <button
                    type="button"
                    className="dyna-clear-filters"
                    disabled={activeFilterCount === 0}
                    onClick={(event) => {
                      controller.clearFilters();
                      event.currentTarget.closest("details")?.removeAttribute("open");
                    }}
                  >
                    Clear filters
                  </button>
                </div>
              </div>
            </details>
            <div className="dyna-command-actions">
              {controller.view === "queue" ? (
                <Button
                  color="secondary"
                  size="sm"
                  variant={controller.bulkMode ? "soft" : "ghost"}
                  data-dyna-bulk-toggle="true"
                  aria-label={controller.bulkMode ? "Cancel item selection" : "Select items"}
                  aria-pressed={controller.bulkMode}
                  title={controller.bulkMode ? "Cancel selection" : "Select items"}
                  disabled={controller.busy || controller.blocked}
                  onClick={() => {
                    controller.setBulkMode(!controller.bulkMode);
                  }}
                >
                  <CheckSquare className="dyna-icon" aria-hidden="true" />
                  <span className="dyna-select-label">
                    {controller.bulkMode ? "Cancel" : "Select"}
                  </span>
                </Button>
              ) : null}
              <RefreshButton />
              <Button
                color="primary"
                size="sm"
                onClick={(event) => {
                  controller.startTodo(event.currentTarget);
                }}
                disabled={controller.busy || controller.blocked}
                aria-label="Add to-do"
                title="New to-do"
              >
                <Plus className="dyna-icon" aria-hidden="true" />
                <span className="dyna-add-label">New to-do</span>
              </Button>
            </div>
          </div>
        ) : null}
        <div className="dyna-workspace">{children}</div>
      </main>
    );
  },
  SummaryStrip: ({ props }) => {
    const controller = useController();
    const settled = controller.readOnly || controller.query.trim() === controller.serverQuery;
    const filters = [
      ["needs_you", props.needsYou, "need you"],
      ["executing", props.inCodex, "in Codex"],
      ["blocked", props.blocked, "blocked"],
      [
        "all",
        props.shown < props.total ? `${props.shown}/${props.total}` : props.total,
        props.shown < props.total ? "shown" : "total",
      ],
    ] as const;
    return (
      <>
        <section
          className="dyna-summary"
          data-condensed={controller.condenseInline}
          aria-label="Status filters"
        >
          {filters.map(([filter, count, label]) => (
            <button
              type="button"
              className="dyna-stat"
              data-filter={filter}
              aria-pressed={controller.workflowFilter === filter}
              key={filter}
              onClick={() => {
                controller.setWorkflowFilter(filter);
              }}
            >
              <strong>{count}</strong>
              <span>{label}</span>
            </button>
          ))}
        </section>
        <div className="dyna-visually-hidden" role="status" aria-live="polite">
          {settled && controller.query.trim()
            ? props.shown === 0
              ? "No matching items."
              : `${String(props.shown)} matching ${props.shown === 1 ? "item" : "items"}.`
            : ""}
        </div>
      </>
    );
  },
  ExecutiveSummary: ({ props }) => {
    const controller = useController();
    const points = props.condensed ? props.model.points.slice(0, 2) : props.model.points;
    const coverageLabel = {
      current: "Current",
      partial: "Partial",
      delayed: "Delayed",
      pending: "Pending",
      manual: "Manual",
    }[props.model.coverage];
    const focusResults = (view = controller.view) => {
      window.setTimeout(() => {
        document.getElementById(`dyna-panel-${view}`)?.focus();
      }, 0);
    };
    const activate = (action: ExecutiveSummaryAction, trigger: HTMLElement) => {
      if (action.kind === "item") {
        void controller.openDetails(action.itemId, trigger);
        return;
      }
      if (action.kind === "query") controller.setQuery(action.query);
      else {
        if (action.workflow === "completed") controller.setView("pipeline");
        controller.setWorkflowFilter(action.workflow);
      }
      focusResults(
        action.kind === "workflow" && action.workflow === "completed" ? "pipeline" : undefined,
      );
    };
    return (
      <section
        className="dyna-executive-summary"
        data-condensed={props.condensed}
        data-coverage={props.model.coverage}
        aria-labelledby="dyna-executive-summary-title"
      >
        <header className="dyna-executive-summary-header">
          <h2 id="dyna-executive-summary-title">Executive Brief</h2>
          <div className="dyna-executive-summary-meta">
            <span>{props.model.scope}</span>
            <span>{coverageLabel}</span>
            <time
              dateTime={props.model.generatedAt}
              title={`${exactDateTime(props.model.generatedAt, controller.locale)} · revision ${String(props.model.revision)}`}
            >
              Updated {relativeTime(props.model.generatedAt, controller.locale)}
            </time>
          </div>
        </header>
        <ul className="dyna-executive-summary-points">
          {points.map((point, index) => {
            const action = point.action;
            const actionLabel =
              action?.kind === "item"
                ? `Open details for ${point.headline}`
                : action?.kind === "query"
                  ? `Search dashboard for the ${point.headline} theme`
                  : action?.kind === "workflow"
                    ? `Filter dashboard by ${point.headline}`
                    : undefined;
            return (
              <li key={`${point.kind}:${point.headline}:${String(index)}`} data-kind={point.kind}>
                <span className="dyna-executive-summary-label">{point.label}</span>
                <div className="dyna-executive-summary-copy">
                  {action && actionLabel ? (
                    <button
                      type="button"
                      className="dyna-executive-summary-action"
                      aria-label={actionLabel}
                      onClick={(event) => {
                        activate(action, event.currentTarget);
                      }}
                    >
                      {point.headline}
                    </button>
                  ) : (
                    <strong>{point.headline}</strong>
                  )}
                  {point.detail ? <span>{point.detail}</span> : null}
                </div>
                {point.sources.length > 0 ? (
                  <span
                    className="dyna-executive-summary-sources"
                    role="img"
                    aria-label={`Sources: ${point.sources.map((source) => source.label).join(", ")}`}
                  >
                    {point.sources.slice(0, 3).map((source) => (
                      <SourceFavicon key={source.key} kind={source.icon} />
                    ))}
                    {point.sources.length > 3 ? <span>+{point.sources.length - 3}</span> : null}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
        <p className="dyna-executive-summary-coverage">{props.model.coverageText}</p>
      </section>
    );
  },
  Section: ({ props, children }) => {
    const controller = useController();
    const [dropActive, setDropActive] = useState(false);
    const selectableIds = props.itemIds ?? [];
    const selectedInGroup = selectableIds.filter((itemId) =>
      controller.bulkSelectedIds.includes(itemId),
    ).length;
    const allInGroupSelected = selectableIds.length > 0 && selectedInGroup === selectableIds.length;
    const someInGroupSelected = selectedInGroup > 0 && !allInGroupSelected;
    if (props.title === "Signal Runs") {
      if (controller.condenseInline && !props.attention) return null;
      return (
        <details
          className="dyna-source-health"
          data-attention={Boolean(props.attention)}
          open={props.attention ? true : undefined}
        >
          <summary>
            <ChevronRight className="dyna-disclosure" aria-hidden="true" />
            {props.attention ? "Source Health Needs Attention" : "Source Health"}
            <span className="dyna-meta">
              {props.count} {props.count === 1 ? "run" : "runs"}
            </span>
          </summary>
          <div className="dyna-source-list">{children}</div>
        </details>
      );
    }
    const acceptsQueueDrop =
      Boolean(props.priority) &&
      controller.view === "queue" &&
      !controller.condenseInline &&
      !controller.busy &&
      !controller.blocked;
    return (
      <section
        className="dyna-section"
        data-priority-group={props.priority}
        data-drop-active={dropActive}
        data-empty={props.count === 0}
        onDragOver={(event) => {
          if (!acceptsQueueDrop || !event.dataTransfer.types.includes(DYNA_DRAG_TYPE)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDropActive(true);
        }}
        onDragLeave={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget)
          ) {
            return;
          }
          setDropActive(false);
        }}
        onDrop={(event) => {
          setDropActive(false);
          delete document.documentElement.dataset["dynaDragging"];
          if (!acceptsQueueDrop || !props.priority) return;
          const dragged = readDragItem(event.dataTransfer);
          if (!dragged) return;
          event.preventDefault();
          void controller.place(
            dragged.itemId,
            dragged.fingerprint,
            props.priority,
            undefined,
            event.currentTarget,
          );
        }}
      >
        <header className="dyna-section-header">
          {controller.bulkMode && props.priority && selectableIds.length > 0 ? (
            <label className="dyna-group-check-control">
              <input
                ref={(element) => {
                  if (element) element.indeterminate = someInGroupSelected;
                }}
                className="dyna-group-check"
                type="checkbox"
                aria-label={`Select all in ${props.title}`}
                checked={allInGroupSelected}
                disabled={controller.busy || controller.blocked}
                onChange={(event) => {
                  controller.setBulkItemsSelected(selectableIds, event.currentTarget.checked);
                }}
              />
              <span className="dyna-checkmark" aria-hidden="true" />
            </label>
          ) : null}
          <h2>{props.title}</h2>
          <span className="dyna-section-count">{props.count}</span>
        </header>
        {props.count > 0 ? children : <p className="dyna-priority-empty">{props.emptyMessage}</p>}
      </section>
    );
  },
  QueueView: ({ children }) => {
    const controller = useController();
    return controller.condenseInline || controller.view === "queue" ? (
      <div
        id="dyna-panel-queue"
        className="dyna-view"
        role={controller.condenseInline ? "region" : "tabpanel"}
        aria-label={controller.condenseInline ? "Top Attention" : undefined}
        aria-labelledby={controller.condenseInline ? undefined : "dyna-tab-queue"}
        tabIndex={-1}
      >
        {children}
      </div>
    ) : null;
  },
  PipelineView: ({ props, children }) => {
    const controller = useController();
    return controller.view === "pipeline" ? (
      <div
        id="dyna-panel-pipeline"
        className="dyna-pipeline dyna-view"
        role="tabpanel"
        aria-labelledby="dyna-tab-pipeline"
        tabIndex={-1}
      >
        <div className="dyna-stage-summary" aria-label="Progress summary">
          {props.stages.map((stage) => (
            <span key={stage.state} data-workflow-stage={stage.state}>
              <strong>{stage.count}</strong> {stage.title}
            </span>
          ))}
        </div>
        <div className="dyna-pipeline-grid" aria-label="All progress stages">
          {children}
        </div>
      </div>
    ) : null;
  },
  PipelineStage: ({ props, children }) => {
    const controller = useController();
    const [dropActive, setDropActive] = useState(false);
    const acceptsDrop = !controller.busy && !controller.blocked;
    return (
      <section
        className="dyna-pipeline-stage"
        data-workflow-stage={props.state}
        data-drop-active={dropActive}
        aria-labelledby={`dyna-stage-title-${props.state}`}
        onDragOver={(event) => {
          if (!acceptsDrop || !event.dataTransfer.types.includes(DYNA_DRAG_TYPE)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDropActive(true);
        }}
        onDragLeave={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget)
          ) {
            return;
          }
          setDropActive(false);
        }}
        onDrop={(event) => {
          setDropActive(false);
          delete document.documentElement.dataset["dynaDragging"];
          if (!acceptsDrop) return;
          const dragged = readDragItem(event.dataTransfer);
          if (!dragged) return;
          event.preventDefault();
          if (dragged.workflowStage === props.state) return;
          void controller.moveToStage(
            dragged.itemId,
            dragged.fingerprint,
            props.state,
            event.currentTarget,
          );
        }}
      >
        <header>
          <h2 id={`dyna-stage-title-${props.state}`}>{props.title}</h2>
          <span>{props.count}</span>
        </header>
        <div className="dyna-pipeline-items">
          {props.count > 0 ? children : <p className="dyna-pipeline-empty">Nothing here.</p>}
        </div>
      </section>
    );
  },
  ArchiveView: ({ props, children }) => {
    const controller = useController();
    return controller.view === "archive" ? (
      <div
        id="dyna-panel-archive"
        className="dyna-view dyna-archive-view"
        role="tabpanel"
        aria-labelledby="dyna-tab-archive"
      >
        <div className="dyna-archive-heading">
          <div>
            <h2>Archive</h2>
            <p>Completed history and explicit dispositions. Nothing here counts as active work.</p>
          </div>
          <span>
            {props.count} archived {props.count === 1 ? "item" : "items"}
          </span>
        </div>
        {children}
      </div>
    ) : null;
  },
  PriorityCard: ({ props, children }) => {
    const controller = useController();
    const rowMoveTrigger = useRef<HTMLElement | null>(null);
    const [dropActive, setDropActive] = useState(false);
    const presentation = controller.view;
    const selected = controller.selectedItemId === props.itemId;
    const inspectorTitleId = `dyna-inspector-title-${props.itemId}`;
    const inspectorId = `dyna-inspector-${props.itemId}`;
    const lead = props.people[0];
    const detailLabel = `Open details for ${props.title}`;
    const sourceMark = sourceIcon(props.sourceRef);
    const sourceMarkLabel =
      props.sourceRef.source === "twg" && sourceMark !== "twg"
        ? `${humanize(sourceMark)} via TWG`
        : props.sourceLabel;
    const summaryNeedsDisclosure = props.summary.length > INLINE_SUMMARY_MAX_LENGTH;
    const matchedActivity = controller.query.trim() ? props.matchedActivity?.trim() : undefined;
    const rowDetail = matchedActivity
      ? `Matched activity: ${compactLine(matchedActivity)}`
      : compactLine(props.workflowSummary ?? props.attention ?? props.priorityReason);
    const showPriority = presentation !== "queue" || controller.condenseInline;
    const showQueueMove =
      controller.view === "queue" &&
      !controller.condenseInline &&
      !props.archive &&
      props.workflowStage !== "completed";
    const showPipelineMove =
      controller.view === "pipeline" && !props.archive && props.workflowStage !== "completed";
    const bulkSelected = controller.bulkSelectedIds.includes(props.itemId);
    const canOrganize =
      showQueueMove && !controller.bulkMode && !controller.busy && !controller.blocked;
    const canDrag =
      (showQueueMove || showPipelineMove) &&
      !controller.bulkMode &&
      !controller.busy &&
      !controller.blocked &&
      window.matchMedia("(pointer: fine)").matches;
    const startDrag = (event: ReactDragEvent<HTMLElement>) => {
      closeOrganizationMenus();
      document.documentElement.dataset["dynaDragging"] = "true";
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(
        DYNA_DRAG_TYPE,
        JSON.stringify({
          itemId: props.itemId,
          fingerprint: props.fingerprint,
          workflowStage: props.workflowStage,
        }),
      );
      event.dataTransfer.setData("text/plain", props.itemId);
      const card = event.currentTarget.closest<HTMLElement>(".dyna-card");
      if (card) {
        card.dataset["dragging"] = "true";
        event.dataTransfer.setDragImage(card, 18, 18);
      }
    };
    const endDrag = (event: ReactDragEvent<HTMLElement>) => {
      delete document.documentElement.dataset["dynaDragging"];
      const card = event.currentTarget.closest<HTMLElement>(".dyna-card");
      if (card) delete card.dataset["dragging"];
      setDropActive(false);
    };
    const priorityColor =
      props.priority === "critical"
        ? "danger"
        : props.priority === "high"
          ? "warning"
          : props.priority === "normal"
            ? "info"
            : "secondary";
    return (
      <article
        className="dyna-card"
        tabIndex={-1}
        data-priority={props.priority}
        data-item-id={props.itemId}
        data-presentation={presentation}
        data-workflow-state={props.workflowState}
        data-workflow-stage={props.workflowStage}
        data-selected={selected}
        data-bulk-selected={bulkSelected}
        data-has-move={showQueueMove || (showPipelineMove && canDrag)}
        data-drop-active={dropActive}
        onDragOver={(event) => {
          if (!showQueueMove || !canDrag || !event.dataTransfer.types.includes(DYNA_DRAG_TYPE))
            return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "move";
          setDropActive(true);
        }}
        onDragLeave={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget)
          ) {
            return;
          }
          setDropActive(false);
        }}
        onDrop={(event) => {
          setDropActive(false);
          delete document.documentElement.dataset["dynaDragging"];
          if (!showQueueMove || !canDrag) return;
          const dragged = readDragItem(event.dataTransfer);
          if (!dragged) return;
          event.preventDefault();
          event.stopPropagation();
          if (dragged.itemId === props.itemId) return;
          void controller.place(
            dragged.itemId,
            dragged.fingerprint,
            props.priority,
            props.itemId,
            event.currentTarget,
          );
        }}
      >
        <div
          className="dyna-card-row"
          onClick={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest(
                "a, button, input, select, summary, .dyna-item-check-control, .dyna-status-control, .dyna-overflow-menu",
              )
            ) {
              return;
            }
            if (window.getSelection()?.toString().trim()) return;
            const trigger = event.currentTarget.querySelector<HTMLElement>(
              "[data-dyna-details-item]",
            );
            if (trigger) void controller.openDetails(props.itemId, trigger);
          }}
        >
          <div className="dyna-row-main">
            <div className="dyna-row-heading">
              {showQueueMove && controller.bulkMode ? (
                <label
                  className="dyna-item-check-control"
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                >
                  <input
                    className="dyna-item-check"
                    type="checkbox"
                    aria-label={`Select ${props.title}`}
                    checked={bulkSelected}
                    disabled={controller.busy || controller.blocked}
                    onChange={(event) => {
                      controller.setBulkItemsSelected([props.itemId], event.currentTarget.checked);
                    }}
                  />
                  <span className="dyna-checkmark" aria-hidden="true" />
                </label>
              ) : showQueueMove ? (
                <details
                  className="dyna-overflow dyna-row-organize"
                  name="dyna-row-organization"
                  onToggle={(event) => {
                    if (event.currentTarget.open) {
                      closeOrganizationMenus({ except: event.currentTarget });
                    }
                  }}
                >
                  <summary
                    ref={rowMoveTrigger}
                    className="dyna-drag-handle"
                    draggable={canDrag}
                    data-dyna-drag-item={props.itemId}
                    aria-label={`Move ${props.title}`}
                    aria-disabled={!canOrganize}
                    title="Drag to reorder · activate for move options · arrow keys also move"
                    onClick={(event) => {
                      if (!canOrganize) event.preventDefault();
                    }}
                    onDragStart={startDrag}
                    onDragEnd={endDrag}
                    onKeyDown={(event) => {
                      const action = {
                        ArrowUp: "earlier",
                        ArrowDown: "later",
                        ArrowLeft: "bump",
                        ArrowRight: "lower",
                      }[event.key] as "bump" | "lower" | "earlier" | "later" | undefined;
                      if (!action || !canOrganize) return;
                      if (
                        (action === "bump" && props.priority === "critical") ||
                        (action === "lower" && props.priority === "low") ||
                        (action === "earlier" && !props.canMoveEarlier) ||
                        (action === "later" && !props.canMoveLater)
                      ) {
                        return;
                      }
                      event.preventDefault();
                      event.currentTarget.closest("details")?.removeAttribute("open");
                      void controller.organize(
                        props.itemId,
                        props.fingerprint,
                        action,
                        event.currentTarget,
                      );
                    }}
                  >
                    ⠿
                  </summary>
                  <OrganizationMenu card={props} trigger={rowMoveTrigger} label="Move item" />
                </details>
              ) : showPipelineMove && canDrag ? (
                <button
                  type="button"
                  className="dyna-drag-handle"
                  draggable={canDrag}
                  data-dyna-drag-item={props.itemId}
                  aria-label={`Drag ${props.title} to another status`}
                  title="Drag to another status · use the status menu with a keyboard or touch"
                  onDragStart={startDrag}
                  onDragEnd={endDrag}
                >
                  ⠿
                </button>
              ) : null}
              <SourceFavicon kind={sourceMark} label={sourceMarkLabel} />
              {props.sourceUrl ? (
                <a
                  className="dyna-row-title dyna-source-link"
                  data-dyna-source-link={props.itemId}
                  href={props.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open source: ${props.title}`}
                  onClick={(event) => {
                    handleExternalAnchorClick(event, props.sourceUrl ?? "", controller);
                  }}
                >
                  <span>{props.title}</span>
                  <ExternalLink className="dyna-source-link-icon" aria-hidden="true" />
                </a>
              ) : (
                <span className="dyna-row-title">{props.title}</span>
              )}
              {props.dueAt ? (
                <span className="dyna-row-time" data-has-deadline="true">
                  Due {relativeTime(props.dueAt, controller.locale)}
                </span>
              ) : null}
              <button
                type="button"
                className="dyna-row-primary"
                data-dyna-details-item={props.itemId}
                aria-label={detailLabel}
                aria-expanded={selected}
                aria-controls={selected ? inspectorId : undefined}
                onClick={(event) => {
                  void controller.openDetails(props.itemId, event.currentTarget);
                }}
              >
                <ChevronRight className="dyna-row-chevron" aria-hidden="true" />
              </button>
            </div>
            <div className="dyna-row-top">
              {showPriority ? <span className="dyna-priority-label">{props.priority}</span> : null}
              <StatusSelect card={props} />
              {props.workflowCondition ? (
                <span
                  className="dyna-row-condition"
                  title={props.workflowCondition}
                  data-condition={
                    props.workflowCondition === "Input needed"
                      ? "waiting"
                      : props.workflowCondition === "Completion reported—verification pending"
                        ? "verification"
                        : "blocked"
                  }
                >
                  {props.workflowCondition}
                </span>
              ) : null}
              {props.blocked && props.workflowCondition !== "Blocked" ? (
                <span className="dyna-row-condition" data-condition="blocked" title="Blocked">
                  Blocked
                </span>
              ) : null}
              {lead ? (
                <span
                  className="dyna-row-person"
                  title={lead.title ?? humanize(lead.leadershipLevel)}
                >
                  {lead.displayName}
                </span>
              ) : null}
            </div>
            <div className="dyna-row-foot">
              <span className="dyna-row-attention" title={rowDetail}>
                {rowDetail}
              </span>
            </div>
          </div>
        </div>
        {selected ? (
          <InspectorShell
            id={inspectorId}
            labelledBy={inspectorTitleId}
            onClose={() => {
              controller.closeDetails();
            }}
          >
            <div className="dyna-inspector-header">
              <div className="dyna-inspector-nav">
                <Button
                  className="dyna-inspector-back"
                  data-dyna-inspector-back="true"
                  color="secondary"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    controller.closeDetails();
                  }}
                >
                  <ArrowLeft className="dyna-icon" aria-hidden="true" />
                  Back to attention queue
                </Button>
                <Button
                  className="dyna-inspector-close"
                  data-dyna-inspector-close="true"
                  color="secondary"
                  size="xs"
                  variant="ghost"
                  aria-label="Close details"
                  title="Close details"
                  onClick={() => {
                    controller.closeDetails();
                  }}
                >
                  <X className="dyna-icon" aria-hidden="true" />
                </Button>
              </div>
              <div className="dyna-inspector-heading">
                <div className="dyna-inspector-eyebrow">
                  <Badge color={priorityColor} pill>
                    {props.priority}
                  </Badge>
                  <SourceFavicon kind={sourceMark} label={sourceMarkLabel} />
                  <StatusSelect card={props} />
                  {props.archive ? <span>{humanize(props.archive.reason)}</span> : null}
                  {props.workflowCondition ? <span>{props.workflowCondition}</span> : null}
                  {props.blocked && props.workflowCondition !== "Blocked" ? (
                    <span className="dyna-inspector-blocked">Blocked</span>
                  ) : null}
                  {props.dueAt ? (
                    <span>Due {relativeTime(props.dueAt, controller.locale)}</span>
                  ) : null}
                </div>
                <h2 id={inspectorTitleId}>{props.title}</h2>
              </div>
              <InspectorActions card={props} />
            </div>
            <div className="dyna-inspector-scroll" data-priority={props.priority}>
              {props.archive ? (
                <div
                  className="dyna-archive-notice"
                  data-changed={props.archive.changedSinceArchive}
                >
                  <span>
                    {humanize(props.archive.reason)} · archived{" "}
                    {relativeTime(props.archive.archivedAt, controller.locale)}
                  </span>
                  {props.archive.reasonDetail ? <p>{props.archive.reasonDetail}</p> : null}
                  {props.archive.changedSinceArchive ? (
                    <strong>Changed since archive — restore explicitly to reconsider.</strong>
                  ) : null}
                </div>
              ) : null}
              <div className="dyna-attention">
                <span>
                  {props.dueAt
                    ? `Decision due ${relativeTime(props.dueAt, controller.locale)}`
                    : "Decision"}
                </span>
                <p>{props.attention ?? props.priorityReason}</p>
              </div>
              {summaryNeedsDisclosure ? null : (
                <p className="dyna-inspector-summary">{props.summary}</p>
              )}
              {props.nextSteps.length > 0 ? (
                <section className="dyna-inspector-section">
                  <h3>Immediate Next Steps</h3>
                  <ol className="dyna-next">
                    {props.nextSteps.map((step, index) => (
                      <li key={`${index}-${step.label}`}>
                        <span className="dyna-next-number" aria-hidden="true">
                          {index + 1}
                        </span>
                        {step.label}
                        {step.owner || step.dueAt ? (
                          <span className="dyna-next-meta">
                            {step.owner ?? ""}
                            {step.owner && step.dueAt ? " · " : ""}
                            {step.dueAt ? `due ${relativeTime(step.dueAt, controller.locale)}` : ""}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}
              <CodexWork key={props.itemId} card={props}>
                {children}
              </CodexWork>
              {props.people.length > 0 ? (
                <section className="dyna-inspector-section">
                  <h3>People</h3>
                  <ul className="dyna-people" aria-label="Relevant people">
                    {props.people.slice(0, 4).map((person, index) => (
                      <li
                        className="dyna-person"
                        key={`${person.displayName}-${person.involvement}-${index}`}
                        title={`${humanize(person.leadershipLevel)} · ${humanize(person.relationship)} · ${person.provenance}`}
                      >
                        <strong>{person.displayName}</strong>
                        <span>
                          {person.title ?? humanize(person.leadershipLevel)} ·{" "}
                          {humanize(person.involvement)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {summaryNeedsDisclosure ? (
                <details className="dyna-context-details dyna-summary-details">
                  <summary>
                    <ChevronRight className="dyna-disclosure" aria-hidden="true" />
                    Context
                  </summary>
                  <p className="dyna-inspector-summary">{props.summary}</p>
                </details>
              ) : null}
              {props.outcome ? (
                <div className="dyna-outcome">
                  <span>Outcome</span>
                  <p>{props.outcome}</p>
                </div>
              ) : null}
              {props.workUpdateCount > 0 ? (
                <WorkActivity
                  key={props.itemId}
                  itemId={props.itemId}
                  initialUpdates={props.workUpdates}
                  workUpdateCount={props.workUpdateCount}
                />
              ) : null}
              <details className="dyna-context-details">
                <summary>
                  <ChevronRight className="dyna-disclosure" aria-hidden="true" />
                  Plan, priority rationale, and provenance
                </summary>
                <div className="dyna-context-body">
                  {props.plan.length > 0 ? (
                    <ul className="dyna-plan">
                      {props.plan.map((step, index) => (
                        <li key={`${index}-${step}`}>{step}</li>
                      ))}
                    </ul>
                  ) : null}
                  <p className="dyna-reason">Why now: {props.priorityReason}</p>
                  {props.sourcePriority !== props.priority ? (
                    <span className="dyna-lift">
                      {props.priorityMode === "manual"
                        ? `Manually moved from ${props.sourcePriority}`
                        : props.priorityMode === "leadership"
                          ? `Raised from ${props.sourcePriority} using leadership context`
                          : `Refined from ${props.sourcePriority} by later analysis`}
                    </span>
                  ) : null}
                  {props.enrichmentState === "stale" ? (
                    <Badge color="warning" variant="soft">
                      Enrichment needs review
                    </Badge>
                  ) : null}
                  {props.followUpOfItemId ? (
                    <span className="dyna-meta">Follow-up to completed work</span>
                  ) : null}
                  {props.labels.length > 0 ? (
                    <div className="dyna-labels">
                      {props.labels.map((label) => (
                        <Badge color="secondary" variant="soft" key={label}>
                          {label}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  <div className="dyna-origin">
                    <strong>
                      {props.source === "manual" ? "Created in Dyna" : "Originating record"}
                    </strong>
                    {props.source === "manual" ? null : props.sourceUrl ? (
                      <a
                        className="dyna-origin-link"
                        href={props.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(event) => {
                          handleExternalAnchorClick(event, props.sourceUrl ?? "", controller);
                        }}
                      >
                        {sourceReferenceLabel(props.sourceRef)}
                        <ExternalLink className="dyna-source-link-icon" aria-hidden="true" />
                      </a>
                    ) : (
                      <code>{sourceReferenceLabel(props.sourceRef)}</code>
                    )}
                    <span className="dyna-meta">
                      {props.source === "manual" ? "Added" : "Updated"}{" "}
                      {relativeTime(props.sourceUpdatedAt, controller.locale)}
                    </span>
                  </div>
                </div>
              </details>
              {props.annotationPreview.length > 0 ? (
                <section className="dyna-inspector-section">
                  <h3>Recent Notes</h3>
                  <ul className="dyna-note-list" aria-label="Recent Notes">
                    {props.annotationPreview.map((note, index) => (
                      <li key={`${index}-${note.createdAt}-${note.body}`}>
                        <time dateTime={note.createdAt} title={note.createdAt}>
                          {exactDateTime(note.createdAt, controller.locale)}
                        </time>
                        <span>{note.body}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
            <div className="dyna-inspector-footer">
              <InspectorActions card={props} />
            </div>
          </InspectorShell>
        ) : null}
      </article>
    );
  },
  TaskStatus: ({ props }) => {
    const controller = useController();
    return (
      <div
        className="dyna-task"
        data-dyna-item-id={props.itemId}
        data-dyna-task-id={props.taskId}
        data-dyna-task-host={props.hostId}
      >
        <span>
          <strong>{props.title}</strong>
          <br />
          <Badge
            color={
              props.state === "succeeded"
                ? "success"
                : props.state === "failed"
                  ? "danger"
                  : props.state === "waiting"
                    ? "warning"
                    : "secondary"
            }
            variant="soft"
          >
            {humanize(props.state)}
          </Badge>{" "}
          <span>Observed {relativeTime(props.observedAt, controller.locale)}</span>
          {props.outcome ? <span className="dyna-task-outcome">{props.outcome}</span> : null}
        </span>
        <div className="dyna-task-actions">
          <Button
            data-dyna-action={`${props.itemId}:open_codex_task:${props.taskId}`}
            color="secondary"
            variant="ghost"
            size="xs"
            onClick={(event) => {
              void controller.request(
                props.itemId,
                props.itemFingerprint,
                "open_codex_task",
                props.taskId,
                props.hostId,
                event.currentTarget,
              );
            }}
            disabled={controller.busy || controller.codexActionsBlocked}
          >
            <ExternalLink className="dyna-icon" aria-hidden="true" />
            Open task
          </Button>
          <Button
            data-dyna-action={`${props.itemId}:refresh_codex_status:${props.taskId}`}
            aria-label={`Refresh status for ${props.title}`}
            color="secondary"
            variant="ghost"
            size="xs"
            onClick={(event) => {
              void controller.request(
                props.itemId,
                props.itemFingerprint,
                "refresh_codex_status",
                props.taskId,
                props.hostId,
                event.currentTarget,
              );
            }}
            disabled={controller.busy || controller.codexActionsBlocked}
          >
            Refresh
          </Button>
        </div>
      </div>
    );
  },
  ScheduleStatus: ({ props }) => {
    const controller = useController();
    const revoked = Boolean(props.revokedAt);
    const slices = props.lastSourceSlices ?? [];
    const unhealthySlices = slices.filter(
      (slice) => slice.status === "failed" || slice.freshness !== "fresh",
    );
    const healthySliceCount = slices.length - unhealthySlices.length;
    return (
      <div className="dyna-schedule">
        <strong>{props.scheduleTitle ?? props.name}</strong>
        <Badge
          color={
            revoked || props.lastRunStatus === "failed"
              ? "danger"
              : props.lastRunStatus === "partial"
                ? "warning"
                : props.lastRunStatus === "succeeded"
                  ? "success"
                  : "secondary"
          }
          variant="soft"
        >
          {revoked ? "revoked" : props.lastRunStatus}
        </Badge>
        <span className="dyna-meta">
          {revoked
            ? `Publisher revoked${props.lastRunAt ? ` · last run ${props.lastRunStatus} ${relativeTime(props.lastRunAt, controller.locale)}` : " · not run yet"}`
            : `${props.scheduleState}${props.lastRunAt ? ` · last run ${relativeTime(props.lastRunAt, controller.locale)}` : " · not run yet"}`}
        </span>
        {props.lastRunError ? <span className="dyna-meta">{props.lastRunError}</span> : null}
        {slices.length > 0 ? (
          unhealthySlices.length === 0 ? (
            <span className="dyna-meta">
              {slices.length} {slices.length === 1 ? "source" : "sources"} fresh
            </span>
          ) : (
            <div className="dyna-slice-summary" role="list" aria-label="Latest source results">
              {unhealthySlices.map((slice) => {
                const state = slice.status === "failed" ? "failed" : slice.freshness;
                return (
                  <span
                    key={`${slice.source}:${slice.sourceScope}`}
                    className="dyna-slice"
                    role="listitem"
                    aria-label={`${sourceSliceLabel(slice.source)} ${slice.sourceScope}: ${state}`}
                    title={slice.sourceScope}
                  >
                    <SourceFavicon kind={slice.source} />
                    <Badge
                      color={state === "failed" || state === "stale" ? "danger" : "warning"}
                      variant="soft"
                      aria-hidden="true"
                    >
                      {state}
                    </Badge>
                  </span>
                );
              })}
              {healthySliceCount > 0 ? (
                <span className="dyna-meta">
                  {healthySliceCount} {healthySliceCount === 1 ? "source" : "sources"} fresh
                </span>
              ) : null}
            </div>
          )
        ) : null}
      </div>
    );
  },
  EmptyState: ({ props }) => {
    const controller = useController();
    return (
      <div className="dyna-empty-wrap">
        <div className="dyna-empty">
          <strong>
            {controller.query
              ? "Nothing matched"
              : controller.view === "archive"
                ? "Archive is empty"
                : "Queue is clear"}
          </strong>
          <p>{props.message}</p>
          {controller.query ? (
            <Button
              color="secondary"
              size="sm"
              variant="outline"
              onClick={() => {
                controller.setQuery("");
              }}
            >
              Clear search
            </Button>
          ) : null}
        </div>
      </div>
    );
  },
};

const PRIORITY_GROUPS = [
  ["critical", "Act Now"],
  ["high", "Needs Attention"],
  ["normal", "Keep Moving"],
  ["low", "On the Radar"],
] as const;

const PIPELINE_STAGES = [
  ["todo", "To Do"],
  ["executing", "In Codex"],
  ["needs_you", "Needs You"],
  ["completed", "Done"],
] as const satisfies readonly (readonly [WorkflowStage, string])[];

function cardWorkflowStage(card: Pick<DynaCard, "workflowState">): WorkflowStage {
  return card.workflowState === "paused" || card.workflowState === "attention"
    ? "needs_you"
    : card.workflowState;
}

type ActionableTaskCard = Pick<
  DynaCard,
  "blocked" | "linkedTasks" | "workflowState" | "workState" | "workUpdates"
> & {
  readonly workConditionSummary?: string | undefined;
  readonly workConditionTask?: DynaCardUxFields["workConditionTask"] | undefined;
};

interface ActionableTaskSelection {
  readonly task?: DynaTask;
  readonly condition?: string;
  readonly summary?: string;
}

function taskWithIdentity(
  card: Pick<DynaCard, "linkedTasks">,
  identity: DynaCardUxFields["workConditionTask"],
): DynaTask | undefined {
  if (!identity) return undefined;
  return card.linkedTasks.find(
    (task) => task.taskId === identity.taskId && task.hostId === identity.hostId,
  );
}

function reportedConditionTask(
  card: ActionableTaskCard,
  kind: "needs_input" | "blocked",
): DynaTask | undefined {
  if (card.workState !== kind) return undefined;
  const projectedTask = taskWithIdentity(card, card.workConditionTask);
  if (projectedTask) return projectedTask;
  const updateTask = card.workUpdates.find((update) => update.kind === kind)?.task;
  return taskWithIdentity(card, updateTask);
}

function sameTask(
  left: DynaTask | undefined,
  right: DynaTask | DynaCardUxFields["workConditionTask"] | undefined,
): boolean {
  return (
    left?.taskId !== undefined &&
    right?.taskId !== undefined &&
    left.taskId === right.taskId &&
    left.hostId === right.hostId
  );
}

function actionableTaskSelection(card: ActionableTaskCard): ActionableTaskSelection {
  if (card.workflowState === "completed") {
    const task = card.linkedTasks[0];
    return task ? { task } : {};
  }

  const reportedInput = reportedConditionTask(card, "needs_input");
  const nativeWaiting = card.linkedTasks.find((task) => task.state === "waiting");
  const nativeFailure =
    card.linkedTasks.find((task) => task.state === "failed") ??
    card.linkedTasks.find((task) => task.state === "unknown");
  const reportedBlocker = reportedConditionTask(card, "blocked");
  const activeTask = card.linkedTasks.find(
    (task) => task.state === "running" || task.state === "queued",
  );
  const task =
    reportedInput ??
    nativeWaiting ??
    nativeFailure ??
    reportedBlocker ??
    activeTask ??
    card.linkedTasks[0];

  const condition = sameTask(task, reportedInput)
    ? "Input needed"
    : task?.state === "waiting"
      ? "Input needed"
      : task?.state === "failed"
        ? "Task failed"
        : task?.state === "unknown"
          ? "Status unknown"
          : sameTask(task, reportedBlocker)
            ? "Blocked"
            : card.workState === "completion_reported"
              ? "Completion reported—verification pending"
              : card.workflowState === "paused"
                ? "Input needed"
                : card.workflowState === "attention" && !card.blocked
                  ? "Needs attention"
                  : undefined;
  const summaryMatchesCondition =
    sameTask(task, card.workConditionTask) &&
    ((card.workState === "needs_input" && condition === "Input needed") ||
      (card.workState === "blocked" && condition === "Blocked"));

  return {
    ...(task ? { task } : {}),
    ...(condition ? { condition } : {}),
    ...(summaryMatchesCondition && card.workConditionSummary
      ? { summary: card.workConditionSummary }
      : {}),
  };
}

function workflowStageLabel(stage: WorkflowStage): string {
  return PIPELINE_STAGES.find(([value]) => value === stage)?.[1] ?? humanize(stage);
}

function workPrompt(card: CardViewProps, locale: string): string {
  const reference = {
    schema: "dyna/work-item-v1",
    dashboardId: card.dashboardId,
    dashboardName: card.dashboardName,
    itemId: card.itemId,
    expectedFingerprint: card.fingerprint,
    sourceUpdatedAt: card.sourceUpdatedAt,
    copiedAt: new Date().toISOString(),
    workAttemptId: crypto.randomUUID(),
    linkedTasks: card.linkedTasks,
  };
  const contextLines = [
    `Title: ${card.title}`,
    `Priority: ${humanize(card.priority)}`,
    `Status: ${card.archive ? "Archived" : workflowStageLabel(card.workflowStage)}${card.workflowCondition ? ` (${card.workflowCondition})` : ""}`,
    `Source: ${card.sourceLabel} — ${sourceReferenceLabel(card.sourceRef)}`,
    ...(card.sourceUrl ? [`Source link: ${card.sourceUrl}`] : []),
    ...(card.dueAt ? [`Due: ${exactDateTime(card.dueAt, locale)}`] : []),
    `What needs attention: ${card.attention ?? card.priorityReason}`,
    `Context: ${card.summary}`,
  ];
  if (card.nextSteps.length > 0) {
    contextLines.push(
      "",
      "Immediate next steps:",
      ...card.nextSteps.map(
        (step, index) =>
          `${String(index + 1)}. ${step.label}${step.owner ? ` — ${step.owner}` : ""}${step.dueAt ? ` — due ${exactDateTime(step.dueAt, locale)}` : ""}`,
      ),
    );
  }
  if (card.plan.length > 0) {
    contextLines.push("", "Plan:", ...card.plan.map((step) => `- ${step}`));
  }
  if (card.outcome) contextLines.push("", `Recorded outcome: ${card.outcome}`);
  if (card.annotationPreview.length > 0) {
    contextLines.push(
      "",
      "Recent notes:",
      ...card.annotationPreview.map(
        (note) => `- ${exactDateTime(note.createdAt, locale)} — ${note.body}`,
      ),
    );
  }
  if (card.workUpdates.length > 0) {
    contextLines.push("", "Recent work activity:");
    for (const update of card.workUpdates) {
      const taskLabel = workUpdateTaskLabel(update);
      contextLines.push(
        `- ${exactDateTime(update.createdAt, locale)} · ${workUpdateKindLabel(update.kind)}${taskLabel ? ` · from linked task ${taskLabel}` : ""}: ${update.body}`,
      );
      if (update.outcome) contextLines.push(`  Outcome: ${update.outcome}`);
      for (const artifact of update.artifacts) {
        contextLines.push(`  Artifact: ${artifact.label} — ${artifact.url}`);
      }
    }
  }
  return [
    "Use $flowzone:dyna to keep this item synchronized while you work.",
    "",
    "Dyna work reference:",
    "```json",
    JSON.stringify(reference, null, 2).replaceAll("`", "\\u0060"),
    "```",
    "",
    "BEGIN UNTRUSTED DYNA CONTEXT",
    untrustedPromptText(contextLines.join("\n")),
    "END UNTRUSTED DYNA CONTEXT",
  ].join("\n");
}

function cardIsBlocked(card: Pick<DynaCard, "blocked" | "linkedTasks">): boolean {
  return (
    card.blocked ||
    card.linkedTasks.some((task) => task.state === "failed" || task.state === "unknown")
  );
}

function compareCards(left: DynaCard, right: DynaCard): number {
  const order = PRIORITY_GROUPS.map(([priority]) => priority);
  const byPriority = order.indexOf(left.priority) - order.indexOf(right.priority);
  if (byPriority !== 0) return byPriority;
  const bySequence =
    (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER);
  if (bySequence !== 0) return bySequence;
  const byLeadership = right.leadershipScore - left.leadershipScore;
  if (byLeadership !== 0) return byLeadership;
  const byDue = (left.dueAt ?? "9999").localeCompare(right.dueAt ?? "9999");
  if (byDue !== 0) return byDue;
  const byUpdated = right.sourceUpdatedAt.localeCompare(left.sourceUpdatedAt);
  return byUpdated !== 0 ? byUpdated : left.id.localeCompare(right.id);
}

type ExecutiveSummaryAction =
  | { readonly kind: "item"; readonly itemId: string }
  | { readonly kind: "query"; readonly query: string }
  | { readonly kind: "workflow"; readonly workflow: WorkflowFilter };

interface ExecutiveSummarySource {
  readonly key: string;
  readonly label: string;
  readonly icon: SourceIconKind;
  readonly category:
    | "codex"
    | "email"
    | "enterprise"
    | "knowledge"
    | "manual"
    | "messaging"
    | "skill"
    | "source_control"
    | "work_management";
}

interface ExecutiveSummaryPoint {
  readonly kind: "act" | "theme" | "motion" | "done" | "empty";
  readonly label: string;
  readonly headline: string;
  readonly detail?: string;
  readonly action?: ExecutiveSummaryAction;
  readonly sources: readonly ExecutiveSummarySource[];
}

interface ExecutiveSummaryModel {
  readonly scope: string;
  readonly coverage: "current" | "partial" | "delayed" | "pending" | "manual";
  readonly coverageText: string;
  readonly generatedAt: string;
  readonly revision: number;
  readonly points: readonly ExecutiveSummaryPoint[];
}

const GENERIC_SUMMARY_LABELS = new Set([
  "blocked",
  "blocker",
  "critical",
  "decision",
  "direct request",
  "done",
  "high",
  "in codex",
  "low",
  "merge request",
  "mr",
  "needs input",
  "normal",
  "pipeline",
  "pipeline failure",
  "pr",
  "pull request",
  "review",
  "todo",
]);

function executiveSummarySource(card: DynaCard): ExecutiveSummarySource {
  const sourceRef = card.sourceRef;
  let label = card.sourceLabel;
  let category: ExecutiveSummarySource["category"];
  if (sourceRef.source === "twg") {
    label = {
      jira: "Jira",
      confluence: "Confluence",
      bitbucket: "Bitbucket",
      org: "Org",
      work: "Work",
      other: "TWG",
    }[sourceRef.resultType];
    category = (
      {
        jira: "work_management",
        confluence: "knowledge",
        bitbucket: "source_control",
        org: "enterprise",
        work: "work_management",
        other: "enterprise",
      } as const
    )[sourceRef.resultType];
  } else if (sourceRef.source === "email") {
    category = "email";
    const provider = sourceRef.provider.toLocaleLowerCase();
    if (provider.includes("outlook") || provider.includes("microsoft")) label = "Outlook";
    else if (provider.includes("gmail") || provider.includes("google")) label = "Gmail";
  } else if (sourceRef.source === "messaging") {
    category = "messaging";
    const provider = sourceRef.provider.toLocaleLowerCase();
    if (provider.includes("slack")) label = "Slack";
    else if (provider.includes("discord")) label = "Discord";
  } else {
    category = (
      {
        slack: "messaging",
        outlook: "email",
        gitlab: "source_control",
        codex: "codex",
        scm: "source_control",
        skill: "skill",
        manual: "manual",
      } as const
    )[sourceRef.source];
  }
  return {
    key: label.toLocaleLowerCase(),
    label,
    icon: sourceIcon(sourceRef),
    category,
  };
}

function executiveSummarySources(cards: readonly DynaCard[]): ExecutiveSummarySource[] {
  const sources = new Map<string, ExecutiveSummarySource>();
  for (const card of cards) {
    const source = executiveSummarySource(card);
    sources.set(source.key, source);
  }
  return [...sources.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function executiveSummaryList(values: readonly string[], locale: string, limit = 4): string {
  const unique = [...new Set(values)];
  const shown = unique.slice(0, limit);
  const formatted = new Intl.ListFormat(locale, { style: "short", type: "conjunction" }).format(
    shown,
  );
  return unique.length > limit ? `${formatted} +${String(unique.length - limit)} more` : formatted;
}

function executiveSummaryDeadline(value: string, locale: string): string {
  return Date.parse(value) < Date.now()
    ? `Overdue · ${exactDateTime(value, locale)}`
    : `Due ${relativeTime(value, locale)}`;
}

function executiveSummaryCoverage(
  schedules: readonly DynaSchedule[],
  cards: readonly DynaCard[],
  locale: string,
): Pick<ExecutiveSummaryModel, "coverage" | "coverageText"> {
  const sourceNames = new Set(executiveSummarySources(cards).map((source) => source.label));
  const unavailable = new Set<string>();
  const delayed = new Set<string>();
  const pending = new Set<string>();

  for (const schedule of schedules) {
    const scheduleSources = new Set<string>();
    for (const slice of schedule.lastSourceSlices ?? []) {
      const label = sourceSliceLabel(slice.source);
      scheduleSources.add(label);
      sourceNames.add(label);
      if (slice.status === "failed") unavailable.add(label);
      else if (slice.freshness !== "fresh") delayed.add(label);
    }
    for (const slice of schedule.requiredSourceSlices ?? []) {
      const label = sourceSliceLabel(slice.source);
      scheduleSources.add(label);
      sourceNames.add(label);
    }
    const fallback = schedule.scheduleTitle ?? schedule.name;
    const affected = scheduleSources.size > 0 ? scheduleSources : new Set([fallback]);
    if (schedule.revokedAt || schedule.lastRunStatus === "failed") {
      for (const label of affected) unavailable.add(label);
    } else if (schedule.lastRunStatus === "partial") {
      for (const label of affected) {
        if (!unavailable.has(label)) delayed.add(label);
      }
    } else if (schedule.lastRunStatus === "never") {
      for (const label of affected) pending.add(label);
    }
    if (schedule.scheduleState !== "active") {
      for (const label of affected) delayed.add(label);
    }
  }

  if (schedules.length === 0) {
    if (cards.length === 0 || cards.every((card) => card.source === "manual")) {
      return { coverage: "manual", coverageText: "Manual work only." };
    }
    return {
      coverage: "delayed",
      coverageText: "Source status is unavailable. Summary uses the loaded records.",
    };
  }
  if (unavailable.size > 0) {
    return {
      coverage: "partial",
      coverageText: `Partial coverage: ${executiveSummaryList([...unavailable], locale, 3)} unavailable. Last-known records remain included.`,
    };
  }
  if (pending.size > 0) {
    return {
      coverage: "pending",
      coverageText: `No complete refresh yet: ${executiveSummaryList([...pending], locale, 3)} pending.`,
    };
  }
  if (delayed.size > 0) {
    return {
      coverage: "delayed",
      coverageText: `Delayed coverage: ${executiveSummaryList([...delayed], locale, 3)}. Last-known records remain included.`,
    };
  }
  return {
    coverage: "current",
    coverageText:
      sourceNames.size > 0
        ? `Current sources: ${executiveSummaryList([...sourceNames], locale, 5)}.`
        : "Current source refresh completed.",
  };
}

function buildExecutiveSummary(
  snapshot: DynaSnapshot,
  cards: readonly DynaCard[],
  query: string,
  filtersApplied: boolean,
  locale: string,
): ExecutiveSummaryModel {
  const sorted = [...cards].sort(compareCards);
  const unfinished = sorted.filter((card) => card.workflowState !== "completed");
  const completed = sorted
    .filter((card) => card.workflowState === "completed")
    .sort((left, right) => (right.completedAt ?? "").localeCompare(left.completedAt ?? ""));
  const points: ExecutiveSummaryPoint[] = [];
  const needsYou = unfinished.filter((card) => cardWorkflowStage(card) === "needs_you");
  const blocked = unfinished.filter(cardIsBlocked);
  const soon = Date.now() + 72 * 60 * 60_000;
  const actionable = unfinished.filter(
    (card) =>
      cardWorkflowStage(card) === "needs_you" ||
      cardIsBlocked(card) ||
      (card.dueAt !== undefined && Date.parse(card.dueAt) <= soon) ||
      card.priority === "critical" ||
      card.priority === "high",
  );
  const next = actionable[0] ?? unfinished[0];
  if (next) {
    const detail = [
      ...(next.dueAt ? [executiveSummaryDeadline(next.dueAt, locale)] : []),
      ...(next.nextSteps[0] ? [`Next: ${next.nextSteps[0].label}`] : []),
      ...(needsYou.length > 0 ? [`${String(needsYou.length)} need you`] : []),
      ...(blocked.length > 0 ? [`${String(blocked.length)} blocked`] : []),
    ];
    points.push({
      kind: "act",
      label: "Act Now",
      headline: next.title,
      ...(detail.length > 0 ? { detail: compactLine(detail.join(" · "), 220) } : {}),
      action: { kind: "item", itemId: next.id },
      sources: [executiveSummarySource(next)],
    });
  }

  const themes = new Map<
    string,
    {
      readonly display: string;
      readonly cards: Map<string, DynaCard>;
      readonly sources: Set<string>;
    }
  >();
  for (const card of unfinished) {
    for (const rawLabel of card.labels) {
      const normalized = rawLabel
        .normalize("NFKC")
        .trim()
        .replaceAll(/\s+/gu, " ")
        .toLocaleLowerCase();
      if (normalized.length < 3 || GENERIC_SUMMARY_LABELS.has(normalized)) continue;
      const existing = themes.get(normalized) ?? {
        display: rawLabel.trim(),
        cards: new Map<string, DynaCard>(),
        sources: new Set<string>(),
      };
      existing.cards.set(card.id, card);
      existing.sources.add(executiveSummarySource(card).category);
      themes.set(normalized, existing);
    }
  }
  const correlatedThemes = [...themes.entries()]
    .filter(([, theme]) => theme.sources.size >= 2)
    .sort(
      ([leftKey, left], [rightKey, right]) =>
        right.sources.size - left.sources.size ||
        right.cards.size - left.cards.size ||
        leftKey.localeCompare(rightKey),
    )
    .slice(0, 2);
  for (const [query, theme] of correlatedThemes) {
    const themeCards = [...theme.cards.values()].sort(compareCards);
    const themeSources = executiveSummarySources(themeCards);
    const themeBlocked = themeCards.filter(cardIsBlocked).length;
    points.push({
      kind: "theme",
      label: "Across Sources",
      headline: `${theme.display.slice(0, 1).toLocaleUpperCase()}${theme.display.slice(1)}`,
      detail: `${String(themeCards.length)} items across ${executiveSummaryList(
        themeSources.map((source) => source.label),
        locale,
        4,
      )}${themeBlocked > 0 ? ` · ${String(themeBlocked)} blocked` : ""}`,
      action: { kind: "query", query },
      sources: themeSources,
    });
  }

  const inCodex = unfinished.filter((card) => cardWorkflowStage(card) === "executing");
  const inputNeeded = unfinished.filter(
    (card) =>
      card.workState === "needs_input" || card.linkedTasks.some((task) => task.state === "waiting"),
  );
  const completionPending = unfinished.filter((card) => card.workState === "completion_reported");
  if (inCodex.length > 0 || inputNeeded.length > 0 || completionPending.length > 0) {
    const detail = [
      ...(inputNeeded.length > 0 && inCodex.length > 0
        ? [`${String(inputNeeded.length)} need input`]
        : []),
      ...(completionPending.length > 0
        ? [`${String(completionPending.length)} completion awaiting verification`]
        : []),
    ];
    const motionCards = [
      ...new Map(
        [...inCodex, ...inputNeeded, ...completionPending].map((card) => [card.id, card]),
      ).values(),
    ];
    points.push({
      kind: "motion",
      label: "In Motion",
      headline:
        inCodex.length > 0
          ? `${String(inCodex.length)} ${inCodex.length === 1 ? "item is" : "items are"} in Codex`
          : inputNeeded.length > 0
            ? `${String(inputNeeded.length)} Codex ${inputNeeded.length === 1 ? "task needs" : "tasks need"} you`
            : `${String(completionPending.length)} completion ${completionPending.length === 1 ? "report is" : "reports are"} awaiting verification`,
      ...(detail.length > 0 ? { detail: detail.join(" · ") } : {}),
      action: {
        kind: "workflow",
        workflow: inCodex.length > 0 || completionPending.length > 0 ? "executing" : "needs_you",
      },
      sources: executiveSummarySources(motionCards),
    });
  }

  if (completed.length > 0) {
    const latest = completed[0];
    if (latest) {
      points.push({
        kind: "done",
        label: "Recently Done",
        headline: `${String(completed.length)} completed recently`,
        detail: compactLine(`Latest: ${latest.outcome ?? latest.title}`, 220),
        action: { kind: "workflow", workflow: "completed" },
        sources: [executiveSummarySource(latest)],
      });
    }
  }

  const coverage = executiveSummaryCoverage(snapshot.schedules, snapshot.cards, locale);
  if (points.length === 0) {
    points.push({
      kind: "empty",
      label: "Current State",
      headline:
        coverage.coverage === "current"
          ? "No action signals were found in the latest complete refresh."
          : coverage.coverage === "manual"
            ? "No active commitments."
            : "No actionable items are present in the available data.",
      sources: [],
    });
  }

  const bounded = snapshot.counts.total > snapshot.cards.length;
  const searched = query.trim().length > 0;
  const scope = bounded
    ? `${filtersApplied ? `${String(cards.length)} filtered within ` : ""}highest-priority ${String(snapshot.cards.length)} of ${String(snapshot.counts.total)}${searched ? " matches" : " active items"}`
    : searched
      ? `${String(cards.length)} ${filtersApplied ? "filtered search" : "search"} ${cards.length === 1 ? "match" : "matches"}`
      : filtersApplied
        ? `${String(cards.length)} filtered ${cards.length === 1 ? "item" : "items"}`
        : `All ${String(snapshot.counts.total)} active ${snapshot.counts.total === 1 ? "item" : "items"}`;
  const fixedPoints = points.filter((point) => point.kind !== "theme");
  const themePoints = points.filter((point) => point.kind === "theme");
  const themeLimit = Math.max(0, 4 - fixedPoints.length);
  const selectedPoints = [
    ...points.filter((point) => point.kind === "act"),
    ...themePoints.slice(0, themeLimit),
    ...points.filter((point) => point.kind === "motion"),
    ...points.filter((point) => point.kind === "done" || point.kind === "empty"),
  ];
  return {
    scope,
    ...coverage,
    generatedAt: snapshot.generatedAt,
    revision: snapshot.revision,
    points: selectedPoints.slice(0, 4),
  };
}

function cardActions(
  card: DynaCard & DynaCardUxFields,
  selection: ActionableTaskSelection,
): readonly ActionDescriptor[] {
  const linkedTask = selection.task;
  const sourceActions =
    card.source === "manual" ? [] : [{ name: "open_source" as const, label: "Open source" }];
  return linkedTask
    ? [
        {
          name: "open_codex_task",
          label: selection.condition === "Input needed" ? "Respond in Codex" : "Open Codex",
          taskId: linkedTask.taskId,
          taskHostId: linkedTask.hostId,
        },
        ...sourceActions,
        { name: "annotate", label: "Add note" },
      ]
    : [
        { name: "create_codex_task", label: "Start in Codex" },
        ...sourceActions,
        { name: "annotate", label: "Add note" },
      ];
}

function cardSearchText(card: DynaCard): string {
  const ux = card as DynaCard & DynaCardUxFields;
  return [
    card.title,
    card.summary,
    card.sourceLabel,
    card.priority,
    card.priorityReason,
    JSON.stringify(card.sourceRef),
    card.attention ?? "",
    card.outcome ?? "",
    card.archive?.reason ?? "",
    card.archive?.reasonDetail ?? "",
    card.archive?.changedSinceArchive ? "changed since archive" : "",
    ux.workConditionSummary ?? "",
    ux.matchedActivity ?? "",
    ...card.labels,
    ...card.plan,
    ...card.nextSteps.flatMap((step) => [step.label, step.owner ?? ""]),
    ...card.people.flatMap((person) => [
      person.displayName,
      person.title ?? "",
      person.leadershipLevel,
      person.involvement,
      person.relationship,
    ]),
    ...card.annotations.map((annotation) => annotation.body),
    ...card.workUpdates.flatMap((update) => [
      workUpdateKindLabel(update.kind),
      update.body,
      update.outcome ?? "",
      update.task?.taskId ?? "",
      update.task?.hostId ?? "",
      update.task?.title ?? "",
      ...update.artifacts.flatMap((artifact) => [artifact.kind, artifact.label, artifact.url]),
    ]),
    ...card.linkedTasks.flatMap((task) => [task.title, task.state, task.outcome ?? ""]),
  ].join(" ");
}

function cardMatches(card: DynaCard, query: string, locale: string): boolean {
  const terms = query.trim().toLocaleLowerCase(locale).split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return true;
  const searchable = cardSearchText(card).toLocaleLowerCase(locale);
  return terms.every((term) => searchable.includes(term));
}

function cardPassesFilters(
  card: DynaCard,
  priority: PriorityFilter,
  source: string,
  workflow: WorkflowFilter,
  leadershipOnly: boolean,
): boolean {
  return (
    (priority === "all" || card.priority === priority) &&
    (source === "all" || card.sourceLabel === source) &&
    (workflow === "all" ||
      (workflow === "blocked" ? cardIsBlocked(card) : cardWorkflowStage(card) === workflow)) &&
    (!leadershipOnly || card.leadershipScore > 0)
  );
}

function cardViewProps(
  card: DynaCard,
  dashboard: Pick<DynaSnapshot["dashboard"], "id" | "name">,
): CardViewProps {
  const cardWithUx = card as DynaCard & DynaCardUxFields;
  const { id, annotations, linkedTasks, ...props } = cardWithUx;
  const selection = actionableTaskSelection(cardWithUx);
  const sourceUrl = dynaSourceUrl(card.sourceRef);
  return {
    ...props,
    dashboardId: dashboard.id,
    dashboardName: dashboard.name,
    itemId: id,
    searchText: cardSearchText(card),
    annotationPreview: annotations.slice(0, 3).map((annotation) => ({
      body: annotation.body,
      createdAt: annotation.createdAt,
    })),
    actions: cardActions(cardWithUx, selection),
    linkedTasks,
    workflowStage: cardWorkflowStage(card),
    ...(selection.condition ? { workflowCondition: selection.condition } : {}),
    ...(selection.summary ? { workflowSummary: selection.summary } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}

function CardView({
  card,
  dashboard,
}: {
  readonly card: DynaCard;
  readonly dashboard: Pick<DynaSnapshot["dashboard"], "id" | "name">;
}) {
  const PriorityCard = dynaComponents.PriorityCard;
  const TaskStatus = dynaComponents.TaskStatus;
  return (
    <PriorityCard props={cardViewProps(card, dashboard)}>
      {card.linkedTasks.map((task) => (
        <TaskStatus
          key={`${task.hostId}:${task.taskId}`}
          props={{ ...task, itemId: card.id, itemFingerprint: card.fingerprint }}
        />
      ))}
    </PriorityCard>
  );
}

function SnapshotDashboard({ snapshot }: { readonly snapshot: DynaSnapshot }) {
  const controller = useController();
  const Dashboard = dynaComponents.Dashboard;
  const SummaryStrip = dynaComponents.SummaryStrip;
  const ExecutiveSummary = dynaComponents.ExecutiveSummary;
  const Section = dynaComponents.Section;
  const QueueView = dynaComponents.QueueView;
  const PipelineView = dynaComponents.PipelineView;
  const PipelineStage = dynaComponents.PipelineStage;
  const ArchiveView = dynaComponents.ArchiveView;
  const ScheduleStatus = dynaComponents.ScheduleStatus;
  const EmptyState = dynaComponents.EmptyState;
  const compactInline = controller.condenseInline;
  const sourceOptions = [...new Set(snapshot.cards.map((card) => card.sourceLabel))].sort((a, b) =>
    a.localeCompare(b, controller.locale),
  );
  if (controller.sourceFilter !== "all" && !sourceOptions.includes(controller.sourceFilter)) {
    sourceOptions.unshift(controller.sourceFilter);
  }
  const stageCards = [...snapshot.cards]
    .filter(
      (card) =>
        controller.query.trim() === snapshot.query ||
        cardMatches(card, controller.query, controller.locale),
    )
    .filter((card) =>
      cardPassesFilters(
        card,
        controller.priorityFilter,
        controller.sourceFilter,
        "all",
        controller.leadershipOnly,
      ),
    )
    .sort(compareCards);
  const cards = stageCards.filter((card) =>
    cardPassesFilters(card, "all", "all", controller.workflowFilter, false),
  );
  const summaryCards = [...snapshot.cards]
    .filter(
      (card) =>
        controller.query.trim() === snapshot.query ||
        cardMatches(card, controller.query, controller.locale),
    )
    .filter((card) =>
      cardPassesFilters(
        card,
        controller.priorityFilter,
        controller.sourceFilter,
        controller.workflowFilter,
        controller.leadershipOnly,
      ),
    )
    .sort(compareCards);
  const summaryFiltersApplied =
    controller.priorityFilter !== "all" ||
    controller.sourceFilter !== "all" ||
    controller.workflowFilter !== "all" ||
    controller.leadershipOnly;
  const executiveSummary = buildExecutiveSummary(
    snapshot,
    summaryCards,
    controller.query,
    summaryFiltersApplied,
    controller.locale,
  );
  const queueCards = cards.filter((card) => card.workflowState !== "completed");
  const archiveCards = cards.filter((card) => Boolean(card.archive));
  const selectedCard = cards.find((card) => card.id === controller.selectedItemId);
  const inlineCards = selectedCard
    ? [selectedCard, ...queueCards.filter((card) => card.id !== selectedCard.id)].slice(
        0,
        controller.inlineCardLimit,
      )
    : queueCards.slice(0, controller.inlineCardLimit);
  const unhealthySchedules = snapshot.schedules.filter(
    (schedule) =>
      Boolean(schedule.revokedAt) ||
      schedule.lastRunStatus === "never" ||
      schedule.lastRunStatus === "failed" ||
      schedule.lastRunStatus === "partial" ||
      schedule.scheduleState !== "active" ||
      schedule.lastSourceSlices?.some((slice) => slice.freshness !== "fresh"),
  );
  const stages = PIPELINE_STAGES.map(([state, title]) => ({
    state,
    title,
    cards: cards.filter((card) => cardWorkflowStage(card) === state),
    count: cards.filter((card) => cardWorkflowStage(card) === state).length,
  }));

  const queueContent = compactInline ? (
    queueCards.length > 0 || selectedCard ? (
      <Section
        props={{
          title: "Top Attention",
          emptyMessage: "No active work needs attention.",
          count: queueCards.length,
        }}
      >
        {inlineCards.map((card) => (
          <CardView key={card.id} card={card} dashboard={snapshot.dashboard} />
        ))}
        {queueCards.length > controller.inlineCardLimit ? (
          <p className="dyna-inline-more">
            {queueCards.length - controller.inlineCardLimit} more in the full dashboard
          </p>
        ) : null}
      </Section>
    ) : (
      <EmptyState props={{ message: "No active work needs attention." }} />
    )
  ) : (
    <>
      {queueCards.length > 0
        ? PRIORITY_GROUPS.map(([priority, title]) => {
            const grouped = queueCards.filter((card) => card.priority === priority);
            return (
              <Section
                key={priority}
                props={{
                  title,
                  emptyMessage: "Drop an item here.",
                  count: grouped.length,
                  priority,
                  itemIds: grouped.map((card) => card.id),
                }}
              >
                {grouped.map((card) => (
                  <CardView key={card.id} card={card} dashboard={snapshot.dashboard} />
                ))}
              </Section>
            );
          })
        : null}
      {queueCards.length === 0 ? (
        <EmptyState
          props={{
            message:
              controller.query && cards.length === 0
                ? `No dashboard items match “${controller.query}”.`
                : (controller.priorityFilter !== "all" ||
                      controller.sourceFilter !== "all" ||
                      controller.workflowFilter !== "all" ||
                      controller.leadershipOnly) &&
                    cards.length === 0
                  ? "No dashboard items match the current filters."
                  : cards.length > 0
                    ? "Matching completed work is available in the Pipeline."
                    : "No signals have been published to this dashboard yet.",
          }}
        />
      ) : null}
      {snapshot.schedules.length > 0 ? (
        <Section
          props={{
            title: "Signal Runs",
            emptyMessage: "No schedules are attached.",
            count: snapshot.schedules.length,
            attention: unhealthySchedules.length > 0,
          }}
        >
          {snapshot.schedules.map((schedule) => (
            <ScheduleStatus key={schedule.id} props={schedule} />
          ))}
        </Section>
      ) : null}
    </>
  );

  return (
    <Dashboard
      props={{
        dashboardId: snapshot.dashboard.id,
        name: snapshot.dashboard.name,
        description: snapshot.dashboard.description,
        freshness: snapshot.freshness,
        generatedAt: snapshot.generatedAt,
        revision: snapshot.revision,
        sourceOptions,
        sourceAttention: unhealthySchedules.length > 0,
      }}
    >
      {controller.bulkMode && controller.view === "queue" ? (
        <BulkActions cards={queueCards} />
      ) : controller.view !== "archive" ? (
        <SummaryStrip
          props={{
            needsYou: stageCards.filter((card) => cardWorkflowStage(card) === "needs_you").length,
            inCodex: stageCards.filter((card) => cardWorkflowStage(card) === "executing").length,
            blocked: stageCards.filter(cardIsBlocked).length,
            shown: cards.length,
            total: snapshot.counts.total,
          }}
        />
      ) : null}
      {compactInline && unhealthySchedules.length > 0 ? (
        <Alert
          className="dyna-source-alert"
          color="warning"
          variant="soft"
          title="Source Refresh Needs Attention"
          description={`${unhealthySchedules.length} ${unhealthySchedules.length === 1 ? "source is" : "sources are"} delayed or unavailable.`}
        />
      ) : null}
      {!controller.bulkMode &&
      !compactInline &&
      controller.view !== "archive" &&
      snapshot.scope === "active" ? (
        <ExecutiveSummary props={{ model: executiveSummary, condensed: compactInline }} />
      ) : null}
      <QueueView props={{}}>{queueContent}</QueueView>
      {compactInline && controller.view !== "archive" && snapshot.scope === "active" ? (
        <ExecutiveSummary props={{ model: executiveSummary, condensed: true }} />
      ) : null}
      {!compactInline ? (
        <PipelineView props={{ stages }}>
          {stages.map((stage) => (
            <PipelineStage
              key={stage.state}
              props={{
                state: stage.state,
                title: stage.title,
                count: stage.count,
              }}
            >
              {stage.cards.map((card) => (
                <CardView key={card.id} card={card} dashboard={snapshot.dashboard} />
              ))}
            </PipelineStage>
          ))}
        </PipelineView>
      ) : null}
      {!compactInline ? (
        <ArchiveView props={{ count: snapshot.counts.archived }}>
          {snapshot.scope !== "archive" ? (
            <div className="dyna-empty" role="status">
              Loading archive…
            </div>
          ) : archiveCards.length > 0 ? (
            <Section
              props={{
                title: "Archived Items",
                emptyMessage: "No archived items.",
                count: archiveCards.length,
              }}
            >
              {archiveCards.map((card) => (
                <CardView key={card.id} card={card} dashboard={snapshot.dashboard} />
              ))}
            </Section>
          ) : (
            <EmptyState
              props={{
                message: controller.query
                  ? `No archived items match “${controller.query}”.`
                  : "No items have been archived yet.",
              }}
            />
          )}
        </ArchiveView>
      ) : null}
    </Dashboard>
  );
}

function metadataPayload(value: unknown): DynaUiPayload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const metadata = (value as Record<string, unknown>)["_meta"];
  if (!metadata || typeof metadata !== "object") return undefined;
  const record = metadata as Record<string, unknown>;
  const direct = DynaUiPayloadSchema.safeParse(record["dynaDashboard"]);
  if (direct.success) return direct.data;
  const envelope = record["flowzone"];
  if (!envelope || typeof envelope !== "object") return undefined;
  const parsed = DynaUiPayloadSchema.safeParse((envelope as Record<string, unknown>)["payload"]);
  return parsed.success ? parsed.data : undefined;
}

function DynaApp({ app }: { readonly app: App }) {
  const [payload, setPayload] = useState<DynaUiPayload>();
  const [annotationItem, setAnnotationItem] = useState<string>();
  const [annotation, setAnnotation] = useState("");
  const [todoOpen, setTodoOpen] = useState(false);
  const [todoTitle, setTodoTitle] = useState("");
  const [todoSummary, setTodoSummary] = useState("");
  const [todoPriority, setTodoPriority] = useState<TodoPriority>("normal");
  const [todoFollowUpOf, setTodoFollowUpOf] = useState<string>();
  const [view, setViewState] = useState<DashboardView>("queue");
  const [query, setQueryState] = useState("");
  const [priorityFilter, setPriorityFilterState] = useState<PriorityFilter>("all");
  const [sourceFilter, setSourceFilterState] = useState("all");
  const [workflowFilter, setWorkflowFilterState] = useState<WorkflowFilter>("all");
  const [leadershipOnly, setLeadershipOnlyState] = useState(false);
  const [bulkMode, setBulkModeState] = useState(false);
  const [bulkSelectedIds, setBulkSelectedIds] = useState<readonly string[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [contextMenu, setContextMenu] = useState<DynaContextMenuState>();
  const [actionFocusEpoch, setActionFocusEpoch] = useState(0);
  const [toast, setToast] = useState<string>();
  const [undoArchive, setUndoArchive] = useState<{
    readonly itemId: string;
    readonly fingerprint: string;
  }>();
  const [archiveTarget, setArchiveTarget] = useState<{
    readonly itemId: string;
    readonly fingerprint: string;
    readonly title: string;
  }>();
  const [restoreTarget, setRestoreTarget] = useState<{
    readonly itemId: string;
    readonly fingerprint: string;
    readonly title: string;
  }>();
  const [completionTarget, setCompletionTarget] = useState<{
    readonly itemId: string;
    readonly fingerprint: string;
    readonly title: string;
  }>();
  const [completionOutcome, setCompletionOutcome] = useState("");
  const [archiveReason, setArchiveReason] = useState<ArchiveReason>("no_action_needed");
  const [archiveReasonDetail, setArchiveReasonDetail] = useState("");
  const [connectionError, setConnectionError] = useState<string>();
  const [operationError, setOperationError] = useState<string>();
  const [displayMode, setDisplayMode] = useState<"inline" | "fullscreen" | "pip">("inline");
  const [wideLayout, setWideLayout] = useState(() => window.innerWidth >= 980);
  const [desktopInlineLayout, setDesktopInlineLayout] = useState(
    () => window.innerWidth > 560 && window.matchMedia("(pointer: fine)").matches,
  );
  const [canExpand, setCanExpand] = useState(false);
  const [initialExpansionPending, setInitialExpansionPending] = useState(true);
  const [hostCapabilities, setHostCapabilities] = useState<McpUiHostCapabilities>();
  const [locale, setLocale] = useState(navigator.language);
  const current = useRef<DynaUiPayload | undefined>(undefined);
  const refreshInFlight = useRef(false);
  const manualRefreshInFlight = useRef(false);
  const refreshFocusTrigger = useRef<HTMLElement | null>(null);
  const pendingSecondarySelection = useRef<
    | {
        readonly target: Element;
        readonly selection: string | null;
        readonly recordedAt: number;
      }
    | undefined
  >(undefined);
  const refreshGeneration = useRef(0);
  const queryRef = useRef("");
  const selectedItemRef = useRef<string | undefined>(undefined);
  const viewRef = useRef<DashboardView>("queue");
  const scrollPositions = useRef(new Map<ScrollSurface, number>());
  const pendingScrollPosition = useRef<number | null>(null);
  const detailScrollPosition = useRef(0);
  const annotationRequestId = useRef(crypto.randomUUID());
  const todoRequestId = useRef(crypto.randomUUID());
  const createdTodoFocus = useRef<string | undefined>(undefined);
  const hostContext = useRef<DynaHostContext>({});
  const hostCapabilitiesRef = useRef<McpUiHostCapabilities>({});
  const expansionInFlight = useRef<Promise<boolean> | undefined>(undefined);
  const pendingActions = useRef(
    new Map<string, { readonly requestId: string; readonly idempotencyKey: string }>(),
  );
  const archiveRequestIds = useRef(new Map<string, string>());
  const restoreRequestIds = useRef(new Map<string, string>());
  const statusRequestIds = useRef(new Map<string, string>());
  const annotationTrigger = useRef<HTMLElement | null>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  const todoTrigger = useRef<HTMLElement | null>(null);
  const archiveTrigger = useRef<HTMLElement | null>(null);
  const restoreTrigger = useRef<HTMLElement | null>(null);
  const statusTrigger = useRef<HTMLElement | null>(null);
  const expansionTrigger = useRef<HTMLElement | null>(null);
  const actionTrigger = useRef<{ readonly element: HTMLElement; readonly key: string } | null>(
    null,
  );
  const annotationFocusAfterSave = useRef<string | undefined>(undefined);
  const dialog = useRef<HTMLDivElement | null>(null);
  const contextMenuRef = useRef<DynaContextMenuState | undefined>(undefined);
  current.current = payload;
  queryRef.current = query;
  selectedItemRef.current = selectedItemId;
  viewRef.current = view;
  contextMenuRef.current = contextMenu;
  const backgroundLocked =
    annotationItem !== undefined ||
    todoOpen ||
    archiveTarget !== undefined ||
    restoreTarget !== undefined ||
    completionTarget !== undefined ||
    (selectedItemId !== undefined && !wideLayout);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".dyna-row-organize")) {
        closeOrganizationMenus();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !document.querySelector(".dyna-row-organize[open]")) return;
      event.preventDefault();
      closeOrganizationMenus({ restoreFocus: true });
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const acceptPayload = useCallback((candidate: unknown) => {
    const parsed = DynaUiPayloadSchema.safeParse(candidate);
    if (!parsed.success) return false;
    const active = current.current;
    if (
      active &&
      (parsed.data.snapshot.dashboard.id !== active.snapshot.dashboard.id ||
        parsed.data.viewToken !== active.viewToken ||
        parsed.data.snapshot.revision < active.snapshot.revision)
    ) {
      return false;
    }
    const selected = selectedItemRef.current;
    if (selected && !parsed.data.snapshot.cards.some((card) => card.id === selected)) {
      setSelectedItemId(undefined);
      setToast("The selected item is no longer in this view.");
    }
    const activeQueueIds = new Set(
      parsed.data.snapshot.cards
        .filter((card) => !card.archive && card.workflowState !== "completed")
        .map((card) => card.id),
    );
    setBulkSelectedIds((itemIds) => itemIds.filter((itemId) => activeQueueIds.has(itemId)));
    setPayload(parsed.data);
    setContextMenu((menu) =>
      menu?.itemId && !parsed.data.snapshot.cards.some((card) => card.id === menu.itemId)
        ? undefined
        : menu,
    );
    setConnectionError(undefined);
    return true;
  }, []);

  const closeContextMenu = useCallback((restoreFocus: boolean) => {
    const active = contextMenuRef.current;
    setContextMenu(undefined);
    if (restoreFocus && active?.invoker.isConnected) {
      window.setTimeout(() => {
        active.invoker.focus({ preventScroll: true });
      }, 0);
    }
  }, []);

  const copyMenuText = useCallback(async (value: string, message: string) => {
    try {
      await writeClipboardText(value);
      setToast(message);
    } catch {
      setToast("Clipboard unavailable. Press Command+C or Control+C.");
    }
  }, []);

  const openContextMenuAt = useCallback(
    (
      target: Element,
      x: number,
      y: number,
      keyboard: boolean,
      selectionOverride?: string | null,
    ): boolean => {
      if (
        !current.current ||
        !target.closest(
          ".dyna, .dyna-inspector-layer, .dyna-dialog, .dyna-toast, .dyna-context-menu",
        )
      ) {
        return false;
      }
      if (target.closest(".dyna-context-menu")) return true;
      const selection =
        selectionOverride === undefined
          ? contextSelection(target, x, y, keyboard)
          : (selectionOverride ?? undefined);
      const link = target.closest<HTMLAnchorElement>("a[href]");
      const linkUrl = contextLink(link ?? target);
      const inspector = Boolean(target.closest(".dyna-inspector"));
      const cardElement = target.closest<HTMLElement>(".dyna-card");
      const taskElement = target.closest<HTMLElement>(".dyna-task[data-dyna-task-id]");
      const itemId =
        taskElement?.dataset["dynaItemId"] ??
        cardElement?.dataset["itemId"] ??
        (inspector ? selectedItemRef.current : undefined);
      const focusable = target.closest<HTMLElement>(
        "a[href], button, input, textarea, select, summary, [tabindex]:not([tabindex='-1'])",
      );
      const itemTrigger = itemId
        ? document.querySelector<HTMLElement>(
            `${inspector ? ".dyna-inspector " : ""}[data-dyna-${inspector ? "copy-context" : "details-item"}="${CSS.escape(itemId)}"]`,
          )
        : undefined;
      const invoker = link ?? focusable ?? itemTrigger ?? (target as HTMLElement);
      const show = (
        kind: DynaContextMenuKind,
        details: Partial<
          Omit<DynaContextMenuState, "kind" | "x" | "y" | "invoker" | "keyboard">
        > = {},
      ) => {
        setContextMenu({ kind, x, y, invoker, keyboard, ...details });
      };

      if (selection) {
        show("selection", { selection, ...(linkUrl ? { linkUrl } : {}) });
        return true;
      }
      if (target.closest("input, textarea, [contenteditable]:not([contenteditable='false'])")) {
        setContextMenu(undefined);
        return false;
      }
      if (linkUrl) {
        show("link", { linkUrl });
        return true;
      }
      const control = target.closest("button, select, summary");
      if (taskElement && (!control || keyboard) && itemId) {
        const taskId = taskElement.dataset["dynaTaskId"];
        const taskHostId = taskElement.dataset["dynaTaskHost"];
        if (taskId && taskHostId) {
          show("task", { itemId, taskId, taskHostId, inspector: true });
          return true;
        }
      }
      if (!control || keyboard) {
        if (itemId) {
          show("item", { itemId, inspector });
          return true;
        }
      }
      if (control || target.closest(".dyna-dialog, .dyna-toast")) {
        setContextMenu(undefined);
        return true;
      }
      if (target.closest(".dyna")) {
        show("dashboard");
        return true;
      }
      return true;
    },
    [],
  );

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (
        !(event.target instanceof Element) ||
        (event.button !== 2 && !(event.button === 0 && event.ctrlKey))
      ) {
        return;
      }
      if (
        !event.target.closest(
          ".dyna, .dyna-inspector-layer, .dyna-dialog, .dyna-toast, .dyna-context-menu",
        )
      ) {
        return;
      }
      pendingSecondarySelection.current = {
        target: event.target,
        selection: contextSelection(event.target, event.clientX, event.clientY, false) ?? null,
        recordedAt: performance.now(),
      };
    };
    const onContextMenu = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const pending = pendingSecondarySelection.current;
      pendingSecondarySelection.current = undefined;
      const selectionOverride =
        pending &&
        performance.now() - pending.recordedAt < 1_000 &&
        (pending.target === event.target ||
          pending.target.contains(event.target) ||
          event.target.contains(pending.target))
          ? pending.selection
          : undefined;
      const recentMouseSecondary = selectionOverride !== undefined;
      if (Reflect.get(event, "pointerType") === "touch" && !recentMouseSecondary) return;
      if (
        document.documentElement.dataset["flowzoneDeveloperMode"] === "true" &&
        event.shiftKey &&
        (event.clientX !== 0 || event.clientY !== 0)
      ) {
        closeContextMenu(false);
        return;
      }
      if (openContextMenuAt(event.target, event.clientX, event.clientY, false, selectionOverride)) {
        event.preventDefault();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) ||
        !(event.target instanceof Element)
      ) {
        return;
      }
      const rect = event.target.getBoundingClientRect();
      if (openContextMenuAt(event.target, rect.left, rect.bottom, true)) event.preventDefault();
    };
    document.addEventListener("pointerdown", onMouseDown, true);
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onMouseDown, true);
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("contextmenu", onContextMenu, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [closeContextMenu, openContextMenuAt]);

  useEffect(() => {
    if (!backgroundLocked) return;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const restoreBodyScroll = lockBodyScroll();
    return () => {
      restoreBodyScroll();
      window.scrollTo(scrollX, scrollY);
    };
  }, [backgroundLocked]);

  useLayoutEffect(() => {
    const target = pendingScrollPosition.current;
    if (target === null) return;
    pendingScrollPosition.current = null;
    window.scrollTo(window.scrollX, target);
  }, [view]);

  useEffect(() => {
    if (!payload || !selectedItemId) return;
    const selected = payload.snapshot.cards.find((card) => card.id === selectedItemId);
    if (
      !selected ||
      (query.trim() !== payload.snapshot.query && !cardMatches(selected, query, locale)) ||
      !cardPassesFilters(selected, priorityFilter, sourceFilter, workflowFilter, leadershipOnly)
    ) {
      setSelectedItemId(undefined);
    }
  }, [
    leadershipOnly,
    locale,
    payload,
    priorityFilter,
    query,
    selectedItemId,
    sourceFilter,
    workflowFilter,
  ]);

  const refresh = useCallback(
    async (force = false) => {
      const active = current.current;
      if (
        !active ||
        !hostCapabilitiesRef.current.serverTools ||
        document.hidden ||
        (!force && refreshInFlight.current)
      )
        return;
      const generation = ++refreshGeneration.current;
      const requestedQuery = queryRef.current.trim();
      refreshInFlight.current = true;
      try {
        const result = await app.callServerTool({
          name: "dyna_get_snapshot",
          arguments: {
            viewToken: active.viewToken,
            currentRevision: active.snapshot.revision,
            ...(requestedQuery ? { query: requestedQuery } : {}),
            scope: viewRef.current === "archive" ? "archive" : "active",
          },
        });
        if (toolResultFailed(result)) throw new Error("Snapshot refresh failed.");
        const changed =
          (result.structuredContent as Readonly<Record<string, unknown>> | undefined)?.[
            "changed"
          ] === true;
        if (
          generation !== refreshGeneration.current ||
          requestedQuery !== queryRef.current.trim()
        ) {
          return;
        }
        const next = metadataPayload(result);
        if (next && !acceptPayload(next)) throw new Error("Snapshot identity validation failed.");
        if (!next) setConnectionError(undefined);
        return changed;
      } catch {
        if (generation === refreshGeneration.current) {
          setConnectionError(
            "Dashboard updates are disconnected. Actions are paused until the Remote host reconnects.",
          );
        }
        return undefined;
      } finally {
        if (generation === refreshGeneration.current) refreshInFlight.current = false;
      }
    },
    [acceptPayload, app],
  );

  const refreshLatest = useCallback(
    async (trigger: HTMLElement) => {
      if (manualRefreshInFlight.current || busy) return;
      setBulkSelectedIds([]);
      setBulkModeState(false);
      closeOrganizationMenus();
      manualRefreshInFlight.current = true;
      refreshFocusTrigger.current = trigger;
      setRefreshing(true);
      try {
        const changed = await refresh(true);
        if (changed !== undefined) {
          setOperationError(undefined);
          setToast(changed ? "Dashboard updated." : "Dashboard is up to date.");
        }
      } finally {
        manualRefreshInFlight.current = false;
        setRefreshing(false);
      }
    },
    [busy, refresh],
  );

  useLayoutEffect(() => {
    if (refreshing || !refreshFocusTrigger.current) return;
    const original = refreshFocusTrigger.current;
    refreshFocusTrigger.current = null;
    const fallback = [...document.querySelectorAll<HTMLElement>("[data-dyna-refresh]")].find(
      (candidate) => candidate.getClientRects().length > 0,
    );
    const target =
      original.isConnected && original.getClientRects().length > 0 ? original : fallback;
    target?.focus({ preventScroll: true });
  }, [payload?.snapshot.revision, refreshing]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void refresh(true);
    }, 250);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [query, refresh, view]);

  const requestExpandedPresentation = useCallback((): Promise<boolean> => {
    const pending = expansionInFlight.current;
    if (pending) return pending;
    const request = app
      .requestDisplayMode({ mode: "fullscreen" })
      .then((result) => {
        hostContext.current = { ...hostContext.current, displayMode: result.mode };
        setDisplayMode(result.mode);
        return result.mode === "fullscreen";
      })
      .finally(() => {
        if (expansionInFlight.current === request) expansionInFlight.current = undefined;
      });
    expansionInFlight.current = request;
    return request;
  }, [app]);

  useEffect(() => {
    let timeout: number | undefined;
    const schedule = () => {
      if (timeout !== undefined) window.clearTimeout(timeout);
      timeout = window.setTimeout(
        () => {
          void refresh().finally(schedule);
        },
        !document.hidden && document.hasFocus() ? 15_000 : 60_000,
      );
    };
    const onForeground = () => {
      if (!document.hidden) void refresh();
      schedule();
    };
    document.addEventListener("visibilitychange", onForeground);
    window.addEventListener("focus", onForeground);
    window.addEventListener("blur", schedule);
    schedule();
    return () => {
      document.removeEventListener("visibilitychange", onForeground);
      window.removeEventListener("focus", onForeground);
      window.removeEventListener("blur", schedule);
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [refresh]);

  useEffect(() => {
    const finePointer = window.matchMedia("(pointer: fine)");
    const onLayoutChange = () => {
      setWideLayout(window.innerWidth >= 980);
      setDesktopInlineLayout(window.innerWidth > 560 && finePointer.matches);
      document.documentElement.dataset["touch"] = String(
        Boolean(hostContext.current.deviceCapabilities?.touch) && !finePointer.matches,
      );
    };
    window.addEventListener("resize", onLayoutChange);
    finePointer.addEventListener("change", onLayoutChange);
    return () => {
      window.removeEventListener("resize", onLayoutChange);
      finePointer.removeEventListener("change", onLayoutChange);
    };
  }, []);

  useEffect(() => {
    const onToolResult = (result: AppEventMap["toolresult"]) => {
      const next = metadataPayload(result);
      if (next) acceptPayload(next);
    };
    app.addEventListener("toolresult", onToolResult);
    return () => {
      app.removeEventListener("toolresult", onToolResult);
    };
  }, [acceptPayload, app]);

  useEffect(() => {
    let mounted = true;
    const applyContext = (partial: McpUiHostContext) => {
      const context = { ...hostContext.current, ...partial } as DynaHostContext;
      hostContext.current = context;
      const rootData = document.documentElement.dataset as DOMStringMap & {
        locale?: string;
        timeZone?: string;
        platform?: string;
        touch?: string;
      };
      if (context.theme === "light" || context.theme === "dark") applyDocumentTheme(context.theme);
      setDisplayMode(context.displayMode ?? "inline");
      setCanExpand(context.availableDisplayModes?.includes("fullscreen") ?? false);
      if (context.locale) {
        document.documentElement.lang = context.locale;
        rootData.locale = context.locale;
        setLocale(context.locale);
      }
      if (context.timeZone) rootData.timeZone = context.timeZone;
      const dimensions = context.containerDimensions;
      const width = dimensions && "width" in dimensions ? dimensions.width : dimensions?.maxWidth;
      if (width) document.documentElement.style.setProperty("--d-host-width", `${String(width)}px`);
      rootData.platform = context.platform ?? "unknown";
      rootData.touch = String(
        Boolean(context.deviceCapabilities?.touch) && !window.matchMedia("(pointer: fine)").matches,
      );
      const safe = context.safeAreaInsets;
      const rootStyle = document.documentElement.style;
      rootStyle.setProperty("--d-safe-top", `${String(safe?.top ?? 0)}px`);
      rootStyle.setProperty("--d-safe-right", `${String(safe?.right ?? 0)}px`);
      rootStyle.setProperty("--d-safe-bottom", `${String(safe?.bottom ?? 0)}px`);
      rootStyle.setProperty("--d-safe-left", `${String(safe?.left ?? 0)}px`);
    };
    app.addEventListener("hostcontextchanged", applyContext);
    void app
      .connect()
      .then(async () => {
        const context = app.getHostContext();
        if (context) applyContext(context);
        const capabilities = app.getHostCapabilities() ?? {};
        hostCapabilitiesRef.current = capabilities;
        setHostCapabilities(capabilities);
        setConnectionError(undefined);
        const currentMode = context?.displayMode ?? "inline";
        const hostModes = context?.availableDisplayModes;
        const canRequestFullscreen = hostModes?.includes("fullscreen") ?? true;
        if (currentMode !== "fullscreen" && canRequestFullscreen) {
          try {
            const expanded = await requestExpandedPresentation();
            if (mounted && !expanded) {
              setToast("Codex kept the dashboard inline. Use Open full dashboard to try again.");
            }
          } catch {
            if (mounted) {
              setToast(
                "Codex could not open the expanded dashboard. Use Open full dashboard to retry.",
              );
            }
          }
        }
        if (mounted) setInitialExpansionPending(false);
      })
      .catch(() => {
        if (mounted) {
          setInitialExpansionPending(false);
          setConnectionError(
            "Could not connect to the Remote host. Dashboard actions are unavailable.",
          );
        }
      });
    return () => {
      mounted = false;
      app.removeEventListener("hostcontextchanged", applyContext);
    };
  }, [app, requestExpandedPresentation]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => {
      setToast(undefined);
      setUndoArchive(undefined);
    }, 8_000);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [toast]);

  useEffect(() => {
    const trigger = expansionTrigger.current;
    if (!trigger || busy || initialExpansionPending) return;
    expansionTrigger.current = null;
    if (displayMode === "fullscreen") {
      window.setTimeout(() => document.getElementById("dyna-tab-queue")?.focus(), 0);
      return;
    }
    const currentTrigger = trigger.isConnected
      ? trigger
      : document.querySelector<HTMLElement>("[data-dyna-expand]");
    currentTrigger?.focus();
  }, [busy, displayMode, initialExpansionPending]);

  useEffect(() => {
    const itemId = annotationFocusAfterSave.current;
    if (!itemId || busy || annotationItem) return;
    annotationFocusAfterSave.current = undefined;
    const currentTrigger = annotationTrigger.current;
    const trigger =
      currentTrigger?.isConnected &&
      currentTrigger.getAttribute("data-dyna-annotation-item") === itemId
        ? currentTrigger
        : [...document.querySelectorAll<HTMLElement>("[data-dyna-annotation-item]")].find(
            (element) => element.getAttribute("data-dyna-annotation-item") === itemId,
          );
    trigger?.focus();
  }, [annotationItem, busy, payload]);

  useEffect(() => {
    const pending = actionTrigger.current;
    if (!pending || busy) return;
    actionTrigger.current = null;
    const target = pending.element.isConnected
      ? pending.element
      : document.querySelector<HTMLElement>(`[data-dyna-action="${CSS.escape(pending.key)}"]`);
    window.setTimeout(() => target?.focus(), 0);
  }, [actionFocusEpoch, busy, payload]);

  const closeAnnotation = useCallback(() => {
    setAnnotation("");
    setAnnotationItem(undefined);
    annotationRequestId.current = crypto.randomUUID();
    window.setTimeout(() => {
      annotationTrigger.current?.focus();
    }, 0);
  }, []);

  const closeTodo = useCallback(() => {
    setTodoOpen(false);
    setTodoTitle("");
    setTodoSummary("");
    setTodoPriority("normal");
    setTodoFollowUpOf(undefined);
    todoRequestId.current = crypto.randomUUID();
    window.setTimeout(() => todoTrigger.current?.focus(), 0);
  }, []);

  const closeArchive = useCallback(() => {
    setArchiveTarget(undefined);
    setArchiveReason("no_action_needed");
    setArchiveReasonDetail("");
    window.setTimeout(() => archiveTrigger.current?.focus(), 0);
  }, []);

  const closeRestore = useCallback(() => {
    setRestoreTarget(undefined);
    window.setTimeout(() => restoreTrigger.current?.focus(), 0);
  }, []);

  const closeCompletion = useCallback(() => {
    setCompletionTarget(undefined);
    setCompletionOutcome("");
    window.setTimeout(() => statusTrigger.current?.focus(), 0);
  }, []);

  const closeDetails = useCallback(() => {
    const trigger = detailTrigger.current;
    const itemId = selectedItemRef.current;
    setSelectedItemId(undefined);
    window.setTimeout(() => {
      window.scrollTo({ top: detailScrollPosition.current });
      const currentTrigger = trigger?.isConnected
        ? trigger
        : itemId
          ? document.querySelector<HTMLElement>(`[data-dyna-details-item="${CSS.escape(itemId)}"]`)
          : undefined;
      currentTrigger?.focus();
    }, 0);
  }, []);

  const openDetails = useCallback(
    async (itemId: string, trigger: HTMLElement) => {
      closeOrganizationMenus();
      detailTrigger.current = trigger;
      detailScrollPosition.current = window.scrollY;
      setSelectedItemId(itemId);
      if (displayMode !== "fullscreen" && canExpand) {
        setBusy(true);
        try {
          await requestExpandedPresentation();
        } catch {
          setToast("Could not expand the dashboard. Opening details here instead.");
        } finally {
          setBusy(false);
        }
      }
    },
    [canExpand, displayMode, requestExpandedPresentation],
  );

  const openExternal = useCallback(
    async (url: string) => {
      try {
        const destination = new URL(url);
        if (destination.protocol !== "https:" && destination.protocol !== "http:") {
          throw new Error("This source link protocol is not allowed.");
        }
        const result = await app.openLink({ url: destination.href });
        if (result.isError) throw new Error("The host could not open this source link.");
      } catch (error) {
        setToast(error instanceof Error ? error.message : "Could not open this source link.");
      }
    },
    [app],
  );

  const clearBulkSelection = useCallback(() => {
    setBulkSelectedIds([]);
    setBulkModeState(false);
    closeOrganizationMenus();
  }, []);

  const setBulkMode = useCallback((value: boolean) => {
    closeOrganizationMenus();
    setBulkSelectedIds([]);
    setBulkModeState(value);
    if (value) setSelectedItemId(undefined);
  }, []);

  const setBulkItemsSelected = useCallback((itemIds: readonly string[], selected: boolean) => {
    setBulkSelectedIds((currentIds) => {
      const next = new Set(currentIds);
      for (const itemId of itemIds) {
        if (selected) next.add(itemId);
        else next.delete(itemId);
      }
      return [...next];
    });
  }, []);

  const setQuery = useCallback(
    (value: string) => {
      clearBulkSelection();
      setQueryState(value);
    },
    [clearBulkSelection],
  );

  const setPriorityFilter = useCallback(
    (value: PriorityFilter) => {
      clearBulkSelection();
      setPriorityFilterState(value);
    },
    [clearBulkSelection],
  );

  const setSourceFilter = useCallback(
    (value: string) => {
      clearBulkSelection();
      setSourceFilterState(value);
    },
    [clearBulkSelection],
  );

  const setWorkflowFilter = useCallback(
    (value: WorkflowFilter) => {
      clearBulkSelection();
      setWorkflowFilterState(value);
    },
    [clearBulkSelection],
  );

  const setLeadershipOnly = useCallback(
    (value: boolean) => {
      clearBulkSelection();
      setLeadershipOnlyState(value);
    },
    [clearBulkSelection],
  );

  const clearFilters = useCallback(() => {
    clearBulkSelection();
    setPriorityFilterState("all");
    setSourceFilterState("all");
    setWorkflowFilterState("all");
    setLeadershipOnlyState(false);
  }, [clearBulkSelection]);

  const prepareScrollTransition = useCallback((nextView: DashboardView) => {
    scrollPositions.current.set(viewRef.current, window.scrollY);
    pendingScrollPosition.current = scrollPositions.current.get(nextView) ?? 0;
  }, []);

  const setView = useCallback(
    (value: DashboardView) => {
      if (value !== viewRef.current) {
        clearBulkSelection();
        prepareScrollTransition(value);
        viewRef.current = value;
        setContextMenu(undefined);
        setViewState(value);
      }
      setSelectedItemId(undefined);
    },
    [clearBulkSelection, prepareScrollTransition],
  );

  const executeArchive = useCallback(
    async (
      itemId: string,
      fingerprint: string,
      reason: ArchiveReason | "completed",
      reasonDetail?: string,
    ) => {
      const active = current.current;
      if (!active || busy || connectionError || !hostCapabilitiesRef.current.serverTools) return;
      const clientRequestId = archiveRequestIds.current.get(itemId) ?? crypto.randomUUID();
      archiveRequestIds.current.set(itemId, clientRequestId);
      setOperationError(undefined);
      setBusy(true);
      try {
        const result = await app.callServerTool({
          name: "dyna_archive_item",
          arguments: {
            viewToken: active.viewToken,
            itemId,
            reason,
            ...(reasonDetail?.trim() ? { reasonDetail: reasonDetail.trim() } : {}),
            expectedRevision: active.snapshot.revision,
            expectedFingerprint: fingerprint,
            clientRequestId,
          },
        });
        if (toolResultFailed(result)) throw new Error("Archive failed.");
        archiveRequestIds.current.delete(itemId);
        setArchiveTarget(undefined);
        setArchiveReasonDetail("");
        selectedItemRef.current = undefined;
        setSelectedItemId(undefined);
        setUndoArchive({ itemId, fingerprint });
        await refresh(true);
        setToast(reason === "completed" ? "Completed item archived." : "Item archived.");
      } catch {
        setOperationError("Could not archive the item. Refresh and try again.");
      } finally {
        setBusy(false);
      }
    },
    [app, busy, connectionError, refresh],
  );

  const executeRestore = useCallback(
    async (itemId: string, fingerprint: string) => {
      const active = current.current;
      if (!active || busy || connectionError || !hostCapabilitiesRef.current.serverTools) return;
      const clientRequestId = restoreRequestIds.current.get(itemId) ?? crypto.randomUUID();
      restoreRequestIds.current.set(itemId, clientRequestId);
      setOperationError(undefined);
      setBusy(true);
      try {
        const result = await app.callServerTool({
          name: "dyna_restore_item",
          arguments: {
            viewToken: active.viewToken,
            itemId,
            expectedRevision: active.snapshot.revision,
            expectedFingerprint: fingerprint,
            clientRequestId,
          },
        });
        if (toolResultFailed(result)) throw new Error("Restore failed.");
        restoreRequestIds.current.delete(itemId);
        setRestoreTarget(undefined);
        setUndoArchive(undefined);
        selectedItemRef.current = undefined;
        setSelectedItemId(undefined);
        await refresh(true);
        setToast("Item restored to the active board.");
      } catch {
        setOperationError("Could not restore the item. Refresh and try again.");
      } finally {
        setBusy(false);
      }
    },
    [app, busy, connectionError, refresh],
  );

  const executeStatusChange = useCallback(
    async (
      itemId: string,
      fingerprint: string,
      targetStage: ManualWorkflowStage,
      trigger: HTMLElement,
      outcome?: string,
    ) => {
      const active = current.current;
      if (!active || busy || connectionError || !hostCapabilitiesRef.current.serverTools) return;
      const clientRequestId = statusRequestIds.current.get(itemId) ?? crypto.randomUUID();
      statusRequestIds.current.set(itemId, clientRequestId);
      statusTrigger.current = trigger;
      setOperationError(undefined);
      setBusy(true);
      try {
        const result = await app.callServerTool({
          name: "dyna_set_item_status",
          arguments: {
            viewToken: active.viewToken,
            itemId,
            targetStage,
            ...(outcome?.trim() ? { outcome: outcome.trim() } : {}),
            expectedRevision: active.snapshot.revision,
            expectedFingerprint: fingerprint,
            clientRequestId,
          },
        });
        if (toolResultFailed(result)) throw new Error("Status change failed.");
        statusRequestIds.current.delete(itemId);
        setCompletionTarget(undefined);
        setCompletionOutcome("");
        await refresh(true);
        window.setTimeout(() => {
          const status = document.querySelector<HTMLElement>(
            `[data-dyna-status-item="${CSS.escape(itemId)}"]`,
          );
          (status ?? trigger).focus();
        }, 0);
        setToast(
          targetStage === "todo"
            ? "Moved to To Do."
            : targetStage === "needs_you"
              ? "Moved to Needs You."
              : "Marked Done.",
        );
        setConnectionError(undefined);
      } catch {
        setOperationError("Could not change the status. Refresh the dashboard and try again.");
      } finally {
        setBusy(false);
      }
    },
    [app, busy, connectionError, refresh],
  );

  useEffect(() => {
    const itemId = createdTodoFocus.current;
    if (!itemId || busy || todoOpen) return;
    createdTodoFocus.current = undefined;
    const item = document.querySelector<HTMLElement>(
      `[data-item-id="${CSS.escape(itemId)}"][data-presentation="queue"]`,
    );
    (item ?? document.getElementById("dyna-tab-queue"))?.focus();
  }, [busy, payload, todoOpen]);

  useEffect(() => {
    if (!annotationItem && !todoOpen && !archiveTarget && !restoreTarget && !completionTarget)
      return;
    const modal = dialog.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector(".dyna-context-menu")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (annotationItem) closeAnnotation();
        else if (archiveTarget) closeArchive();
        else if (restoreTarget) closeRestore();
        else if (completionTarget) closeCompletion();
        else closeTodo();
        return;
      }
      if (event.key !== "Tab" || !modal) return;
      const focusable = focusableElements(modal);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [
    annotationItem,
    archiveTarget,
    closeAnnotation,
    closeArchive,
    closeCompletion,
    closeRestore,
    closeTodo,
    restoreTarget,
    completionTarget,
    todoOpen,
  ]);

  const loadActivity = useCallback(
    async (itemId: string, cursor?: string): Promise<DynaActivityPage> => {
      const active = current.current;
      if (!active || !hostCapabilitiesRef.current.serverTools) {
        throw new Error("Dyna activity is unavailable on this host.");
      }
      const result = await app.callServerTool({
        name: "dyna_get_item_activity",
        arguments: {
          viewToken: active.viewToken,
          itemId,
          ...(cursor ? { cursor } : {}),
        },
      });
      if (toolResultFailed(result)) throw new Error("Dyna activity could not be loaded.");
      const page = activityPage(result, itemId);
      if (!page) throw new Error("Dyna returned invalid activity metadata.");
      return page;
    },
    [app],
  );

  const readActionStatus = useCallback(
    async (requestId: string): Promise<DynaActionStatus> => {
      const active = current.current;
      if (!active || !hostCapabilitiesRef.current.serverTools) {
        throw new Error("Dyna action status is unavailable on this host.");
      }
      const result = await app.callServerTool({
        name: "dyna_action_status",
        arguments: { viewToken: active.viewToken, requestId },
      });
      if (toolResultFailed(result)) throw new Error("Dyna action status could not be loaded.");
      const status = parseDynaActionStatus(result);
      if (!status) throw new Error("Dyna returned invalid action status metadata.");
      return status;
    },
    [app],
  );

  const waitForAction = useCallback(
    async (requestId: string): Promise<DynaActionStatus> => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const status = await readActionStatus(requestId);
        if (["succeeded", "failed", "needs_reconciliation"].includes(status.state)) {
          return status;
        }
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, 750);
        });
      }
      throw new Error("Dyna action status timed out.");
    },
    [readActionStatus],
  );

  const dispatchAction = useCallback(
    async (
      itemId: string,
      fingerprint: string,
      kind: Exclude<ActionName, "annotate">,
      taskId?: string,
      taskHostId?: string,
      trigger?: HTMLElement,
      sessionListRequestId?: string,
      localFeedback = false,
    ): Promise<DynaActionDispatch | undefined> => {
      const active = current.current;
      if (!active || (!localFeedback && busy) || connectionError) return undefined;
      if (!hostCapabilitiesRef.current.serverTools) {
        if (!localFeedback) setOperationError("This host does not support dashboard actions.");
        return undefined;
      }
      if (!hostCapabilitiesRef.current.message?.text) {
        if (!localFeedback) setOperationError("This host cannot send Dyna actions to Codex.");
        return undefined;
      }
      const settledFocus =
        !localFeedback && trigger
          ? {
              element: trigger,
              key: trigger.getAttribute("data-dyna-action") ?? `${itemId}:${kind}`,
            }
          : undefined;
      if (!localFeedback) {
        setOperationError(undefined);
        setBusy(true);
      }
      const actionKey = [
        active.snapshot.dashboard.id,
        active.snapshot.revision,
        itemId,
        fingerprint,
        kind,
        taskId ?? "",
        taskHostId ?? "",
        sessionListRequestId ?? "",
      ].join(":");
      let preparationComplete = false;
      try {
        let pending = pendingActions.current.get(actionKey);
        preparationComplete = Boolean(pending);
        if (!pending) {
          const idempotencyKey = `${actionKey}:${crypto.randomUUID()}`;
          const prepared = await app.callServerTool({
            name: "dyna_prepare_action",
            arguments: {
              viewToken: active.viewToken,
              itemId,
              kind,
              ...(taskId ? { taskId } : {}),
              ...(taskHostId ? { taskHostId } : {}),
              ...(sessionListRequestId ? { sessionListRequestId } : {}),
              expectedRevision: active.snapshot.revision,
              expectedFingerprint: fingerprint,
              idempotencyKey,
            },
          });
          if (toolResultFailed(prepared)) throw new Error("Action preparation failed.");
          const structured = prepared.structuredContent as Record<string, unknown> | undefined;
          const preparedId = structured?.["requestId"];
          if (typeof preparedId !== "string") throw new Error("No action request was prepared.");
          pending = { requestId: preparedId, idempotencyKey };
          pendingActions.current.set(actionKey, pending);
          preparationComplete = true;
        }
        const requestId = pending.requestId;
        const delivery = await app.callServerTool({
          name: "dyna_mark_action_delivered",
          arguments: { viewToken: active.viewToken, requestId },
        });
        if (toolResultFailed(delivery)) throw new Error("Action delivery failed.");
        const deliveryStateValue = (
          delivery.structuredContent as Record<string, unknown> | undefined
        )?.["state"];
        const deliveryState = typeof deliveryStateValue === "string" ? deliveryStateValue : "";
        if (["claimed", "succeeded", "failed", "needs_reconciliation"].includes(deliveryState)) {
          if (deliveryState !== "claimed") pendingActions.current.delete(actionKey);
          if (!localFeedback) {
            setToast(
              deliveryState === "claimed"
                ? "Codex is handling this request."
                : deliveryState === "needs_reconciliation"
                  ? "Review required before another task-creation attempt."
                  : `This request is already ${deliveryState.replaceAll("_", " ")}.`,
            );
          }
          return { requestId, state: deliveryState };
        }
        const send = () =>
          app.sendMessage({
            role: "user",
            content: [
              {
                type: "text",
                text: `Handle Dyna action request ${requestId} with $flowzone:dyna.`,
              },
            ],
          });
        const sent = await send();
        if (sent.isError) {
          const status = await readActionStatus(requestId);
          if (status.state === "delivered") {
            const retried = await send();
            if (retried.isError) throw new Error("Action delivery remains uncertain.");
          } else if (status.state === "claimed" || status.state === "succeeded") {
            if (status.state === "succeeded") pendingActions.current.delete(actionKey);
            if (!localFeedback) setToast("Codex is handling this request.");
            return { requestId, state: status.state };
          } else if (status.state === "failed" || status.state === "needs_reconciliation") {
            pendingActions.current.delete(actionKey);
            if (!localFeedback) {
              setToast(
                status.state === "needs_reconciliation"
                  ? "Review required before another task-creation attempt."
                  : "The request failed. Try again.",
              );
            }
            return { requestId, state: status.state };
          } else {
            throw new Error("The action request could not be reconciled.");
          }
        }
        if (!localFeedback) setToast("Request sent to Codex.");
        pendingActions.current.delete(actionKey);
        setConnectionError(undefined);
        return { requestId, state: "delivered" };
      } catch {
        if (!localFeedback) {
          setOperationError(
            preparationComplete
              ? "Action delivery is uncertain. Reconnect, then retry; Dyna will reuse the same request."
              : "Request was not sent. Refresh the dashboard and try again.",
          );
        }
        return undefined;
      } finally {
        if (!localFeedback) {
          if (settledFocus) {
            actionTrigger.current = settledFocus;
            setActionFocusEpoch((epoch) => epoch + 1);
          }
          setBusy(false);
        }
      }
    },
    [app, busy, connectionError, readActionStatus],
  );

  const controller = useMemo<DynaUiController>(
    () => ({
      busy,
      refreshing,
      blocked: Boolean(connectionError) || !hostCapabilities?.serverTools,
      codexActionsBlocked:
        Boolean(connectionError) ||
        !hostCapabilities?.serverTools ||
        !hostCapabilities.message?.text,
      readOnly: hostCapabilities !== undefined && !hostCapabilities.serverTools,
      messageUnavailable:
        hostCapabilities !== undefined &&
        Boolean(hostCapabilities.serverTools) &&
        !hostCapabilities.message?.text,
      displayMode,
      inspectorPresentation: wideLayout ? "split" : "route",
      modalOpen:
        annotationItem !== undefined ||
        todoOpen ||
        archiveTarget !== undefined ||
        restoreTarget !== undefined ||
        completionTarget !== undefined,
      canExpand,
      condenseInline: displayMode === "inline" && (canExpand || initialExpansionPending),
      initialExpansionPending,
      inlineCardLimit: desktopInlineLayout ? 5 : 4,
      locale,
      leadershipOnly,
      bulkMode,
      bulkSelectedIds,
      priorityFilter,
      query,
      serverQuery: payload?.snapshot.query ?? "",
      selectedItemId,
      sourceFilter,
      workflowFilter,
      externalLinks: Boolean(hostCapabilities?.openLinks),
      view,
      clearFilters,
      setBulkMode,
      setBulkItemsSelected,
      setLeadershipOnly,
      setPriorityFilter,
      setQuery,
      setSourceFilter,
      setWorkflowFilter,
      setView,
      refreshLatest,
      openExternal,
      loadActivity,
      closeDetails,
      openDetails,
      archive(itemId, fingerprint, title, trigger, reason) {
        archiveTrigger.current = trigger;
        if (reason === "completed") {
          void executeArchive(itemId, fingerprint, reason);
          return;
        }
        setArchiveReason("no_action_needed");
        setArchiveReasonDetail("");
        setArchiveTarget({ itemId, fingerprint, title });
      },
      restore(itemId, fingerprint, title, trigger) {
        restoreTrigger.current = trigger;
        setRestoreTarget({ itemId, fingerprint, title });
      },
      async copyContext(card) {
        try {
          await writeClipboardText(workPrompt(card, locale));
          setToast("Work prompt copied.");
        } catch {
          setToast("Clipboard is unavailable. Select and copy the context manually.");
        }
      },
      annotate(itemId, trigger) {
        annotationTrigger.current = trigger;
        annotationRequestId.current = crypto.randomUUID();
        setAnnotationItem(itemId);
      },
      startTodo(trigger, title = "", summary = "", followUpOfItemId) {
        todoTrigger.current = trigger;
        todoRequestId.current = crypto.randomUUID();
        setTodoTitle(title);
        setTodoSummary(summary);
        setTodoPriority("normal");
        setTodoFollowUpOf(followUpOfItemId);
        setTodoOpen(true);
      },
      async organize(itemId, fingerprint, action, trigger) {
        const active = current.current;
        if (!active || busy || connectionError || !hostCapabilitiesRef.current.serverTools) return;
        actionTrigger.current = {
          element: trigger,
          key: trigger.getAttribute("data-dyna-action") ?? `${itemId}:${action}`,
        };
        setOperationError(undefined);
        setBusy(true);
        try {
          const result = await app.callServerTool({
            name: "dyna_organize_item",
            arguments: {
              viewToken: active.viewToken,
              itemId,
              action,
              expectedRevision: active.snapshot.revision,
              expectedFingerprint: fingerprint,
            },
          });
          if (toolResultFailed(result)) throw new Error("Item organization failed.");
          const changed = Boolean(
            (result.structuredContent as Readonly<Record<string, unknown>> | undefined)?.[
              "changed"
            ],
          );
          if (!changed) {
            setToast("That item is already at the boundary.");
            return;
          }
          await refresh(true);
          setToast(
            action === "bump"
              ? "Priority raised."
              : action === "lower"
                ? "Priority lowered."
                : action === "earlier"
                  ? "Moved earlier."
                  : "Moved later.",
          );
          setConnectionError(undefined);
        } catch {
          setOperationError("Could not reorganize the item. Refresh the dashboard and try again.");
        } finally {
          setBusy(false);
        }
      },
      async place(itemId, fingerprint, targetPriority, beforeItemId, trigger) {
        const active = current.current;
        if (!active || busy || connectionError || !hostCapabilitiesRef.current.serverTools) return;
        setOperationError(undefined);
        setBusy(true);
        try {
          const result = await app.callServerTool({
            name: "dyna_organize_item",
            arguments: {
              viewToken: active.viewToken,
              itemId,
              action: "place",
              targetPriority,
              ...(beforeItemId ? { beforeItemId } : {}),
              expectedRevision: active.snapshot.revision,
              expectedFingerprint: fingerprint,
            },
          });
          if (toolResultFailed(result)) throw new Error("Item placement failed.");
          const changed = Boolean(
            (result.structuredContent as Readonly<Record<string, unknown>> | undefined)?.[
              "changed"
            ],
          );
          if (!changed) {
            setToast("That item is already there.");
            return;
          }
          await refresh(true);
          window.setTimeout(() => {
            const handle = document.querySelector<HTMLElement>(
              `[data-dyna-drag-item="${CSS.escape(itemId)}"]`,
            );
            (handle ?? trigger).focus();
          }, 0);
          setToast("Queue order updated.");
          setConnectionError(undefined);
        } catch {
          setOperationError("Could not move the item. Refresh the dashboard and try again.");
        } finally {
          setBusy(false);
        }
      },
      async bulkPlace(items, targetPriority, trigger) {
        const active = current.current;
        if (
          !active ||
          items.length === 0 ||
          busy ||
          connectionError ||
          !hostCapabilitiesRef.current.serverTools
        ) {
          return;
        }
        setOperationError(undefined);
        setBusy(true);
        try {
          const result = await app.callServerTool({
            name: "dyna_organize_item",
            arguments: {
              viewToken: active.viewToken,
              action: "group",
              items,
              targetPriority,
              expectedRevision: active.snapshot.revision,
            },
          });
          if (toolResultFailed(result)) throw new Error("Bulk placement failed.");
          const structured = result.structuredContent as
            Readonly<Record<string, unknown>> | undefined;
          const changed = structured?.["changed"] === true;
          const changedCount =
            typeof structured?.["changedCount"] === "number"
              ? structured["changedCount"]
              : changed
                ? items.length
                : 0;
          if (changed) await refresh(true);
          setBulkSelectedIds([]);
          setBulkModeState(false);
          window.setTimeout(() => {
            const bulkToggle = document.querySelector<HTMLElement>("[data-dyna-bulk-toggle]");
            (bulkToggle ?? trigger).focus();
          }, 0);
          const groupName =
            PRIORITY_GROUPS.find(([priority]) => priority === targetPriority)?.[1] ??
            humanize(targetPriority);
          setToast(
            changed
              ? `${changedCount} ${changedCount === 1 ? "item" : "items"} moved to ${groupName}.`
              : `Selected items are already in ${groupName}.`,
          );
          setConnectionError(undefined);
        } catch {
          await refresh(true);
          setOperationError(
            "Could not move the selected items. The queue was refreshed; review the selection and try again.",
          );
        } finally {
          setBusy(false);
        }
      },
      async moveToStage(itemId, fingerprint, target, trigger) {
        const active = current.current;
        const card = active?.snapshot.cards.find((candidate) => candidate.id === itemId);
        if (card?.fingerprint !== fingerprint || busy || connectionError) return;
        const currentStage = cardWorkflowStage(card);
        if (card.archive) {
          setOperationError("Restore this item before changing its status.");
          return;
        }
        if (target === "follow_up" || (currentStage === "completed" && target !== "completed")) {
          todoTrigger.current = trigger;
          todoRequestId.current = crypto.randomUUID();
          setTodoTitle(`Follow up: ${card.title}`);
          setTodoSummary(`Follow-up to completed Dyna item: ${card.title}`);
          setTodoPriority("normal");
          setTodoFollowUpOf(card.id);
          setTodoOpen(true);
          return;
        }
        if (target === currentStage) {
          setToast(`Already in ${workflowStageLabel(currentStage)}.`);
          return;
        }

        const linked = card.linkedTasks.length > 0;
        if (linked) {
          if (target === "todo" || target === "needs_you") {
            setOperationError(
              "This status follows the linked Codex task. Open that task to change what happens next.",
            );
            return;
          }
          const selectedTask = actionableTaskSelection(card).task;
          if (target === "executing") {
            if (!selectedTask) {
              setOperationError("No linked Codex task is available to open.");
              return;
            }
            await dispatchAction(
              itemId,
              fingerprint,
              "open_codex_task",
              selectedTask.taskId,
              selectedTask.hostId,
              trigger,
            );
            return;
          }
          const unfinishedTask =
            selectedTask && selectedTask.state !== "succeeded"
              ? selectedTask
              : card.linkedTasks.find((task) => task.state !== "succeeded");
          if (!unfinishedTask) {
            await refresh(true);
            setToast("All linked tasks are complete. Status refreshed.");
            return;
          }
          await dispatchAction(
            itemId,
            fingerprint,
            "refresh_codex_status",
            unfinishedTask.taskId,
            unfinishedTask.hostId,
            trigger,
          );
          return;
        }

        if (target === "executing") {
          await dispatchAction(
            itemId,
            fingerprint,
            "create_codex_task",
            undefined,
            undefined,
            trigger,
          );
          return;
        }
        if (target === "completed") {
          statusTrigger.current = trigger;
          setCompletionOutcome("");
          setCompletionTarget({ itemId, fingerprint, title: card.title });
          return;
        }
        await executeStatusChange(itemId, fingerprint, target, trigger);
      },
      async expand(trigger) {
        if (busy) return;
        expansionTrigger.current = trigger ?? null;
        setBusy(true);
        try {
          const expanded = await requestExpandedPresentation();
          if (!expanded) {
            setToast(
              "Could not expand the dashboard. The complete current view remains available.",
            );
          }
        } catch {
          setToast("Could not expand the dashboard. The complete current view remains available.");
        } finally {
          setBusy(false);
        }
      },
      async request(itemId, fingerprint, kind, taskId, taskHostId, trigger) {
        await dispatchAction(itemId, fingerprint, kind, taskId, taskHostId, trigger);
      },
      async loadCodexSessions(itemId, fingerprint, trigger) {
        const dispatched = await dispatchAction(
          itemId,
          fingerprint,
          "list_codex_sessions",
          undefined,
          undefined,
          trigger,
          undefined,
          true,
        );
        if (!dispatched) throw new Error("Session list request was not sent.");
        const status = await waitForAction(dispatched.requestId);
        if (status.state !== "succeeded" || !status.candidates) {
          throw new Error("Session list request did not succeed.");
        }
        return { requestId: dispatched.requestId, candidates: status.candidates };
      },
      async associateCodexSession(itemId, fingerprint, candidate, sessionListRequestId, trigger) {
        const dispatched = await dispatchAction(
          itemId,
          fingerprint,
          "attach_codex_task",
          candidate.taskId,
          candidate.hostId,
          trigger,
          sessionListRequestId,
          true,
        );
        if (!dispatched) throw new Error("Session association request was not sent.");
        const status = await waitForAction(dispatched.requestId);
        if (status.state !== "succeeded") {
          throw new Error("Session association did not succeed.");
        }
        await refresh(true);
        setToast("Codex session associated.");
      },
    }),
    [
      app,
      annotationItem,
      archiveTarget,
      bulkMode,
      bulkSelectedIds,
      completionTarget,
      busy,
      canExpand,
      connectionError,
      hostCapabilities,
      displayMode,
      desktopInlineLayout,
      clearFilters,
      initialExpansionPending,
      leadershipOnly,
      locale,
      payload?.snapshot.query,
      priorityFilter,
      requestExpandedPresentation,
      query,
      refresh,
      refreshLatest,
      refreshing,
      restoreTarget,
      selectedItemId,
      setBulkItemsSelected,
      setBulkMode,
      setLeadershipOnly,
      setPriorityFilter,
      setSourceFilter,
      setWorkflowFilter,
      sourceFilter,
      workflowFilter,
      closeDetails,
      executeArchive,
      executeRestore,
      executeStatusChange,
      dispatchAction,
      openDetails,
      openExternal,
      loadActivity,
      waitForAction,
      setQuery,
      setView,
      view,
      wideLayout,
      todoOpen,
    ],
  );

  async function saveAnnotation(): Promise<void> {
    const active = current.current;
    if (
      !active ||
      !annotationItem ||
      !annotation.trim() ||
      busy ||
      connectionError ||
      !hostCapabilitiesRef.current.serverTools
    )
      return;
    setOperationError(undefined);
    setBusy(true);
    try {
      const result = await app.callServerTool({
        name: "dyna_add_annotation",
        arguments: {
          viewToken: active.viewToken,
          itemId: annotationItem,
          clientRequestId: annotationRequestId.current,
          body: annotation.trim(),
        },
      });
      if (toolResultFailed(result)) throw new Error("Annotation save failed.");
      annotationRequestId.current = crypto.randomUUID();
      setAnnotation("");
      annotationFocusAfterSave.current = annotationItem;
      setAnnotationItem(undefined);
      setToast("Note added.");
      await refresh(true);
    } catch {
      setOperationError("Could not save the note. Reconnect to the Remote host and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function saveTodo(): Promise<void> {
    const active = current.current;
    if (
      !active ||
      !todoTitle.trim() ||
      busy ||
      connectionError ||
      !hostCapabilitiesRef.current.serverTools
    )
      return;
    setOperationError(undefined);
    setBusy(true);
    try {
      const result = await app.callServerTool({
        name: "dyna_add_todo",
        arguments: {
          viewToken: active.viewToken,
          clientRequestId: todoRequestId.current,
          title: todoTitle.trim(),
          ...(todoSummary.trim() ? { summary: todoSummary.trim() } : {}),
          priority: todoPriority,
          labels: [],
          ...(todoFollowUpOf ? { followUpOfItemId: todoFollowUpOf } : {}),
        },
      });
      if (toolResultFailed(result)) throw new Error("To-do creation failed.");
      const itemId = (result.structuredContent as Readonly<Record<string, unknown>> | undefined)?.[
        "itemId"
      ];
      if (typeof itemId !== "string") throw new Error("To-do identity was not returned.");
      createdTodoFocus.current = itemId;
      closeTodo();
      setWorkflowFilterState("all");
      setView("queue");
      setToast("To-do added to the priority queue.");
      await refresh(true);
    } catch {
      setOperationError("Could not add the to-do. Reconnect to the Remote host and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!payload) {
    return (
      <main className="dyna">
        {connectionError ? (
          <Alert
            className="dyna-alert"
            color="danger"
            variant="soft"
            title="Offline"
            description={connectionError}
          />
        ) : null}
        <div className="dyna-empty-wrap">
          <div className="dyna-empty" role="status">
            <strong>Loading dashboard</strong>
            <p>Connecting to the Dyna data source…</p>
          </div>
        </div>
      </main>
    );
  }
  const routeDetailsOpen = Boolean(selectedItemId) && !wideLayout;
  const contextCard = contextMenu?.itemId
    ? payload.snapshot.cards.find((card) => card.id === contextMenu.itemId)
    : undefined;
  const contextCardProps = contextCard
    ? cardViewProps(contextCard, payload.snapshot.dashboard)
    : undefined;
  const dashboardUnavailable =
    annotationItem !== undefined ||
    todoOpen ||
    archiveTarget !== undefined ||
    restoreTarget !== undefined ||
    completionTarget !== undefined ||
    routeDetailsOpen;
  return (
    <ControllerContext.Provider value={controller}>
      {connectionError ? (
        <Alert
          className="dyna-alert"
          color="danger"
          variant="soft"
          title="Offline"
          description={connectionError}
        />
      ) : null}
      {!connectionError && controller.readOnly ? (
        <div role="status" aria-label="Read-only host notice">
          <Alert
            className="dyna-alert"
            color="warning"
            variant="soft"
            title="Dashboard is read-only"
            description="This host does not support app-to-server tools. Viewing and local filtering remain available."
          />
        </div>
      ) : null}
      {!connectionError && controller.messageUnavailable ? (
        <div role="status" aria-label="Codex action capability notice">
          <Alert
            className="dyna-alert"
            color="warning"
            variant="soft"
            title="Codex actions unavailable"
            description="This host cannot send Dyna actions to Codex. Notes, to-dos, and prioritization remain available."
          />
        </div>
      ) : null}
      {operationError ? (
        <Alert
          className="dyna-alert"
          color="danger"
          variant="soft"
          title="Action unavailable"
          description={operationError}
        />
      ) : null}
      <div
        inert={dashboardUnavailable ? true : undefined}
        aria-hidden={dashboardUnavailable ? true : undefined}
      >
        <SnapshotDashboard snapshot={payload.snapshot} />
      </div>
      {contextMenu ? (
        <DynaContextMenu
          state={contextMenu}
          {...(contextCardProps ? { card: contextCardProps } : {})}
          onClose={closeContextMenu}
          onCopy={copyMenuText}
        />
      ) : null}
      {annotationItem ? (
        <div
          ref={dialog}
          className="dyna-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="annotation-title"
        >
          <form
            className="dyna-sheet dyna-note-sheet"
            onSubmit={(event) => {
              event.preventDefault();
              void saveAnnotation();
            }}
          >
            <div className="dyna-sheet-header">
              <h2 id="annotation-title">Add Note</h2>
            </div>
            <div className="dyna-sheet-body">
              <label htmlFor="dyna-annotation">Note</label>
              <Textarea
                id="dyna-annotation"
                className="dyna-field"
                size="sm"
                value={annotation}
                rows={4}
                maxLength={1_000}
                aria-describedby="dyna-annotation-help"
                placeholder="Example: Create a new Codex task to review this MR"
                onChange={(event) => {
                  setAnnotation(event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
                    return;
                  }
                  event.preventDefault();
                  if (annotation.trim() && !busy && !connectionError) {
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                autoFocus
              />
              <p id="dyna-annotation-help" className="dyna-field-help">
                Enter to add note · Shift+Enter for a new line
              </p>
            </div>
            <div className="dyna-sheet-actions">
              <Button
                type="button"
                color="secondary"
                size="sm"
                variant="ghost"
                onClick={closeAnnotation}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                color="primary"
                size="sm"
                loading={busy}
                disabled={!annotation.trim() || Boolean(connectionError) || busy}
              >
                Save note
              </Button>
            </div>
          </form>
        </div>
      ) : null}
      {todoOpen ? (
        <div
          ref={dialog}
          className="dyna-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="todo-title"
        >
          <div className="dyna-sheet">
            <div className="dyna-sheet-header">
              <h2 id="todo-title">Add to the Priority Queue</h2>
            </div>
            <div className="dyna-sheet-body">
              <label htmlFor="dyna-todo-title">To-do</label>
              <Input
                id="dyna-todo-title"
                className="dyna-field"
                type="text"
                size="2xl"
                value={todoTitle}
                maxLength={200}
                placeholder="What needs to get done?"
                onChange={(event) => {
                  setTodoTitle(event.currentTarget.value);
                }}
                autoFocus
              />
              <label htmlFor="dyna-todo-summary">Context</label>
              <Textarea
                id="dyna-todo-summary"
                className="dyna-field"
                size="lg"
                value={todoSummary}
                rows={3}
                maxLength={1_000}
                placeholder="Optional context or desired outcome"
                onChange={(event) => {
                  setTodoSummary(event.currentTarget.value);
                }}
              />
              <label htmlFor="dyna-todo-priority">Priority</label>
              <select
                id="dyna-todo-priority"
                className="dyna-native-select"
                value={todoPriority}
                onChange={(event) => {
                  setTodoPriority(event.currentTarget.value as TodoPriority);
                }}
              >
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="normal">Normal</option>
                <option value="low">Low</option>
              </select>
            </div>
            <div className="dyna-sheet-actions">
              <Button color="secondary" variant="ghost" onClick={closeTodo}>
                Cancel
              </Button>
              <Button
                color="primary"
                loading={busy}
                disabled={!todoTitle.trim() || Boolean(connectionError)}
                onClick={() => void saveTodo()}
              >
                Add to-do
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {completionTarget ? (
        <div
          ref={dialog}
          className="dyna-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="completion-title"
          aria-describedby="completion-description"
        >
          <form
            className="dyna-sheet dyna-confirm-sheet"
            onSubmit={(event) => {
              event.preventDefault();
              if (!completionOutcome.trim() || busy || connectionError) return;
              void executeStatusChange(
                completionTarget.itemId,
                completionTarget.fingerprint,
                "done",
                statusTrigger.current ?? event.currentTarget,
                completionOutcome,
              );
            }}
          >
            <div className="dyna-sheet-header">
              <h2 id="completion-title">Mark Item Done</h2>
              <p>{completionTarget.title}</p>
            </div>
            <div className="dyna-sheet-body">
              <label htmlFor="dyna-completion-outcome">Outcome</label>
              <Input
                id="dyna-completion-outcome"
                className="dyna-field"
                type="text"
                size="sm"
                value={completionOutcome}
                maxLength={200}
                placeholder="What was completed?"
                aria-describedby="completion-description"
                onChange={(event) => {
                  setCompletionOutcome(event.currentTarget.value);
                }}
                autoFocus
              />
              <p id="completion-description" className="dyna-modal-note">
                Add a precise one-line result. Done is a short confirmation state before automatic
                archiving.
              </p>
            </div>
            <div className="dyna-sheet-actions">
              <Button
                type="button"
                color="secondary"
                size="sm"
                variant="ghost"
                onClick={closeCompletion}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                color="primary"
                size="sm"
                loading={busy}
                disabled={!completionOutcome.trim() || Boolean(connectionError) || busy}
              >
                Mark Done
              </Button>
            </div>
          </form>
        </div>
      ) : null}
      {archiveTarget ? (
        <div
          ref={dialog}
          className="dyna-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="archive-title"
        >
          <div className="dyna-sheet">
            <div className="dyna-sheet-header">
              <h2 id="archive-title">Archive Item</h2>
              <p>{archiveTarget.title}</p>
            </div>
            <div className="dyna-sheet-body">
              <label htmlFor="dyna-archive-reason">Reason</label>
              <select
                id="dyna-archive-reason"
                className="dyna-native-select"
                value={archiveReason}
                onChange={(event) => {
                  setArchiveReason(event.currentTarget.value as ArchiveReason);
                }}
                autoFocus
              >
                <option value="invalid">Invalid</option>
                <option value="duplicate">Duplicate</option>
                <option value="no_action_needed">No action needed</option>
                <option value="superseded">Superseded</option>
                <option value="other">Other</option>
              </select>
              {archiveReason === "other" ? (
                <>
                  <label htmlFor="dyna-archive-detail">Explanation</label>
                  <Textarea
                    id="dyna-archive-detail"
                    className="dyna-field"
                    size="lg"
                    value={archiveReasonDetail}
                    rows={3}
                    maxLength={500}
                    placeholder="Why is no further action appropriate?"
                    onChange={(event) => {
                      setArchiveReasonDetail(event.currentTarget.value);
                    }}
                  />
                </>
              ) : null}
              <p className="dyna-modal-note">
                Archiving records a disposition; it does not mark this work completed.
              </p>
            </div>
            <div className="dyna-sheet-actions">
              <Button color="secondary" variant="ghost" onClick={closeArchive}>
                Cancel
              </Button>
              <Button
                color="primary"
                loading={busy}
                disabled={
                  Boolean(connectionError) ||
                  (archiveReason === "other" && !archiveReasonDetail.trim())
                }
                onClick={() =>
                  void executeArchive(
                    archiveTarget.itemId,
                    archiveTarget.fingerprint,
                    archiveReason,
                    archiveReason === "other" ? archiveReasonDetail : undefined,
                  )
                }
              >
                Archive item
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {restoreTarget ? (
        <div
          ref={dialog}
          className="dyna-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="restore-title"
          aria-describedby="restore-description"
        >
          <div className="dyna-sheet dyna-confirm-sheet">
            <div className="dyna-sheet-header">
              <h2 id="restore-title">Restore to Active Board?</h2>
              <p>{restoreTarget.title}</p>
            </div>
            <div className="dyna-sheet-body">
              <p id="restore-description" className="dyna-modal-note">
                The item returns to its current active lifecycle stage. Its archive history and
                evidence stay intact.
              </p>
            </div>
            <div className="dyna-sheet-actions">
              <Button
                type="button"
                color="secondary"
                size="sm"
                variant="ghost"
                onClick={closeRestore}
                autoFocus
              >
                Cancel
              </Button>
              <Button
                type="button"
                color="primary"
                size="sm"
                loading={busy}
                disabled={Boolean(connectionError) || busy}
                onClick={() => void executeRestore(restoreTarget.itemId, restoreTarget.fingerprint)}
              >
                Restore item
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {toast ? (
        <div className="dyna-toast" role="status">
          <span>{toast}</span>
          {undoArchive ? (
            <button
              type="button"
              onClick={() => void executeRestore(undoArchive.itemId, undoArchive.fingerprint)}
            >
              Undo
            </button>
          ) : null}
        </div>
      ) : null}
    </ControllerContext.Provider>
  );
}

const rootElement = document.querySelector<HTMLElement>("#dyna-root");
if (!rootElement) throw new Error("Dyna root element is missing.");
if (!document.documentElement.hasAttribute("data-theme")) {
  applyDocumentTheme(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
const app = new App(
  { name: "FlowZone Dyna", version: "0.1.0" },
  { availableDisplayModes: ["inline", "fullscreen"] },
  { strict: true, allowUnsafeEval: false },
);
createRoot(rootElement).render(<DynaApp app={app} />);

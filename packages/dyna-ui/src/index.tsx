import "./styles.css";

import { Alert } from "@openai/apps-sdk-ui/components/Alert";
import { Badge } from "@openai/apps-sdk-ui/components/Badge";
import { Button } from "@openai/apps-sdk-ui/components/Button";
import {
  Archive,
  ArrowLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Plus,
  RestoreUntrash,
  Search,
  X,
} from "@openai/apps-sdk-ui/components/Icon";
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
  DynaUiPayloadSchema,
  dynaSourceUrl,
  type DynaSourceRef,
  type DynaUiPayload,
} from "@flowzone/dyna-contracts";
import {
  createContext,
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

type ActionName =
  "annotate" | "open_source" | "create_codex_task" | "open_codex_task" | "refresh_codex_status";

type TodoPriority = "critical" | "high" | "normal" | "low";
type WorkflowStage = "todo" | "executing" | "needs_you" | "completed";
type PriorityFilter = TodoPriority | "all";
type WorkflowFilter = WorkflowStage | "blocked" | "all";
type DashboardView = "queue" | "pipeline" | "archive";
type ScrollSurface = DashboardView;
type ArchiveReason = "invalid" | "duplicate" | "no_action_needed" | "superseded" | "other";

const INLINE_SUMMARY_MAX_LENGTH = 240;
const DYNA_DRAG_TYPE = "application/x-flowzone-dyna-item";

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
  copyContext(card: CardViewProps): Promise<void>;
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
  readonly priorityFilter: PriorityFilter;
  readonly query: string;
  readonly selectedItemId: string | undefined;
  readonly serverQuery: string;
  readonly sourceFilter: string;
  readonly workflowFilter: WorkflowFilter;
  readonly externalLinks: boolean;
  readonly view: DashboardView;
  clearFilters(): void;
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

type DynaSnapshot = DynaUiPayload["snapshot"];
type DynaCard = DynaSnapshot["cards"][number];
type DynaSchedule = DynaSnapshot["schedules"][number];
type DynaSourceSlice = NonNullable<DynaSchedule["lastSourceSlices"]>[number];
type DynaTask = DynaCard["linkedTasks"][number];

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

function readDragItem(
  dataTransfer: DataTransfer,
): { readonly itemId: string; readonly fingerprint: string } | undefined {
  const raw = dataTransfer.getData(DYNA_DRAG_TYPE);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Readonly<Record<string, unknown>>;
    return typeof parsed["itemId"] === "string" &&
      typeof parsed["fingerprint"] === "string" &&
      /^[a-f0-9]{64}$/.test(parsed["fingerprint"])
      ? { itemId: parsed["itemId"], fingerprint: parsed["fingerprint"] }
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

type CardViewProps = Omit<DynaCard, "id" | "annotations" | "linkedTasks"> & {
  readonly itemId: string;
  readonly searchText: string;
  readonly annotationPreview: readonly {
    readonly body: string;
    readonly createdAt: string;
  }[];
  readonly actions: readonly ActionDescriptor[];
  readonly workflowStage: WorkflowStage;
  readonly workflowCondition?: string;
  readonly sourceUrl?: string;
};

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
  readonly Section: (
    args: ComponentArgs<{
      readonly title: string;
      readonly emptyMessage: string;
      readonly count: number;
      readonly attention?: boolean;
      readonly priority?: TodoPriority;
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
              void controller.openExternal(card.sourceUrl ?? "");
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
          aria-label="Dashboard summary"
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
  Section: ({ props, children }) => {
    const controller = useController();
    const [dropActive, setDropActive] = useState(false);
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
  PipelineStage: ({ props, children }) => (
    <section
      className="dyna-pipeline-stage"
      data-workflow-stage={props.state}
      aria-labelledby={`dyna-stage-title-${props.state}`}
    >
      <header>
        <h2 id={`dyna-stage-title-${props.state}`}>{props.title}</h2>
        <span>{props.count}</span>
      </header>
      <div className="dyna-pipeline-items" role="list">
        {props.count > 0 ? children : <p className="dyna-pipeline-empty">Nothing here.</p>}
      </div>
    </section>
  ),
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
    const workflowLabel = workflowStageLabel(props.workflowStage);
    const statusLabel = props.archive ? "Archived" : workflowLabel;
    const sourceMark = sourceIcon(props.sourceRef);
    const sourceMarkLabel =
      props.sourceRef.source === "twg" && sourceMark !== "twg"
        ? `${humanize(sourceMark)} via TWG`
        : props.sourceLabel;
    const summaryNeedsDisclosure = props.summary.length > INLINE_SUMMARY_MAX_LENGTH;
    const showPriority = presentation !== "queue" || controller.condenseInline;
    const showQueueMove =
      controller.view === "queue" &&
      !controller.condenseInline &&
      !props.archive &&
      props.workflowStage !== "completed";
    const canOrganize = showQueueMove && !controller.busy && !controller.blocked;
    const canDrag = canOrganize && window.matchMedia("(pointer: fine)").matches;
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
        data-has-move={showQueueMove}
        data-drop-active={dropActive}
        onDragOver={(event) => {
          if (!canDrag || !event.dataTransfer.types.includes(DYNA_DRAG_TYPE)) return;
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
          if (!canDrag) return;
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
              event.target.closest("a, button, summary, .dyna-overflow-menu")
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
              {showQueueMove ? (
                <details className="dyna-overflow dyna-row-organize">
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
                    onDragStart={(event) => {
                      document.documentElement.dataset["dynaDragging"] = "true";
                      const value = JSON.stringify({
                        itemId: props.itemId,
                        fingerprint: props.fingerprint,
                      });
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData(DYNA_DRAG_TYPE, value);
                      event.dataTransfer.setData("text/plain", props.itemId);
                      const card = event.currentTarget.closest<HTMLElement>(".dyna-card");
                      if (card) {
                        card.dataset["dragging"] = "true";
                        event.dataTransfer.setDragImage(card, 18, 18);
                      }
                    }}
                    onDragEnd={(event) => {
                      delete document.documentElement.dataset["dynaDragging"];
                      const card = event.currentTarget.closest<HTMLElement>(".dyna-card");
                      if (card) delete card.dataset["dragging"];
                      setDropActive(false);
                    }}
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
              <span className="dyna-row-status" data-workflow-stage={props.workflowStage}>
                {statusLabel}
              </span>
              {props.workflowCondition ? (
                <span
                  className="dyna-row-condition"
                  data-condition={
                    props.workflowCondition === "Input needed" ? "waiting" : "blocked"
                  }
                >
                  {props.workflowCondition}
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
              <span className="dyna-row-attention">{props.attention ?? props.priorityReason}</span>
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
                  <span>{statusLabel}</span>
                  {props.archive ? <span>{humanize(props.archive.reason)}</span> : null}
                  {props.workflowCondition ? <span>{props.workflowCondition}</span> : null}
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
              {props.people.length > 0 ? (
                <section className="dyna-inspector-section">
                  <h3>People</h3>
                  <div className="dyna-people" aria-label="Relevant people">
                    {props.people.slice(0, 4).map((person, index) => (
                      <span
                        className="dyna-person"
                        key={`${person.displayName}-${person.involvement}-${index}`}
                        title={`${humanize(person.leadershipLevel)} · ${humanize(person.relationship)} · ${person.provenance}`}
                      >
                        {person.displayName}
                        <small>
                          {person.title ?? humanize(person.leadershipLevel)} ·{" "}
                          {humanize(person.involvement)}
                        </small>
                      </span>
                    ))}
                  </div>
                </section>
              ) : null}
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
              {props.actions.some((action) => action.name === "open_codex_task") ? (
                <section className="dyna-inspector-section">
                  <h3>Codex Tasks</h3>
                  {children}
                </section>
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
                          void controller.openExternal(props.sourceUrl ?? "");
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
      <div className="dyna-task">
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

function cardWorkflowCondition(
  card: Pick<DynaCard, "workflowState" | "linkedTasks">,
): string | undefined {
  if (card.linkedTasks.some((task) => task.state === "failed")) return "Task failed";
  if (card.linkedTasks.some((task) => task.state === "unknown")) return "Status unknown";
  if (card.linkedTasks.some((task) => task.state === "waiting")) return "Input needed";
  return card.workflowState === "attention" ? "Needs attention" : undefined;
}

function workflowStageLabel(stage: WorkflowStage): string {
  return PIPELINE_STAGES.find(([value]) => value === stage)?.[1] ?? humanize(stage);
}

function workPrompt(card: CardViewProps, locale: string): string {
  const lines = [
    "Work on this Dyna item using the retained context below. Verify current source and task state before taking consequential action.",
    "",
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
    lines.push(
      "",
      "Immediate next steps:",
      ...card.nextSteps.map(
        (step, index) =>
          `${String(index + 1)}. ${step.label}${step.owner ? ` — ${step.owner}` : ""}${step.dueAt ? ` — due ${exactDateTime(step.dueAt, locale)}` : ""}`,
      ),
    );
  }
  if (card.plan.length > 0) lines.push("", "Plan:", ...card.plan.map((step) => `- ${step}`));
  if (card.outcome) lines.push("", `Recorded outcome: ${card.outcome}`);
  if (card.annotationPreview.length > 0) {
    lines.push(
      "",
      "Recent notes:",
      ...card.annotationPreview.map(
        (note) => `- ${exactDateTime(note.createdAt, locale)} — ${note.body}`,
      ),
    );
  }
  return lines.join("\n");
}

function cardIsBlocked(card: Pick<DynaCard, "linkedTasks">): boolean {
  return card.linkedTasks.some((task) => task.state === "failed" || task.state === "unknown");
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

function cardActions(card: DynaCard): readonly ActionDescriptor[] {
  const linkedTask = card.linkedTasks[0];
  const sourceActions =
    card.source === "manual" ? [] : [{ name: "open_source" as const, label: "Open source" }];
  return linkedTask
    ? [
        {
          name: "open_codex_task",
          label: card.linkedTasks.some((task) => task.state === "waiting")
            ? "Respond in Codex"
            : "Open Codex",
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

function cardViewProps(card: DynaCard): CardViewProps {
  const { id, annotations, linkedTasks, ...props } = card;
  const workflowCondition = cardWorkflowCondition(card);
  const sourceUrl = dynaSourceUrl(card.sourceRef);
  void linkedTasks;
  return {
    ...props,
    itemId: id,
    searchText: cardSearchText(card),
    annotationPreview: annotations.slice(0, 3).map((annotation) => ({
      body: annotation.body,
      createdAt: annotation.createdAt,
    })),
    actions: cardActions(card),
    workflowStage: cardWorkflowStage(card),
    ...(workflowCondition ? { workflowCondition } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}

function CardView({ card }: { readonly card: DynaCard }) {
  const PriorityCard = dynaComponents.PriorityCard;
  const TaskStatus = dynaComponents.TaskStatus;
  return (
    <PriorityCard props={cardViewProps(card)}>
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
          <CardView key={card.id} card={card} />
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
                }}
              >
                {grouped.map((card) => (
                  <CardView key={card.id} card={card} />
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
      {controller.view !== "archive" ? (
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
      <QueueView props={{}}>{queueContent}</QueueView>
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
                <CardView key={card.id} card={card} />
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
                <CardView key={card.id} card={card} />
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
  const [selectedItemId, setSelectedItemId] = useState<string>();
  const [busy, setBusy] = useState(false);
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
  const annotationTrigger = useRef<HTMLElement | null>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  const todoTrigger = useRef<HTMLElement | null>(null);
  const archiveTrigger = useRef<HTMLElement | null>(null);
  const restoreTrigger = useRef<HTMLElement | null>(null);
  const expansionTrigger = useRef<HTMLElement | null>(null);
  const actionTrigger = useRef<{ readonly element: HTMLElement; readonly key: string } | null>(
    null,
  );
  const annotationFocusAfterSave = useRef<string | undefined>(undefined);
  const dialog = useRef<HTMLDivElement | null>(null);
  current.current = payload;
  queryRef.current = query;
  selectedItemRef.current = selectedItemId;
  viewRef.current = view;
  const backgroundLocked =
    annotationItem !== undefined ||
    todoOpen ||
    archiveTarget !== undefined ||
    restoreTarget !== undefined ||
    (selectedItemId !== undefined && !wideLayout);

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
    setPayload(parsed.data);
    setConnectionError(undefined);
    return true;
  }, []);

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
        if (
          generation !== refreshGeneration.current ||
          requestedQuery !== queryRef.current.trim()
        ) {
          return;
        }
        const next = metadataPayload(result);
        if (next && !acceptPayload(next)) throw new Error("Snapshot identity validation failed.");
        if (!next) setConnectionError(undefined);
      } catch {
        if (generation === refreshGeneration.current) {
          setConnectionError(
            "Dashboard updates are disconnected. Actions are paused until the Remote host reconnects.",
          );
        }
      } finally {
        if (generation === refreshGeneration.current) refreshInFlight.current = false;
      }
    },
    [acceptPayload, app],
  );

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
  }, [busy, payload]);

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

  const setQuery = useCallback((value: string) => {
    setQueryState(value);
  }, []);

  const setPriorityFilter = useCallback((value: PriorityFilter) => {
    setPriorityFilterState(value);
  }, []);

  const setSourceFilter = useCallback((value: string) => {
    setSourceFilterState(value);
  }, []);

  const setWorkflowFilter = useCallback((value: WorkflowFilter) => {
    setWorkflowFilterState(value);
  }, []);

  const setLeadershipOnly = useCallback((value: boolean) => {
    setLeadershipOnlyState(value);
  }, []);

  const clearFilters = useCallback(() => {
    setPriorityFilterState("all");
    setSourceFilterState("all");
    setWorkflowFilterState("all");
    setLeadershipOnlyState(false);
  }, []);

  const prepareScrollTransition = useCallback((nextView: DashboardView) => {
    scrollPositions.current.set(viewRef.current, window.scrollY);
    pendingScrollPosition.current = scrollPositions.current.get(nextView) ?? 0;
  }, []);

  const setView = useCallback(
    (value: DashboardView) => {
      if (value !== viewRef.current) {
        prepareScrollTransition(value);
        viewRef.current = value;
        setViewState(value);
      }
      setSelectedItemId(undefined);
    },
    [prepareScrollTransition],
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
    if (!annotationItem && !todoOpen && !archiveTarget && !restoreTarget) return;
    const modal = dialog.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (annotationItem) closeAnnotation();
        else if (archiveTarget) closeArchive();
        else if (restoreTarget) closeRestore();
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
    closeRestore,
    closeTodo,
    restoreTarget,
    todoOpen,
  ]);

  const controller = useMemo<DynaUiController>(
    () => ({
      busy,
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
        restoreTarget !== undefined,
      canExpand,
      condenseInline: displayMode === "inline" && (canExpand || initialExpansionPending),
      initialExpansionPending,
      inlineCardLimit: desktopInlineLayout ? 5 : 4,
      locale,
      leadershipOnly,
      priorityFilter,
      query,
      serverQuery: payload?.snapshot.query ?? "",
      selectedItemId,
      sourceFilter,
      workflowFilter,
      externalLinks: Boolean(hostCapabilities?.openLinks),
      view,
      clearFilters,
      setLeadershipOnly,
      setPriorityFilter,
      setQuery,
      setSourceFilter,
      setWorkflowFilter,
      setView,
      openExternal,
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
        const active = current.current;
        if (!active || busy || connectionError) return;
        if (!hostCapabilitiesRef.current.serverTools) {
          setOperationError("This host does not support dashboard actions.");
          return;
        }
        if (!hostCapabilitiesRef.current.message?.text) {
          setOperationError("This host cannot send Dyna actions to Codex.");
          return;
        }
        if (trigger) {
          actionTrigger.current = {
            element: trigger,
            key: trigger.getAttribute("data-dyna-action") ?? `${itemId}:${kind}`,
          };
        }
        setOperationError(undefined);
        setBusy(true);
        const actionKey = [
          active.snapshot.dashboard.id,
          active.snapshot.revision,
          itemId,
          fingerprint,
          kind,
          taskId ?? "",
          taskHostId ?? "",
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
          const deliveryState = (
            delivery.structuredContent as Record<string, unknown> | undefined
          )?.["state"];
          if (
            ["claimed", "succeeded", "failed", "needs_reconciliation"].includes(
              String(deliveryState),
            )
          ) {
            if (deliveryState !== "claimed") pendingActions.current.delete(actionKey);
            setToast(
              deliveryState === "claimed"
                ? "Codex is handling this request."
                : deliveryState === "needs_reconciliation"
                  ? "Review required before another task-creation attempt."
                  : `This request is already ${String(deliveryState).replaceAll("_", " ")}.`,
            );
            return;
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
            const status = await app.callServerTool({
              name: "dyna_action_status",
              arguments: { viewToken: active.viewToken, requestId },
            });
            if (toolResultFailed(status)) throw new Error("Action status check failed.");
            const state = (status.structuredContent as Record<string, unknown> | undefined)?.[
              "state"
            ];
            if (state === "delivered") {
              const retried = await send();
              if (retried.isError) throw new Error("Action delivery remains uncertain.");
            } else if (state === "claimed" || state === "succeeded") {
              if (state === "succeeded") pendingActions.current.delete(actionKey);
              setToast("Codex is handling this request.");
              return;
            } else if (state === "failed" || state === "needs_reconciliation") {
              pendingActions.current.delete(actionKey);
              setToast(
                state === "needs_reconciliation"
                  ? "Review required before another task-creation attempt."
                  : "The request failed. Try again.",
              );
              return;
            } else {
              throw new Error("The action request could not be reconciled.");
            }
          }
          setToast("Request sent to Codex.");
          pendingActions.current.delete(actionKey);
          setConnectionError(undefined);
        } catch {
          setOperationError(
            preparationComplete
              ? "Action delivery is uncertain. Reconnect, then retry; Dyna will reuse the same request."
              : "Request was not sent. Refresh the dashboard and try again.",
          );
        } finally {
          setBusy(false);
        }
      },
    }),
    [
      app,
      annotationItem,
      archiveTarget,
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
      restoreTarget,
      selectedItemId,
      setLeadershipOnly,
      setPriorityFilter,
      setSourceFilter,
      setWorkflowFilter,
      sourceFilter,
      workflowFilter,
      closeDetails,
      executeArchive,
      executeRestore,
      openDetails,
      openExternal,
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
  if (initialExpansionPending) {
    return (
      <main className="dyna dyna-launching" data-display-mode={displayMode}>
        <header className="dyna-header">
          <div className="dyna-title-row">
            <div className="dyna-heading">
              <h1>{payload.snapshot.dashboard.name}</h1>
            </div>
          </div>
        </header>
        <div className="dyna-empty-wrap">
          <div className="dyna-empty" role="status">
            <strong>Opening expanded dashboard</strong>
            <p>Requesting Codex&apos;s expanded app surface…</p>
          </div>
        </div>
      </main>
    );
  }
  const routeDetailsOpen = Boolean(selectedItemId) && !wideLayout;
  const dashboardUnavailable =
    annotationItem !== undefined ||
    todoOpen ||
    archiveTarget !== undefined ||
    restoreTarget !== undefined ||
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

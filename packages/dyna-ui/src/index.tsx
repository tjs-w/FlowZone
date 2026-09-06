import "./styles.css";

import { Alert } from "@openai/apps-sdk-ui/components/Alert";
import { Badge } from "@openai/apps-sdk-ui/components/Badge";
import { Button } from "@openai/apps-sdk-ui/components/Button";
import {
  ArrowLeft,
  ChevronRight,
  ExternalLink,
  Plus,
  Search,
  X,
} from "@openai/apps-sdk-ui/components/Icon";
import { Input } from "@openai/apps-sdk-ui/components/Input";
import { Textarea } from "@openai/apps-sdk-ui/components/Textarea";
import { applyDocumentTheme } from "@openai/apps-sdk-ui/theme";
import { App, type AppEventMap, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { DynaUiPayloadSchema, type DynaUiPayload } from "@flowzone/dyna-contracts";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";

type ActionName =
  "annotate" | "open_source" | "create_codex_task" | "open_codex_task" | "refresh_codex_status";

type TodoPriority = "critical" | "high" | "normal" | "low";

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
  readonly displayMode: "inline" | "fullscreen" | "pip";
  readonly inspectorPresentation: "route" | "split";
  readonly modalOpen: boolean;
  readonly canExpand: boolean;
  readonly condenseInline: boolean;
  readonly initialExpansionPending: boolean;
  readonly locale: string;
  readonly query: string;
  readonly selectedItemId: string | undefined;
  readonly serverQuery: string;
  readonly pipelineState: "todo" | "executing" | "paused" | "attention" | "completed";
  readonly view: "queue" | "pipeline";
  setQuery(value: string): void;
  setPipelineState(value: "todo" | "executing" | "paused" | "attention" | "completed"): void;
  setView(value: "queue" | "pipeline"): void;
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

function InspectorShell({
  labelledBy,
  onClose,
  children,
}: {
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
    if (routePresentation) {
      const previousOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = previousOverflow;
      };
    }
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
type DynaTask = DynaCard["linkedTasks"][number];

interface ActionDescriptor {
  readonly name: ActionName;
  readonly label: string;
  readonly taskId?: string;
  readonly taskHostId?: string;
}

type CardViewProps = Omit<DynaCard, "id" | "annotations" | "linkedTasks"> & {
  readonly itemId: string;
  readonly searchText: string;
  readonly annotationCount: number;
  readonly annotationPreview: readonly string[];
  readonly actions: readonly ActionDescriptor[];
};

interface ComponentArgs<Props> {
  readonly props: Props;
  readonly children?: ReactNode;
}

interface FixedComponents {
  readonly Dashboard: (
    args: ComponentArgs<{
      readonly dashboardId: string;
      readonly name: string;
      readonly description: string;
      readonly freshness: DynaSnapshot["freshness"];
      readonly generatedAt: string;
      readonly revision: number;
    }>,
  ) => ReactNode;
  readonly SummaryStrip: (
    args: ComponentArgs<{
      readonly focus: number;
      readonly leadership: number;
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
    }>,
  ) => ReactNode;
  readonly QueueView: (args: ComponentArgs<Record<string, never>>) => ReactNode;
  readonly PipelineView: (
    args: ComponentArgs<{
      readonly stages: readonly {
        readonly state: DynaCard["workflowState"];
        readonly title: string;
        readonly count: number;
      }[];
    }>,
  ) => ReactNode;
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

const fixedComponents: FixedComponents = {
  Dashboard: ({ props, children }) => {
    const controller = useController();
    const health = controller.blocked
      ? { color: "danger" as const, label: "Offline" }
      : props.freshness === "fresh"
        ? { color: "success" as const, label: "Live" }
        : { color: "warning" as const, label: "Delayed" };
    return (
      <main
        className="dyna"
        data-display-mode={controller.displayMode}
        data-dashboard-view={controller.view}
        data-has-selection={Boolean(controller.selectedItemId)}
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
                  if (!["ArrowRight", "End"].includes(event.key)) return;
                  event.preventDefault();
                  controller.setView("pipeline");
                  document.getElementById("dyna-tab-pipeline")?.focus();
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
                  if (!["ArrowLeft", "Home"].includes(event.key)) return;
                  event.preventDefault();
                  controller.setView("queue");
                  document.getElementById("dyna-tab-queue")?.focus();
                }}
              >
                Pipeline
              </button>
            </div>
            <div className="dyna-search">
              <Search className="dyna-search-icon" aria-hidden="true" />
              <Input
                className="dyna-search-control"
                aria-label="Search dashboard"
                type="search"
                size="lg"
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
    const settled = controller.query.trim() === controller.serverQuery;
    return (
      <>
        <section
          className="dyna-summary"
          data-condensed={controller.condenseInline}
          aria-label="Dashboard summary"
        >
          <div className="dyna-stat">
            <strong>{props.focus}</strong>
            <span>need attention</span>
          </div>
          <div className="dyna-stat">
            <strong>{props.leadership}</strong>
            <span>leadership</span>
          </div>
          <div className="dyna-stat">
            <strong>
              {props.shown < props.total ? `${props.shown}/${props.total}` : props.total}
            </strong>
            <span>{props.shown < props.total ? "shown" : "total"}</span>
          </div>
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
    if (props.title === "Signal runs") {
      if (controller.condenseInline && !props.attention) return null;
      return (
        <details
          className="dyna-source-health"
          data-attention={Boolean(props.attention)}
          open={props.attention ? true : undefined}
        >
          <summary>
            <ChevronRight className="dyna-disclosure" aria-hidden="true" />
            {props.attention ? "Source health needs attention" : "Source health"}
            <span className="dyna-meta">
              {props.count} {props.count === 1 ? "run" : "runs"}
            </span>
          </summary>
          <div className="dyna-source-list">{children}</div>
        </details>
      );
    }
    return (
      <section className="dyna-section">
        <header className="dyna-section-header">
          <h2>{props.title}</h2>
          <span className="dyna-section-count">{props.count}</span>
        </header>
        {children}
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
        aria-label={controller.condenseInline ? "Top attention" : undefined}
        aria-labelledby={controller.condenseInline ? undefined : "dyna-tab-queue"}
      >
        {children}
      </div>
    ) : null;
  },
  PipelineView: ({ props, children }) => {
    const controller = useController();
    const active = props.stages.find((stage) => stage.state === controller.pipelineState);
    return controller.view === "pipeline" && active ? (
      <div
        id="dyna-panel-pipeline"
        className="dyna-pipeline dyna-view"
        role="tabpanel"
        aria-labelledby="dyna-tab-pipeline"
      >
        <div className="dyna-stage-rail" role="tablist" aria-label="Pipeline stage">
          {props.stages.map((stage, index) => {
            const selected = stage.state === controller.pipelineState;
            const shortTitle = {
              todo: "To do",
              executing: "Doing",
              paused: "Input",
              attention: "Review",
              completed: "Done",
            }[stage.state];
            return (
              <button
                key={stage.state}
                id={`dyna-stage-tab-${stage.state}`}
                type="button"
                className="dyna-stage-tab"
                data-workflow-state={stage.state}
                role="tab"
                aria-label={`${stage.title}: ${stage.count}`}
                aria-selected={selected}
                aria-controls={`dyna-stage-${stage.state}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => {
                  controller.setPipelineState(stage.state);
                }}
                onKeyDown={(event) => {
                  const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                  const edge =
                    event.key === "Home" ? 0 : event.key === "End" ? props.stages.length - 1 : -1;
                  if (delta === 0 && edge < 0) return;
                  event.preventDefault();
                  const nextIndex =
                    edge >= 0 ? edge : (index + delta + props.stages.length) % props.stages.length;
                  const next = props.stages[nextIndex];
                  if (!next) return;
                  controller.setPipelineState(next.state);
                  document.getElementById(`dyna-stage-tab-${next.state}`)?.focus();
                }}
              >
                <strong>{stage.count}</strong>
                <span>{shortTitle}</span>
              </button>
            );
          })}
        </div>
        <div
          id={`dyna-stage-${active.state}`}
          className="dyna-pipeline-items"
          role="tabpanel"
          aria-labelledby={`dyna-stage-tab-${active.state}`}
          tabIndex={0}
        >
          {active.count > 0 ? (
            children
          ) : (
            <p className="dyna-pipeline-empty">Nothing in {active.title.toLowerCase()}.</p>
          )}
        </div>
      </div>
    ) : null;
  },
  PriorityCard: ({ props, children }) => {
    const controller = useController();
    const menuTrigger = useRef<HTMLElement | null>(null);
    const presentation = controller.view;
    const selected = controller.selectedItemId === props.itemId;
    const inspectorTitleId = `dyna-inspector-title-${props.itemId}`;
    const lead = props.people[0];
    const detailLabel = `Open details for ${props.title}`;
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
        data-selected={selected}
      >
        <div className="dyna-card-row">
          <button
            type="button"
            className="dyna-row-main"
            data-dyna-details-item={props.itemId}
            aria-label={detailLabel}
            aria-expanded={selected}
            aria-controls={selected ? inspectorTitleId : undefined}
            onClick={(event) => {
              void controller.openDetails(props.itemId, event.currentTarget);
            }}
          >
            <span className="dyna-row-top">
              <span className="dyna-priority-label">{props.priority}</span>
              <span aria-hidden="true">·</span>
              <span className="dyna-source-mark">{props.sourceLabel}</span>
              <span className="dyna-row-time" data-has-deadline={Boolean(props.dueAt)}>
                {props.dueAt
                  ? `Due ${relativeTime(props.dueAt, controller.locale)}`
                  : `Updated ${relativeTime(props.sourceUpdatedAt, controller.locale)}`}
              </span>
            </span>
            <span className="dyna-row-title">{props.title}</span>
            <span className="dyna-row-foot">
              <span className="dyna-row-attention">{props.attention ?? props.priorityReason}</span>
              {lead ? (
                <span
                  className="dyna-row-person"
                  title={lead.title ?? humanize(lead.leadershipLevel)}
                >
                  {lead.displayName}
                </span>
              ) : null}
              <ChevronRight className="dyna-row-chevron" aria-hidden="true" />
            </span>
          </button>
        </div>
        {selected ? (
          <InspectorShell
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
                  <span>{props.sourceLabel}</span>
                  <span>{humanize(props.workflowState)}</span>
                  {props.dueAt ? (
                    <span>Due {relativeTime(props.dueAt, controller.locale)}</span>
                  ) : null}
                </div>
                <h2 id={inspectorTitleId}>{props.title}</h2>
              </div>
            </div>
            <div className="dyna-inspector-scroll" data-priority={props.priority}>
              <div className="dyna-attention">
                <span>
                  {props.dueAt
                    ? `Decision due ${relativeTime(props.dueAt, controller.locale)}`
                    : "Decision"}
                </span>
                <p>{props.attention ?? props.priorityReason}</p>
              </div>
              <p className="dyna-inspector-summary">{props.summary}</p>
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
                  <h3>Immediate next steps</h3>
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
              {props.outcome ? (
                <div className="dyna-outcome">
                  <span>Outcome</span>
                  <p>{props.outcome}</p>
                </div>
              ) : null}
              {props.actions.some((action) => action.name === "open_codex_task") ? (
                <section className="dyna-inspector-section">
                  <h3>Codex tasks</h3>
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
                          ? `Raised from ${props.sourcePriority} by verified leadership context`
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
                    <strong>Originating record</strong>
                    <code>{sourceReferenceLabel(props.sourceRef)}</code>
                    <span className="dyna-meta">
                      Updated {relativeTime(props.sourceUpdatedAt, controller.locale)}
                    </span>
                  </div>
                </div>
              </details>
              {props.annotationPreview.length > 0 ? (
                <section className="dyna-inspector-section">
                  <h3>Recent notes</h3>
                  <ul className="dyna-note-list" aria-label="Recent notes">
                    {props.annotationPreview.map((note, index) => (
                      <li key={`${index}-${note}`}>{note}</li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
            <div className="dyna-inspector-footer">
              <div className="dyna-actions">
                {props.actions.map((action) => (
                  <Button
                    key={action.name}
                    data-dyna-action={`${props.itemId}:${action.name}`}
                    data-dyna-annotation-item={
                      action.name === "annotate" ? props.itemId : undefined
                    }
                    color={
                      action.name === "create_codex_task" || action.name === "open_codex_task"
                        ? "primary"
                        : "secondary"
                    }
                    size="sm"
                    variant={
                      action.name === "create_codex_task" || action.name === "open_codex_task"
                        ? "solid"
                        : action.name === "annotate"
                          ? "ghost"
                          : "outline"
                    }
                    onClick={(event) => {
                      if (action.name === "annotate") {
                        controller.annotate(props.itemId, event.currentTarget);
                      } else
                        void controller.request(
                          props.itemId,
                          props.fingerprint,
                          action.name,
                          action.taskId,
                          action.taskHostId,
                          event.currentTarget,
                        );
                    }}
                    disabled={controller.busy || controller.blocked}
                  >
                    {action.name === "open_source" || action.name === "open_codex_task" ? (
                      <ExternalLink className="dyna-icon" aria-hidden="true" />
                    ) : action.name === "create_codex_task" ? (
                      <Plus className="dyna-icon" aria-hidden="true" />
                    ) : null}
                    {action.label}
                  </Button>
                ))}
                {props.annotationCount > 0 ? (
                  <span className="dyna-meta">
                    {props.annotationCount} note{props.annotationCount === 1 ? "" : "s"}
                  </span>
                ) : null}
                {presentation === "pipeline" && props.workflowState === "completed" ? (
                  <Button
                    color="secondary"
                    size="sm"
                    variant="outline"
                    onClick={(event) => {
                      controller.startTodo(
                        event.currentTarget,
                        `Follow up: ${props.title}`,
                        `Continue from completed work: ${props.outcome ?? props.summary}`,
                        props.itemId,
                      );
                    }}
                    disabled={controller.busy || controller.blocked}
                  >
                    Create follow-up
                  </Button>
                ) : null}
              </div>
              {props.workflowState !== "completed" ? (
                <details className="dyna-overflow">
                  <summary
                    ref={menuTrigger}
                    className="dyna-more-trigger"
                    aria-label={`Manage priority and order for ${props.title}`}
                    aria-disabled={controller.busy || controller.blocked}
                    onClick={(event) => {
                      if (controller.busy || controller.blocked) event.preventDefault();
                    }}
                  >
                    Priority &amp; order
                  </summary>
                  <div className="dyna-overflow-menu" aria-label="Priority and order actions">
                    <button
                      type="button"
                      disabled={props.priority === "critical"}
                      onClick={(event) => {
                        event.currentTarget.closest("details")?.removeAttribute("open");
                        if (menuTrigger.current) {
                          void controller.organize(
                            props.itemId,
                            props.fingerprint,
                            "bump",
                            menuTrigger.current,
                          );
                        }
                      }}
                    >
                      Raise priority
                    </button>
                    <button
                      type="button"
                      disabled={props.priority === "low"}
                      onClick={(event) => {
                        event.currentTarget.closest("details")?.removeAttribute("open");
                        if (menuTrigger.current) {
                          void controller.organize(
                            props.itemId,
                            props.fingerprint,
                            "lower",
                            menuTrigger.current,
                          );
                        }
                      }}
                    >
                      Lower priority
                    </button>
                    <div className="dyna-overflow-separator" role="separator" />
                    <button
                      type="button"
                      disabled={!props.canMoveEarlier}
                      onClick={(event) => {
                        event.currentTarget.closest("details")?.removeAttribute("open");
                        if (menuTrigger.current) {
                          void controller.organize(
                            props.itemId,
                            props.fingerprint,
                            "earlier",
                            menuTrigger.current,
                          );
                        }
                      }}
                    >
                      Move earlier in group
                    </button>
                    <button
                      type="button"
                      disabled={!props.canMoveLater}
                      onClick={(event) => {
                        event.currentTarget.closest("details")?.removeAttribute("open");
                        if (menuTrigger.current) {
                          void controller.organize(
                            props.itemId,
                            props.fingerprint,
                            "later",
                            menuTrigger.current,
                          );
                        }
                      }}
                    >
                      Move later in group
                    </button>
                  </div>
                </details>
              ) : null}
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
            disabled={controller.busy || controller.blocked}
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
            disabled={controller.busy || controller.blocked}
          >
            Refresh
          </Button>
        </div>
      </div>
    );
  },
  ScheduleStatus: ({ props }) => {
    const controller = useController();
    return (
      <div className="dyna-schedule">
        <strong>{props.scheduleTitle ?? props.name}</strong>
        <Badge
          color={
            props.lastRunStatus === "failed"
              ? "danger"
              : props.lastRunStatus === "partial"
                ? "warning"
                : props.lastRunStatus === "succeeded"
                  ? "success"
                  : "secondary"
          }
          variant="soft"
        >
          {props.lastRunStatus}
        </Badge>
        <span className="dyna-meta">
          {props.scheduleState}
          {props.lastRunAt
            ? ` · last run ${relativeTime(props.lastRunAt, controller.locale)}`
            : " · not run yet"}
        </span>
        {props.lastRunError ? <span className="dyna-meta">{props.lastRunError}</span> : null}
      </div>
    );
  },
  EmptyState: ({ props }) => {
    const controller = useController();
    return (
      <div className="dyna-empty-wrap">
        <div className="dyna-empty">
          <strong>{controller.query ? "Nothing matched" : "Queue is clear"}</strong>
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
  ["critical", "Act now"],
  ["high", "Needs your attention"],
  ["normal", "Keep moving"],
  ["low", "On the radar"],
] as const;

const PIPELINE_STAGES = [
  ["todo", "To do"],
  ["executing", "Executing in Codex"],
  ["paused", "Paused for input"],
  ["attention", "Needs attention"],
  ["completed", "Completed"],
] as const;

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
  return linkedTask
    ? [
        { name: "open_source", label: "Open source" },
        {
          name: "open_codex_task",
          label: "Open Codex",
          taskId: linkedTask.taskId,
          taskHostId: linkedTask.hostId,
        },
        { name: "annotate", label: "Add note" },
      ]
    : [
        { name: "open_source", label: "Open source" },
        { name: "annotate", label: "Add note" },
        { name: "create_codex_task", label: "Review in Codex" },
      ];
}

function cardSearchText(card: DynaCard): string {
  return [
    card.title,
    card.summary,
    card.sourceLabel,
    card.priority,
    card.priorityReason,
    card.attention ?? "",
    card.outcome ?? "",
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
  ]
    .join(" ")
    .slice(0, 10_000);
}

function cardMatches(card: DynaCard, query: string, locale: string): boolean {
  const terms = query.trim().toLocaleLowerCase(locale).split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return true;
  const searchable = cardSearchText(card).toLocaleLowerCase(locale);
  return terms.every((term) => searchable.includes(term));
}

function cardViewProps(card: DynaCard): CardViewProps {
  const { id, annotations, linkedTasks, ...props } = card;
  void linkedTasks;
  return {
    ...props,
    itemId: id,
    searchText: cardSearchText(card),
    annotationCount: annotations.length,
    annotationPreview: annotations.slice(0, 3).map((annotation) => annotation.body),
    actions: cardActions(card),
  };
}

function CardView({ card }: { readonly card: DynaCard }) {
  const PriorityCard = fixedComponents.PriorityCard;
  const TaskStatus = fixedComponents.TaskStatus;
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
  const Dashboard = fixedComponents.Dashboard;
  const SummaryStrip = fixedComponents.SummaryStrip;
  const Section = fixedComponents.Section;
  const QueueView = fixedComponents.QueueView;
  const PipelineView = fixedComponents.PipelineView;
  const ScheduleStatus = fixedComponents.ScheduleStatus;
  const EmptyState = fixedComponents.EmptyState;
  const compactInline = controller.condenseInline;
  const cards = [...snapshot.cards]
    .filter((card) => cardMatches(card, controller.query, controller.locale))
    .sort(compareCards);
  const queueCards = cards.filter((card) => card.workflowState !== "completed");
  const selectedCard = cards.find((card) => card.id === controller.selectedItemId);
  const inlineCards = selectedCard
    ? [selectedCard, ...queueCards.filter((card) => card.id !== selectedCard.id)].slice(0, 3)
    : queueCards.slice(0, 3);
  const unhealthySchedules = snapshot.schedules.filter(
    (schedule) =>
      schedule.lastRunStatus === "failed" ||
      schedule.lastRunStatus === "partial" ||
      schedule.scheduleState !== "active",
  );
  const stages = PIPELINE_STAGES.map(([state, title]) => ({
    state,
    title,
    count: cards.filter((card) => card.workflowState === state).length,
  }));
  const activePipelineCards = cards.filter(
    (card) => card.workflowState === controller.pipelineState,
  );

  const queueContent = compactInline ? (
    queueCards.length > 0 || selectedCard ? (
      <Section
        props={{
          title: "Top attention",
          emptyMessage: "No active work needs attention.",
          count: queueCards.length,
        }}
      >
        {inlineCards.map((card) => (
          <CardView key={card.id} card={card} />
        ))}
        {queueCards.length > 3 ? (
          <p className="dyna-inline-more">{queueCards.length - 3} more in the full dashboard</p>
        ) : null}
      </Section>
    ) : (
      <EmptyState props={{ message: "No active work needs attention." }} />
    )
  ) : (
    <>
      {PRIORITY_GROUPS.map(([priority, title]) => {
        const grouped = queueCards.filter((card) => card.priority === priority);
        return grouped.length > 0 ? (
          <Section
            key={priority}
            props={{ title, emptyMessage: "Nothing in this group.", count: grouped.length }}
          >
            {grouped.map((card) => (
              <CardView key={card.id} card={card} />
            ))}
          </Section>
        ) : null;
      })}
      {queueCards.length === 0 ? (
        <EmptyState
          props={{
            message:
              controller.query && cards.length === 0
                ? `No dashboard items match “${controller.query}”.`
                : cards.length > 0
                  ? "Matching completed work is available in the Pipeline."
                  : "No signals have been published to this dashboard yet.",
          }}
        />
      ) : null}
      {snapshot.schedules.length > 0 ? (
        <Section
          props={{
            title: "Signal runs",
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
      }}
    >
      <SummaryStrip
        props={{
          focus: snapshot.counts.critical + snapshot.counts.high,
          leadership: snapshot.counts.leadership,
          shown: cards.length,
          total: snapshot.counts.total,
        }}
      />
      {compactInline && unhealthySchedules.length > 0 ? (
        <Alert
          className="dyna-source-alert"
          color="warning"
          variant="soft"
          title="Source refresh needs attention"
          description={`${unhealthySchedules.length} ${unhealthySchedules.length === 1 ? "source is" : "sources are"} delayed or unavailable.`}
        />
      ) : null}
      <QueueView props={{}}>{queueContent}</QueueView>
      {!compactInline ? (
        <PipelineView props={{ stages }}>
          {activePipelineCards.map((card) => (
            <CardView key={card.id} card={card} />
          ))}
        </PipelineView>
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
  const [view, setViewState] = useState<"queue" | "pipeline">("queue");
  const [query, setQueryState] = useState("");
  const [pipelineState, setPipelineStateState] = useState<
    "todo" | "executing" | "paused" | "attention" | "completed"
  >("attention");
  const [selectedItemId, setSelectedItemId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string>();
  const [connectionError, setConnectionError] = useState<string>();
  const [operationError, setOperationError] = useState<string>();
  const [displayMode, setDisplayMode] = useState<"inline" | "fullscreen" | "pip">("inline");
  const [wideLayout, setWideLayout] = useState(() => window.innerWidth >= 980);
  const [canExpand, setCanExpand] = useState(false);
  const [initialExpansionPending, setInitialExpansionPending] = useState(true);
  const [locale, setLocale] = useState(navigator.language);
  const current = useRef<DynaUiPayload | undefined>(undefined);
  const refreshInFlight = useRef(false);
  const refreshGeneration = useRef(0);
  const queryRef = useRef("");
  const selectedItemRef = useRef<string | undefined>(undefined);
  const detailScrollPosition = useRef(0);
  const todoRequestId = useRef(crypto.randomUUID());
  const createdTodoFocus = useRef<string | undefined>(undefined);
  const hostContext = useRef<DynaHostContext>({});
  const pendingActions = useRef(
    new Map<string, { readonly requestId: string; readonly idempotencyKey: string }>(),
  );
  const annotationTrigger = useRef<HTMLElement | null>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  const todoTrigger = useRef<HTMLElement | null>(null);
  const expansionTrigger = useRef<HTMLElement | null>(null);
  const actionTrigger = useRef<{ readonly element: HTMLElement; readonly key: string } | null>(
    null,
  );
  const annotationFocusAfterSave = useRef<string | undefined>(undefined);
  const dialog = useRef<HTMLDivElement | null>(null);
  current.current = payload;
  queryRef.current = query;
  selectedItemRef.current = selectedItemId;

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

  const refresh = useCallback(
    async (force = false) => {
      const active = current.current;
      if (!active || document.hidden || (!force && refreshInFlight.current)) return;
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
  }, [query, refresh]);

  const requestExpandedPresentation = useCallback(async (): Promise<boolean> => {
    const result = await app.requestDisplayMode({ mode: "fullscreen" });
    hostContext.current = { ...hostContext.current, displayMode: result.mode };
    setDisplayMode(result.mode);
    return result.mode === "fullscreen";
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
    const onResize = () => {
      setWideLayout(window.innerWidth >= 980);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
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
      rootData.touch = String(context.deviceCapabilities?.touch ?? false);
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
      .then(() => {
        const context = app.getHostContext();
        if (context) applyContext(context);
        setConnectionError(undefined);
        setInitialExpansionPending(false);
      })
      .catch(() => {
        setInitialExpansionPending(false);
        setConnectionError(
          "Could not connect to the Remote host. Dashboard actions are unavailable.",
        );
      });
    return () => {
      app.removeEventListener("hostcontextchanged", applyContext);
    };
  }, [app]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => {
      setToast(undefined);
    }, 4_000);
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
      setSelectedItemId(itemId);
    },
    [canExpand, displayMode, requestExpandedPresentation],
  );

  const setQuery = useCallback((value: string) => {
    setQueryState(value);
    setSelectedItemId(undefined);
  }, []);

  const setView = useCallback((value: "queue" | "pipeline") => {
    setViewState(value);
    setSelectedItemId(undefined);
  }, []);

  const setPipelineState = useCallback(
    (value: "todo" | "executing" | "paused" | "attention" | "completed") => {
      setPipelineStateState(value);
      setSelectedItemId(undefined);
    },
    [],
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
    if (!annotationItem && !todoOpen) return;
    const modal = dialog.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (annotationItem) closeAnnotation();
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
  }, [annotationItem, closeAnnotation, closeTodo, todoOpen]);

  const controller = useMemo<DynaUiController>(
    () => ({
      busy,
      blocked: Boolean(connectionError),
      displayMode,
      inspectorPresentation: displayMode === "fullscreen" && wideLayout ? "split" : "route",
      modalOpen: annotationItem !== undefined || todoOpen,
      canExpand,
      condenseInline: displayMode === "inline" && (canExpand || initialExpansionPending),
      initialExpansionPending,
      locale,
      query,
      serverQuery: payload?.snapshot.query ?? "",
      selectedItemId,
      pipelineState,
      view,
      setQuery,
      setPipelineState,
      setView,
      closeDetails,
      openDetails,
      annotate(itemId, trigger) {
        annotationTrigger.current = trigger;
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
        if (!active || busy || connectionError) return;
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
        try {
          let pending = pendingActions.current.get(actionKey);
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
            "Action delivery is uncertain. Reconnect, then retry; Dyna will reuse the same request.",
          );
        } finally {
          setBusy(false);
        }
      },
    }),
    [
      app,
      annotationItem,
      busy,
      canExpand,
      connectionError,
      displayMode,
      initialExpansionPending,
      locale,
      payload?.snapshot.query,
      requestExpandedPresentation,
      query,
      refresh,
      selectedItemId,
      pipelineState,
      closeDetails,
      openDetails,
      setQuery,
      setPipelineState,
      setView,
      view,
      wideLayout,
      todoOpen,
    ],
  );

  async function saveAnnotation(): Promise<void> {
    const active = current.current;
    if (!active || !annotationItem || !annotation.trim() || busy || connectionError) return;
    setOperationError(undefined);
    setBusy(true);
    try {
      const result = await app.callServerTool({
        name: "dyna_add_annotation",
        arguments: { viewToken: active.viewToken, itemId: annotationItem, body: annotation.trim() },
      });
      if (toolResultFailed(result)) throw new Error("Annotation save failed.");
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
    if (!active || !todoTitle.trim() || busy || connectionError) return;
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
  const routeDetailsOpen = Boolean(selectedItemId) && (displayMode !== "fullscreen" || !wideLayout);
  const dashboardUnavailable = annotationItem !== undefined || todoOpen || routeDetailsOpen;
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
          <div className="dyna-sheet">
            <div className="dyna-sheet-header">
              <h2 id="annotation-title">Add an executive note</h2>
            </div>
            <div className="dyna-sheet-body">
              <label htmlFor="dyna-annotation">Note</label>
              <Textarea
                id="dyna-annotation"
                className="dyna-field"
                size="lg"
                value={annotation}
                rows={4}
                maxLength={1_000}
                placeholder="Example: Create a new Codex task to review this MR"
                onChange={(event) => {
                  setAnnotation(event.currentTarget.value);
                }}
                autoFocus
              />
            </div>
            <div className="dyna-sheet-actions">
              <Button color="secondary" variant="ghost" onClick={closeAnnotation}>
                Cancel
              </Button>
              <Button
                color="primary"
                loading={busy}
                disabled={!annotation.trim() || Boolean(connectionError)}
                onClick={() => void saveAnnotation()}
              >
                Save note
              </Button>
            </div>
          </div>
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
              <h2 id="todo-title">Add to the priority queue</h2>
            </div>
            <div className="dyna-sheet-body">
              <label htmlFor="dyna-todo-title">To-do</label>
              <Input
                id="dyna-todo-title"
                className="dyna-field"
                type="text"
                size="xl"
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
      {toast ? (
        <div className="dyna-toast" role="status">
          {toast}
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

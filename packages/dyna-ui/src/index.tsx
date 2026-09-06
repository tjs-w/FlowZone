import "./styles.css";

import { Button } from "@openai/apps-sdk-ui/components/Button";
import { applyDocumentTheme } from "@openai/apps-sdk-ui/theme";
import { App, type AppEventMap, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { Renderer, JSONUIProvider, defineRegistry, type Spec } from "@json-render/react";
import { DynaUiPayloadSchema, dynaCatalog, type DynaUiPayload } from "@flowzone/dyna-contracts";
import {
  createContext,
  Children,
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
  openDetails(itemId: string, trigger: HTMLElement): void;
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
  const panel = useRef<HTMLElement | null>(null);
  const routePresentation = controller.displayMode !== "fullscreen";

  useEffect(() => {
    const inspector = panel.current;
    if (routePresentation) {
      inspector?.querySelector<HTMLElement>("[data-dyna-inspector-back]")?.focus();
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
      const focusable = [
        ...inspector.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
        ),
      ];
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
      <aside ref={panel} className="dyna-inspector" role="region" aria-labelledby={labelledBy}>
        {children}
      </aside>
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

const { registry } = defineRegistry(dynaCatalog, {
  components: {
    Dashboard: ({ props, children }) => {
      const controller = useController();
      const health = controller.blocked
        ? { color: "danger" as const, label: "Offline" }
        : props.freshness === "fresh"
          ? { color: "success" as const, label: "Live" }
          : { color: "warning" as const, label: "Delayed" };
      const pipelineAvailable = controller.displayMode === "fullscreen" || !controller.canExpand;
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
                <span className="dyna-chip" data-tone={health.color}>
                  {health.label}
                </span>
                {controller.displayMode !== "fullscreen" &&
                controller.canExpand &&
                !controller.initialExpansionPending ? (
                  <Button
                    color="secondary"
                    variant="outline"
                    size="sm"
                    data-dyna-expand="true"
                    loading={controller.busy}
                    disabled={controller.busy}
                    aria-label="Open full dashboard"
                    title="Open full dashboard"
                    onClick={(event) => void controller.expand(event.currentTarget)}
                  >
                    <span className="dyna-symbol" aria-hidden="true">
                      ↗
                    </span>
                    <span className="dyna-expand-label">Full dashboard</span>
                  </Button>
                ) : null}
              </div>
            </div>
            {props.description ? <p className="dyna-description">{props.description}</p> : null}
          </header>
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
                  if (!pipelineAvailable || !["ArrowRight", "End"].includes(event.key)) return;
                  event.preventDefault();
                  controller.setView("pipeline");
                  document.getElementById("dyna-tab-pipeline")?.focus();
                }}
              >
                Focus
              </button>
              {pipelineAvailable ? (
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
              ) : null}
            </div>
            <label className="dyna-search">
              <span className="dyna-visually-hidden">Search dashboard</span>
              <input
                className="dyna-search-control dyna-native-input"
                type="search"
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
                  <span className="dyna-symbol" aria-hidden="true">
                    ×
                  </span>
                </Button>
              ) : null}
            </label>
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
              <span className="dyna-symbol" aria-hidden="true">
                +
              </span>
              <span className="dyna-add-label">New to-do</span>
            </Button>
          </div>
          <div className="dyna-workspace">{children}</div>
        </main>
      );
    },
    SummaryStrip: ({ props }) => {
      const controller = useController();
      const settled = controller.query.trim() === controller.serverQuery;
      return (
        <>
          {!controller.condenseInline ? (
            <section className="dyna-summary" aria-label="Dashboard summary">
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
          ) : null}
          <div className="dyna-visually-hidden" role="status" aria-live="polite">
            {settled && controller.query.trim()
              ? props.total === 0
                ? "No matching items."
                : `${String(props.total)} matching ${props.total === 1 ? "item" : "items"}.`
              : ""}
          </div>
        </>
      );
    },
    Section: ({ props, children }) => {
      const controller = useController();
      const allChildren = Children.toArray(children);
      if (props.title === "Signal runs") {
        if (controller.condenseInline && !props.attention) return null;
        return (
          <details
            className="dyna-source-health"
            data-attention={Boolean(props.attention)}
            open={props.attention ? true : undefined}
          >
            <summary role="button">
              <span className="dyna-disclosure" aria-hidden="true">
                ›
              </span>
              {props.attention ? "Source health needs attention" : "Source health"}
              <span className="dyna-meta">
                {allChildren.length} {allChildren.length === 1 ? "run" : "runs"}
              </span>
            </summary>
            <div className="dyna-source-list">{allChildren}</div>
          </details>
        );
      }
      const visibleChildren =
        !controller.query &&
        !controller.selectedItemId &&
        controller.displayMode === "inline" &&
        controller.condenseInline
          ? allChildren.slice(0, 3)
          : allChildren;
      return (
        <section className="dyna-section">
          <header className="dyna-section-header">
            <h2>{props.title}</h2>
            <span className="dyna-section-count">{allChildren.length}</span>
          </header>
          {visibleChildren}
          {visibleChildren.length < allChildren.length ? (
            <p className="dyna-inline-more">
              Open the full dashboard to see {allChildren.length - visibleChildren.length} more.
            </p>
          ) : null}
        </section>
      );
    },
    QueueView: ({ children }) => {
      const controller = useController();
      return controller.view === "queue" ? (
        <div
          id="dyna-panel-queue"
          className="dyna-view"
          role="tabpanel"
          aria-labelledby="dyna-tab-queue"
        >
          {children}
        </div>
      ) : null;
    },
    PipelineView: ({ children }) => {
      const controller = useController();
      return controller.view === "pipeline" ? (
        <div
          id="dyna-panel-pipeline"
          className="dyna-pipeline dyna-view"
          role="tabpanel"
          aria-labelledby="dyna-tab-pipeline"
        >
          {children}
        </div>
      ) : null;
    },
    PipelineColumn: ({ props, children }) => {
      const controller = useController();
      const selected = controller.pipelineState === props.state;
      const shortTitle = {
        todo: "To do",
        executing: "Doing",
        paused: "Input",
        attention: "Review",
        completed: "Done",
      }[props.state];
      const panelId = `dyna-stage-${props.state}`;
      return (
        <section
          className="dyna-pipeline-column"
          data-workflow-state={props.state}
          data-active={selected}
        >
          <button
            type="button"
            className="dyna-stage-tab"
            role="tab"
            aria-label={`${props.title}: ${props.count}`}
            aria-selected={selected}
            aria-controls={panelId}
            onClick={() => {
              controller.setPipelineState(props.state);
            }}
          >
            <strong>{props.count}</strong>
            <span>{shortTitle}</span>
          </button>
          <div
            id={panelId}
            className="dyna-pipeline-items"
            role="tabpanel"
            aria-label={props.title}
            hidden={!selected}
          >
            {Children.count(children) > 0 ? (
              children
            ) : (
              <p className="dyna-pipeline-empty">Nothing in {props.title.toLowerCase()}.</p>
            )}
          </div>
        </section>
      );
    },
    PriorityCard: ({ props, children }) => {
      const controller = useController();
      const menuTrigger = useRef<HTMLElement | null>(null);
      const presentation = controller.view;
      const localQueryPending = controller.query.trim() !== controller.serverQuery;
      const queryTerms = localQueryPending
        ? controller.query.trim().toLocaleLowerCase(controller.locale).split(/\s+/u).filter(Boolean)
        : [];
      const searchable = [
        props.title,
        props.summary,
        props.sourceLabel,
        props.priority,
        props.priorityReason,
        props.attention ?? "",
        props.outcome ?? "",
        props.searchText,
        ...props.labels,
        ...props.plan,
        ...props.nextSteps.flatMap((step) => [step.label, step.owner ?? ""]),
        ...props.people.flatMap((person) => [
          person.displayName,
          person.title ?? "",
          person.leadershipLevel,
          person.involvement,
          person.relationship,
        ]),
      ]
        .join(" ")
        .toLocaleLowerCase(controller.locale);
      if (localQueryPending && queryTerms.some((term) => !searchable.includes(term))) return null;
      const selected = controller.selectedItemId === props.itemId;
      const inspectorTitleId = `dyna-inspector-title-${props.itemId}`;
      const quickAction = props.actions.find(
        (action) => action.name === "create_codex_task" || action.name === "open_codex_task",
      );
      const lead = props.people[0];
      const detailLabel = `Open details for ${props.title}`;
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
                controller.openDetails(props.itemId, event.currentTarget);
              }}
            >
              <span className="dyna-row-top">
                <span className="dyna-priority-label">{props.priority}</span>
                <span aria-hidden="true">·</span>
                <span className="dyna-source-mark">{props.sourceLabel}</span>
                <span className="dyna-row-time">
                  {props.dueAt
                    ? `Due ${relativeTime(props.dueAt, controller.locale)}`
                    : `Updated ${relativeTime(props.sourceUpdatedAt, controller.locale)}`}
                </span>
              </span>
              <span className="dyna-row-title">{props.title}</span>
              <span className="dyna-row-attention">{props.attention ?? props.priorityReason}</span>
              <span className="dyna-row-foot">
                {lead ? (
                  <span className="dyna-row-person">
                    {lead.displayName} · {lead.title ?? humanize(lead.leadershipLevel)}
                  </span>
                ) : (
                  <span>{humanize(props.source)}</span>
                )}
                <span className="dyna-row-state" data-state={props.workflowState}>
                  {humanize(props.workflowState)}
                </span>
              </span>
            </button>
            <div className="dyna-card-rail">
              {quickAction ? (
                <Button
                  className="dyna-card-quick"
                  data-dyna-action={`${props.itemId}:${quickAction.name}`}
                  color="primary"
                  size="xs"
                  onClick={(event) =>
                    void controller.request(
                      props.itemId,
                      props.fingerprint,
                      quickAction.name as Exclude<ActionName, "annotate">,
                      quickAction.taskId,
                      quickAction.taskHostId,
                      event.currentTarget,
                    )
                  }
                  disabled={controller.busy || controller.blocked}
                >
                  {quickAction.label}
                </Button>
              ) : null}
              <Button
                className="dyna-details-button"
                color="secondary"
                size="xs"
                variant="ghost"
                aria-label={detailLabel}
                aria-expanded={selected}
                onClick={(event) => {
                  controller.openDetails(props.itemId, event.currentTarget);
                }}
              >
                <span className="dyna-symbol" aria-hidden="true">
                  ›
                </span>
              </Button>
            </div>
          </div>
          {selected ? (
            <InspectorShell
              labelledBy={inspectorTitleId}
              onClose={() => {
                controller.closeDetails();
              }}
            >
              <header className="dyna-inspector-header">
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
                    <span className="dyna-symbol" aria-hidden="true">
                      ←
                    </span>
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
                    <span className="dyna-symbol" aria-hidden="true">
                      ×
                    </span>
                  </Button>
                </div>
                <div className="dyna-inspector-heading">
                  <div className="dyna-inspector-eyebrow">
                    <span className="dyna-priority-label">{props.priority}</span>
                    <span>{props.sourceLabel}</span>
                    <span>{humanize(props.workflowState)}</span>
                    {props.dueAt ? (
                      <span>Due {relativeTime(props.dueAt, controller.locale)}</span>
                    ) : null}
                  </div>
                  <h2 id={inspectorTitleId}>{props.title}</h2>
                </div>
              </header>
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
                              {step.dueAt
                                ? `due ${relativeTime(step.dueAt, controller.locale)}`
                                : ""}
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
                {Children.count(children) > 0 ? (
                  <section className="dyna-inspector-section">
                    <h3>Codex tasks</h3>
                    {children}
                  </section>
                ) : null}
                <details className="dyna-context-details">
                  <summary role="button">Plan, priority rationale, and provenance</summary>
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
                      <span className="dyna-chip" data-tone="warning">
                        Enrichment needs review
                      </span>
                    ) : null}
                    {props.followUpOfItemId ? (
                      <span className="dyna-meta">Follow-up to completed work</span>
                    ) : null}
                    {props.labels.length > 0 ? (
                      <div className="dyna-labels">
                        {props.labels.map((label) => (
                          <span className="dyna-chip" key={label}>
                            {label}
                          </span>
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
              <footer className="dyna-inspector-footer">
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
                      role="button"
                      aria-label={`Manage priority and order for ${props.title}`}
                      aria-disabled={controller.busy || controller.blocked}
                      onClick={(event) => {
                        if (controller.busy || controller.blocked) event.preventDefault();
                      }}
                    >
                      <span className="dyna-symbol" aria-hidden="true">
                        ⋯
                      </span>
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
              </footer>
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
            {props.title}
            <br />
            <span>
              {props.state} · observed {relativeTime(props.observedAt, controller.locale)}
            </span>
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
          <span
            className="dyna-chip"
            data-tone={
              props.lastRunStatus === "failed"
                ? "danger"
                : props.lastRunStatus === "partial"
                  ? "warning"
                  : props.lastRunStatus === "succeeded"
                    ? "success"
                    : "secondary"
            }
          >
            {props.lastRunStatus}
          </span>
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
  },
  actions: {},
});

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
  const [canExpand, setCanExpand] = useState(false);
  const [initialExpansionPending, setInitialExpansionPending] = useState(true);
  const [locale, setLocale] = useState(navigator.language);
  const current = useRef<DynaUiPayload | undefined>(undefined);
  const refreshInFlight = useRef(false);
  const refreshGeneration = useRef(0);
  const queryRef = useRef("");
  const selectedItemRef = useRef<string | undefined>(undefined);
  const autoSelectionContext = useRef("");
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
    if (!parsed.success || !dynaCatalog.validate(parsed.data.spec).success) return false;
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
    if (!trigger || busy || initialExpansionPending || displayMode === "fullscreen") return;
    expansionTrigger.current = null;
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

  const openDetails = useCallback((itemId: string, trigger: HTMLElement) => {
    detailTrigger.current = trigger;
    detailScrollPosition.current = window.scrollY;
    setSelectedItemId(itemId);
  }, []);

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
    if (displayMode !== "fullscreen") {
      autoSelectionContext.current = "";
      return;
    }
    const context = `${displayMode}:${view}:${pipelineState}`;
    if (selectedItemId) return;
    if (autoSelectionContext.current === context) return;
    autoSelectionContext.current = context;
    if (!payload) return;
    const preferred = payload.snapshot.cards.find((card) =>
      view === "queue" ? card.workflowState !== "completed" : card.workflowState === pipelineState,
    );
    if (preferred) setSelectedItemId(preferred.id);
  }, [displayMode, payload, pipelineState, selectedItemId, view]);

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
      const focusable = [
        ...modal.querySelectorAll<HTMLElement>("input, textarea, select, button:not([disabled])"),
      ];
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
      canExpand,
      condenseInline: displayMode === "inline" && canExpand,
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
          <div className="dyna-alert" role="alert">
            <strong>Offline</strong>
            <span>{connectionError}</span>
          </div>
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
  const routeDetailsOpen = Boolean(selectedItemId) && displayMode !== "fullscreen";
  const rendererUnavailable = annotationItem !== undefined || todoOpen || routeDetailsOpen;
  return (
    <ControllerContext.Provider value={controller}>
      {connectionError ? (
        <div className="dyna-alert" role="alert">
          <strong>Offline</strong>
          <span>{connectionError}</span>
        </div>
      ) : null}
      {operationError ? (
        <div className="dyna-alert" role="alert">
          <strong>Action unavailable</strong>
          <span>{operationError}</span>
        </div>
      ) : null}
      <div
        inert={rendererUnavailable ? true : undefined}
        aria-hidden={rendererUnavailable ? true : undefined}
      >
        <JSONUIProvider registry={registry}>
          <Renderer spec={payload.spec as Spec} registry={registry} />
        </JSONUIProvider>
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
            <header className="dyna-sheet-header">
              <h2 id="annotation-title">Add an executive note</h2>
            </header>
            <div className="dyna-sheet-body">
              <label htmlFor="dyna-annotation">Note</label>
              <textarea
                id="dyna-annotation"
                className="dyna-field dyna-native-textarea"
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
            <header className="dyna-sheet-header">
              <h2 id="todo-title">Add to the priority queue</h2>
            </header>
            <div className="dyna-sheet-body">
              <label htmlFor="dyna-todo-title">To-do</label>
              <input
                id="dyna-todo-title"
                className="dyna-field dyna-native-input"
                type="text"
                value={todoTitle}
                maxLength={200}
                placeholder="What needs to get done?"
                onChange={(event) => {
                  setTodoTitle(event.currentTarget.value);
                }}
                autoFocus
              />
              <label htmlFor="dyna-todo-summary">Context</label>
              <textarea
                id="dyna-todo-summary"
                className="dyna-field dyna-native-textarea"
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

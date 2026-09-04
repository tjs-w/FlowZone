import "./styles.css";

import { Badge } from "@openai/apps-sdk-ui/components/Badge";
import { Button } from "@openai/apps-sdk-ui/components/Button";
import { Textarea } from "@openai/apps-sdk-ui/components/Textarea";
import { applyDocumentTheme } from "@openai/apps-sdk-ui/theme";
import { App, type AppEventMap, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { Renderer, JSONUIProvider, defineRegistry, type Spec } from "@json-render/react";
import { DynaUiPayloadSchema, dynaCatalog, type DynaUiPayload } from "@flowzone/dyna-contracts";
import {
  createContext,
  Children,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";

const STYLE = `
:root { color-scheme: light dark; --d-bg: var(--color-background-primary, #fff); --d-card: var(--color-background-secondary, #f7f7f7); --d-text: var(--color-text-primary, #171717); --d-muted: var(--color-text-secondary, #666); --d-line: var(--color-border-light, #ddd); --d-critical: #d94841; --d-high: #d97706; --d-normal: #2563eb; --d-low: #748094; }
* { box-sizing: border-box; }
html, body, #dyna-root { margin: 0; min-height: 100%; background: var(--d-bg); color: var(--d-text); }
body { font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
button, textarea { font: inherit; }
.dyna { width: min(100%, 760px); margin: 0 auto; padding-top: max(14px, env(safe-area-inset-top), var(--d-safe-top, 0px)); padding-right: max(14px, env(safe-area-inset-right), var(--d-safe-right, 0px)); padding-bottom: max(14px, env(safe-area-inset-bottom), var(--d-safe-bottom, 0px)); padding-left: max(14px, env(safe-area-inset-left), var(--d-safe-left, 0px)); }
.dyna-header { display: grid; gap: 8px; margin-bottom: 14px; }
.dyna-title-row { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
.dyna h1 { margin: 0; font-size: clamp(20px, 4vw, 28px); line-height: 1.15; letter-spacing: -.02em; }
.dyna-description, .dyna-meta, .dyna-reason, .dyna-task { color: var(--d-muted); }
.dyna-description { margin: 0; font-size: 14px; }
.dyna-meta { font-size: 12px; }
.dyna-summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 0 0 18px; }
.dyna-stat { padding: 11px 12px; border: 1px solid var(--d-line); border-radius: 12px; background: var(--d-card); }
.dyna-stat strong { display: block; font-size: 22px; line-height: 1; }
.dyna-stat span { font-size: 11px; color: var(--d-muted); }
.dyna-section { display: grid; gap: 9px; margin: 0 0 20px; }
.dyna-section h2 { margin: 0; font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--d-muted); }
.dyna-card { position: relative; overflow: hidden; display: grid; gap: 10px; padding: 14px 14px 14px 18px; border: 1px solid var(--d-line); border-radius: 14px; background: var(--d-card); }
.dyna-card > *, .dyna-task > *, .dyna-schedule > * { min-width: 0; }
.dyna-card h3, .dyna-card p, .dyna-task, .dyna-schedule, .dyna-note-list { overflow-wrap: anywhere; }
.dyna-card::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 4px; background: var(--d-priority); }
.dyna-card[data-priority="critical"] { --d-priority: var(--d-critical); }
.dyna-card[data-priority="high"] { --d-priority: var(--d-high); }
.dyna-card[data-priority="normal"] { --d-priority: var(--d-normal); }
.dyna-card[data-priority="low"] { --d-priority: var(--d-low); }
.dyna-card-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dyna-card h3 { margin: 0; font-size: 16px; line-height: 1.3; }
.dyna-card p { margin: 0; font-size: 14px; line-height: 1.45; }
.dyna-reason { padding-left: 10px; border-left: 2px solid var(--d-priority); font-size: 12px !important; }
.dyna-labels, .dyna-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.dyna-actions { padding-top: 2px; }
.dyna-task { display: flex; justify-content: space-between; gap: 8px; padding: 8px 10px; border: 1px solid var(--d-line); border-radius: 9px; font-size: 12px; }
.dyna-schedule { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; align-items: center; padding: 10px 12px; border: 1px solid var(--d-line); border-radius: 10px; background: var(--d-card); }
.dyna-schedule strong { overflow-wrap: anywhere; font-size: 13px; }
.dyna-note-list { display: grid; gap: 5px; margin: 0; padding-left: 20px; color: var(--d-muted); font-size: 12px; }
.dyna-connection { position: sticky; top: max(0px, env(safe-area-inset-top), var(--d-safe-top, 0px)); z-index: 20; margin: max(0px, env(safe-area-inset-top), var(--d-safe-top, 0px)) max(10px, env(safe-area-inset-right), var(--d-safe-right, 0px)) 10px max(10px, env(safe-area-inset-left), var(--d-safe-left, 0px)); padding: 9px 12px; border: 1px solid color-mix(in srgb, var(--d-high) 55%, var(--d-line)); border-radius: 10px; background: var(--d-bg); color: var(--d-text); font-size: 13px; }
.dyna-inline-more { margin: 2px 0 0; color: var(--d-muted); font-size: 12px; }
.dyna-empty { padding: 38px 18px; border: 1px dashed var(--d-line); border-radius: 14px; text-align: center; color: var(--d-muted); }
.dyna-dialog { position: fixed; inset: 0; z-index: 50; display: grid; place-items: end center; padding-top: max(14px, env(safe-area-inset-top), var(--d-safe-top, 0px)); padding-right: max(14px, env(safe-area-inset-right), var(--d-safe-right, 0px)); padding-bottom: max(14px, env(safe-area-inset-bottom), var(--d-safe-bottom, 0px)); padding-left: max(14px, env(safe-area-inset-left), var(--d-safe-left, 0px)); background: color-mix(in srgb, #000 35%, transparent); }
.dyna-sheet { width: min(100%, 560px); display: grid; gap: 12px; padding: 16px; border-radius: 16px; background: var(--d-bg); box-shadow: 0 18px 60px #0004; }
.dyna-sheet h2 { margin: 0; font-size: 18px; }
.dyna-sheet-actions { display: flex; justify-content: flex-end; gap: 8px; }
.dyna-toast { position: fixed; right: max(14px, env(safe-area-inset-right), var(--d-safe-right, 0px)); bottom: max(14px, env(safe-area-inset-bottom), var(--d-safe-bottom, 0px)); z-index: 60; max-width: min(360px, calc(100vw - 28px)); padding: 10px 12px; border-radius: 10px; background: var(--d-text); color: var(--d-bg); font-size: 13px; }
@media (max-width: 480px), (pointer: coarse) { .dyna { padding-top: max(10px, env(safe-area-inset-top), var(--d-safe-top, 0px)); padding-right: max(10px, env(safe-area-inset-right), var(--d-safe-right, 0px)); padding-bottom: max(10px, env(safe-area-inset-bottom), var(--d-safe-bottom, 0px)); padding-left: max(10px, env(safe-area-inset-left), var(--d-safe-left, 0px)); } .dyna-summary { gap: 6px; } .dyna-stat { padding: 9px; } .dyna-actions > * { flex: 1 1 auto; } .dyna-task { display: grid; } .dyna-task-actions { justify-content: flex-start; } .dyna-actions button, .dyna-task button, .dyna-header button, .dyna-sheet-actions button { min-height: 44px; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; } }
`;

const EXECUTIVE_STYLE = `
:root {
  --d-paper: #f5f7f8;
  --d-ink: #172126;
  --d-cobalt: #2457d6;
  --d-plum: #7057d9;
  --d-ember: #c9443e;
  --d-moss: #257a55;
  --d-carbon: #0e1417;
  --d-slate: #182126;
  --d-bg: var(--d-paper);
  --d-card: #ffffff;
  --d-text: var(--d-ink);
  --d-muted: #5e6b72;
  --d-line: #d8dfe2;
  --d-line-strong: #aebbc1;
  --d-critical: var(--d-ember);
  --d-high: #b65b1c;
  --d-normal: var(--d-cobalt);
  --d-low: #748087;
  color-scheme: light;
}
:root[data-theme="dark"] {
  --d-bg: var(--d-carbon);
  --d-card: var(--d-slate);
  --d-text: #edf2f3;
  --d-muted: #aeb9bd;
  --d-line: #2c393e;
  --d-line-strong: #536168;
  --d-high: #e79a56;
  --d-normal: #789cff;
  --d-low: #98a5aa;
  color-scheme: dark;
}
html, body, #dyna-root { background: var(--d-bg); }
body { font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", sans-serif; }
.dyna { width: min(100%, 820px); padding-inline: max(18px, env(safe-area-inset-left), var(--d-safe-left, 0px)); }
.dyna-header { gap: 10px; margin-bottom: 18px; padding: 8px 0 17px; border-bottom: 1px solid var(--d-line-strong); }
.dyna-title-row { align-items: flex-start; }
.dyna [data-color="success"][data-variant="soft"] { --badge-background-color: #c4e7d4; --badge-text-color: #0b6638; font-weight: 600; }
:root[data-theme="dark"] .dyna [data-color="success"][data-variant="soft"] { --badge-background-color: #173e2b; --badge-text-color: #9be3bd; }
.dyna h1 { max-width: 20ch; font-size: clamp(24px, 5vw, 34px); font-weight: 650; letter-spacing: -.035em; }
.dyna-description { max-width: 66ch; line-height: 1.55; }
.dyna-commandbar { position: sticky; top: max(0px, env(safe-area-inset-top), var(--d-safe-top, 0px)); z-index: 15; display: grid; gap: 10px; margin: 0 0 18px; padding: 10px 0; border-bottom: 1px solid var(--d-line); background: color-mix(in srgb, var(--d-bg) 94%, transparent); backdrop-filter: blur(12px); }
.dyna-tabs { display: flex; gap: 4px; }
.dyna-tabs button { min-height: 34px; padding: 6px 10px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--d-muted); cursor: pointer; font-size: 13px; font-weight: 590; }
.dyna-tabs button[aria-selected="true"] { border-bottom-color: var(--d-cobalt); color: var(--d-text); }
.dyna-tabs button:focus-visible { outline: 2px solid var(--d-cobalt); outline-offset: 2px; }
.dyna-command-actions { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
.dyna-search input, .dyna-input { width: 100%; min-height: 36px; padding: 7px 10px; border: 1px solid var(--d-line-strong); border-radius: 4px; background: var(--d-card); color: var(--d-text); font: inherit; font-size: 13px; }
.dyna-search input:focus, .dyna-input:focus { border-color: var(--d-cobalt); outline: 2px solid color-mix(in srgb, var(--d-cobalt) 25%, transparent); outline-offset: 1px; }
.dyna-visually-hidden { position: absolute; overflow: hidden; width: 1px; height: 1px; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
.dyna-summary { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0; margin-bottom: 28px; border-block: 1px solid var(--d-line); background: color-mix(in srgb, var(--d-card) 68%, transparent); }
.dyna-stat { min-width: 0; padding: 14px 15px; border: 0; border-right: 1px solid var(--d-line); border-radius: 0; background: transparent; }
.dyna-stat:last-child { border-right: 0; }
.dyna-stat strong { font-size: clamp(23px, 5vw, 31px); font-weight: 580; letter-spacing: -.04em; }
.dyna-stat span { display: block; margin-top: 4px; font-size: 12px; letter-spacing: .01em; }
.dyna-section { gap: 10px; margin-bottom: 30px; }
.dyna-section h2 { padding-bottom: 5px; border-bottom: 1px solid var(--d-line); color: var(--d-text); font-size: 15px; font-weight: 620; letter-spacing: -.01em; text-transform: none; }
.dyna-card { gap: 12px; padding: 17px 17px 16px 21px; border: 0; border-bottom: 1px solid var(--d-line); border-radius: 0; background: transparent; }
.dyna-card::before { width: 3px; bottom: 16px; border-radius: 2px; }
.dyna-card:first-of-type { border-top: 0; }
.dyna-card-head { gap: 7px; }
.dyna-card h3 { max-width: 64ch; font-size: clamp(16px, 3vw, 19px); font-weight: 640; line-height: 1.32; letter-spacing: -.012em; }
.dyna-card p { max-width: 72ch; line-height: 1.55; }
.dyna-reason { padding: 0; border: 0; color: var(--d-muted); }
.dyna-lift { color: var(--d-plum); font-size: 12px; font-weight: 600; }
:root[data-theme="dark"] .dyna-lift { color: #b9a8ff; }
.dyna-people { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; }
.dyna-person { display: inline-flex; gap: 5px; align-items: baseline; color: var(--d-text); font-size: 12px; }
.dyna-person::before { content: ""; width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--d-plum); }
.dyna-person small { color: var(--d-muted); font-size: 11px; }
.dyna-guidance { display: grid; gap: 12px; padding: 13px 14px; border-left: 2px solid color-mix(in srgb, var(--d-priority) 70%, var(--d-line)); background: color-mix(in srgb, var(--d-card) 62%, transparent); }
.dyna-guidance-block { display: grid; gap: 4px; }
.dyna-guidance-label { color: var(--d-muted); font-size: 11px; font-weight: 650; letter-spacing: .025em; }
.dyna-guidance p { font-size: 13px; }
.dyna-plan, .dyna-next { display: grid; gap: 5px; margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.45; }
.dyna-next { list-style: none; padding-left: 0; }
.dyna-next li { position: relative; padding-left: 25px; }
.dyna-next-number { position: absolute; top: 1px; left: 0; display: grid; width: 17px; height: 17px; place-items: center; border: 1px solid var(--d-line-strong); border-radius: 50%; color: var(--d-muted); font-size: 10px; }
.dyna-next-meta { color: var(--d-muted); font-size: 11px; }
.dyna-labels { gap: 5px; }
.dyna-actions { gap: 8px; padding-top: 4px; }
.dyna-organize { display: flex; flex-wrap: wrap; gap: 2px; align-items: center; padding-top: 5px; border-top: 1px dashed var(--d-line); }
.dyna-organize > span { margin-right: 4px; color: var(--d-muted); font-size: 11px; }
.dyna-outcome { display: grid; gap: 3px; padding: 10px 11px; border-left: 2px solid var(--d-moss); background: color-mix(in srgb, var(--d-moss) 8%, var(--d-card)); }
.dyna-outcome > span { color: var(--d-muted); font-size: 11px; font-weight: 650; }
.dyna-outcome p { font-size: 13px; }
.dyna-task { border-width: 0 0 0 2px; border-radius: 0; background: color-mix(in srgb, var(--d-card) 60%, transparent); }
.dyna-task-actions { display: flex; flex-wrap: wrap; gap: 2px; }
.dyna-task-outcome { display: block; margin-top: 4px; color: var(--d-text); }
.dyna-pipeline { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; margin-bottom: 30px; }
.dyna-pipeline-column { min-width: 0; border-top: 3px solid var(--d-line-strong); background: color-mix(in srgb, var(--d-card) 58%, transparent); }
.dyna-pipeline-column[data-workflow-state="executing"] { border-top-color: var(--d-cobalt); }
.dyna-pipeline-column[data-workflow-state="paused"] { border-top-color: var(--d-high); }
.dyna-pipeline-column[data-workflow-state="attention"] { border-top-color: var(--d-critical); }
.dyna-pipeline-column[data-workflow-state="completed"] { border-top-color: var(--d-moss); }
.dyna-pipeline-column > header { display: flex; justify-content: space-between; gap: 8px; padding: 11px 12px 8px; }
.dyna-pipeline-column > header h2 { margin: 0; font-size: 14px; }
.dyna-pipeline-column > header span { color: var(--d-muted); font-size: 12px; }
.dyna-pipeline-items { display: grid; }
.dyna-pipeline .dyna-card { padding: 13px 12px 14px 16px; }
.dyna-pipeline .dyna-card h3 { font-size: 15px; }
.dyna-pipeline .dyna-card p { font-size: 13px; }
.dyna-pipeline-empty { margin: 0; padding: 18px 12px; color: var(--d-muted); font-size: 12px; }
.dyna-schedule { border-width: 0 0 1px; border-radius: 0; background: transparent; }
.dyna-empty { border-radius: 2px; background: color-mix(in srgb, var(--d-card) 55%, transparent); }
.dyna-sheet { border: 1px solid var(--d-line); border-radius: 10px 10px 3px 3px; }
.dyna-toast, .dyna-connection { border-radius: 4px; }
@media (max-width: 480px), (pointer: coarse) {
  .dyna { padding-inline: max(12px, env(safe-area-inset-left), var(--d-safe-left, 0px)); }
  .dyna-header { padding-top: 4px; }
  .dyna-card { padding: 15px 4px 15px 15px; }
  .dyna-guidance { padding: 12px; }
  .dyna-stat { padding: 12px 9px; }
  .dyna-stat span { font-size: 11px; }
  .dyna-command-actions { grid-template-columns: 1fr; }
  .dyna-command-actions button { width: 100%; }
  .dyna-pipeline { grid-template-columns: 1fr; }
  .dyna button { min-height: 44px; }
}
`;

type ActionName = "annotate" | "create_codex_task" | "open_codex_task" | "refresh_codex_status";

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
  readonly serverQuery: string;
  readonly view: "queue" | "pipeline";
  setQuery(value: string): void;
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
      return (
        <main
          className="dyna"
          data-display-mode={controller.displayMode}
          data-dashboard-view={controller.view}
        >
          <header className="dyna-header">
            <div className="dyna-title-row">
              <div>
                <h1>{props.name}</h1>
                <div className="dyna-meta">
                  Updated {relativeTime(props.generatedAt, controller.locale)} · revision{" "}
                  {props.revision}
                </div>
              </div>
              <Badge
                color={
                  props.freshness === "fresh"
                    ? "success"
                    : props.freshness === "aging"
                      ? "warning"
                      : "danger"
                }
                pill
              >
                {props.freshness}
              </Badge>
            </div>
            {props.description ? <p className="dyna-description">{props.description}</p> : null}
            {controller.displayMode !== "fullscreen" &&
            controller.canExpand &&
            !controller.initialExpansionPending ? (
              <Button
                color="secondary"
                variant="outline"
                data-dyna-expand="true"
                loading={controller.busy}
                disabled={controller.busy}
                onClick={(event) => void controller.expand(event.currentTarget)}
              >
                Expand dashboard
              </Button>
            ) : null}
          </header>
          <div className="dyna-commandbar">
            <div className="dyna-tabs" role="tablist" aria-label="Dashboard view">
              <button
                id="dyna-tab-queue"
                type="button"
                role="tab"
                aria-selected={controller.view === "queue"}
                aria-controls="dyna-panel-queue"
                tabIndex={controller.view === "queue" ? 0 : -1}
                onClick={() => {
                  controller.setView("queue");
                }}
                onKeyDown={(event) => {
                  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const next = event.key === "Home" ? "queue" : "pipeline";
                  controller.setView(next);
                  document.getElementById(`dyna-tab-${next}`)?.focus();
                }}
              >
                Priority queue
              </button>
              <button
                id="dyna-tab-pipeline"
                type="button"
                role="tab"
                aria-selected={controller.view === "pipeline"}
                aria-controls="dyna-panel-pipeline"
                tabIndex={controller.view === "pipeline" ? 0 : -1}
                onClick={() => {
                  controller.setView("pipeline");
                }}
                onKeyDown={(event) => {
                  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const next = event.key === "End" ? "pipeline" : "queue";
                  controller.setView(next);
                  document.getElementById(`dyna-tab-${next}`)?.focus();
                }}
              >
                Progress pipeline
              </button>
            </div>
            <div className="dyna-command-actions">
              <label className="dyna-search">
                <span className="dyna-visually-hidden">Search dashboard</span>
                <input
                  type="search"
                  value={controller.query}
                  maxLength={500}
                  placeholder="Search signals, people, plans…"
                  onChange={(event) => {
                    controller.setQuery(event.currentTarget.value);
                  }}
                />
              </label>
              <Button
                color="primary"
                size="sm"
                onClick={(event) => {
                  controller.startTodo(event.currentTarget);
                }}
                disabled={controller.busy || controller.blocked}
              >
                Add to-do
              </Button>
            </div>
          </div>
          {children}
        </main>
      );
    },
    SummaryStrip: ({ props }) => {
      const controller = useController();
      const settled = controller.query.trim() === controller.serverQuery;
      return (
        <>
          <section className="dyna-summary" aria-label="Dashboard summary">
            <div className="dyna-stat">
              <strong>{props.focus}</strong>
              <span>Need focus</span>
            </div>
            <div className="dyna-stat">
              <strong>{props.leadership}</strong>
              <span>Leadership signals</span>
            </div>
            <div className="dyna-stat">
              <strong>
                {props.shown < props.total ? `${props.shown} / ${props.total}` : props.total}
              </strong>
              <span>{props.shown < props.total ? "Shown / matching" : "Total"}</span>
            </div>
          </section>
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
      const visibleChildren =
        !controller.query && controller.displayMode === "inline" && controller.condenseInline
          ? allChildren.slice(0, 3)
          : allChildren;
      return (
        <section className="dyna-section">
          <h2>{props.title}</h2>
          {visibleChildren}
          {visibleChildren.length < allChildren.length ? (
            <p className="dyna-inline-more">
              Expand to see {allChildren.length - visibleChildren.length} more.
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
    PipelineColumn: ({ props, children }) => (
      <section className="dyna-pipeline-column" data-workflow-state={props.state}>
        <header>
          <h2>{props.title}</h2>
          <span>{props.count}</span>
        </header>
        <div className="dyna-pipeline-items">
          {Children.count(children) > 0 ? children : <p className="dyna-pipeline-empty">Clear</p>}
        </div>
      </section>
    ),
    PriorityCard: ({ props, children }) => {
      const controller = useController();
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
      return (
        <article
          className="dyna-card"
          tabIndex={-1}
          data-priority={props.priority}
          data-item-id={props.itemId}
          data-presentation={presentation}
          data-workflow-state={props.workflowState}
        >
          <div className="dyna-card-head">
            <Badge variant="outline" pill>
              {props.sourceLabel}
            </Badge>
            <Badge
              color={
                props.priority === "critical"
                  ? "danger"
                  : props.priority === "high"
                    ? "warning"
                    : "info"
              }
              pill
            >
              {props.priority}
            </Badge>
            {props.enrichmentState === "stale" ? (
              <Badge color="warning" variant="soft" pill>
                Enrichment needs review
              </Badge>
            ) : null}
            <span className="dyna-meta">
              {relativeTime(props.sourceUpdatedAt, controller.locale)}
            </span>
            {props.dueAt ? (
              <span className="dyna-meta">Due {relativeTime(props.dueAt, controller.locale)}</span>
            ) : null}
          </div>
          <h3>{props.title}</h3>
          <p>{props.summary}</p>
          {presentation === "queue" ? <p className="dyna-reason">{props.priorityReason}</p> : null}
          {props.sourcePriority !== props.priority ? (
            <span className="dyna-lift">
              {props.priorityMode === "manual"
                ? `Manually moved from ${props.sourcePriority}`
                : props.priorityMode === "leadership"
                  ? `Raised from ${props.sourcePriority} by verified leadership context`
                  : `Refined from ${props.sourcePriority} by later analysis`}
            </span>
          ) : null}
          {props.followUpOfItemId ? (
            <span className="dyna-meta">Follow-up to completed work</span>
          ) : null}
          {props.people.length > 0 ? (
            <div className="dyna-people" aria-label="Relevant people">
              {props.people.slice(0, presentation === "queue" ? 4 : 1).map((person, index) => (
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
          ) : null}
          {presentation === "queue" ? (
            <div className="dyna-guidance">
              <div className="dyna-guidance-block">
                <span className="dyna-guidance-label">Needs attention</span>
                <p>{props.attention ?? props.priorityReason}</p>
              </div>
              {props.plan.length > 0 ? (
                <div className="dyna-guidance-block">
                  <span className="dyna-guidance-label">Plan</span>
                  <ul className="dyna-plan">
                    {props.plan.map((step, index) => (
                      <li key={`${index}-${step}`}>{step}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {props.nextSteps.length > 0 ? (
                <div className="dyna-guidance-block">
                  <span className="dyna-guidance-label">Immediate next steps</span>
                  <ol className="dyna-next">
                    {props.nextSteps.map((step, index) => (
                      <li key={`${index}-${step.label}`}>
                        <span className="dyna-next-number" aria-hidden="true">
                          {index + 1}
                        </span>
                        {step.label}
                        {step.owner || step.dueAt ? (
                          <span className="dyna-next-meta">
                            {step.owner ? ` · ${step.owner}` : ""}
                            {step.dueAt
                              ? ` · due ${relativeTime(step.dueAt, controller.locale)}`
                              : ""}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}
            </div>
          ) : null}
          {presentation === "queue" && props.labels.length > 0 ? (
            <div className="dyna-labels">
              {props.labels.map((label) => (
                <Badge key={label} variant="soft">
                  {label}
                </Badge>
              ))}
            </div>
          ) : null}
          {children}
          {presentation === "queue" && props.annotationPreview.length > 0 ? (
            <ul className="dyna-note-list" aria-label="Recent notes">
              {props.annotationPreview.map((note, index) => (
                <li key={`${index}-${note}`}>{note}</li>
              ))}
            </ul>
          ) : null}
          <div className="dyna-actions">
            {props.actions.map((action) => (
              <Button
                key={action.name}
                data-dyna-action={`${props.itemId}:${action.name}`}
                data-dyna-annotation-item={action.name === "annotate" ? props.itemId : undefined}
                color={action.name === "create_codex_task" ? "primary" : "secondary"}
                size="sm"
                variant={action.name === "create_codex_task" ? "solid" : "outline"}
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
          {presentation === "queue" ? (
            <div className="dyna-organize" aria-label={`Organize ${props.title}`}>
              <span>Priority & order</span>
              <Button
                color="secondary"
                size="xs"
                variant="ghost"
                data-dyna-action={`${props.itemId}:bump`}
                onClick={(event) =>
                  void controller.organize(
                    props.itemId,
                    props.fingerprint,
                    "bump",
                    event.currentTarget,
                  )
                }
                disabled={controller.busy || controller.blocked || props.priority === "critical"}
              >
                Bump
              </Button>
              <Button
                color="secondary"
                size="xs"
                variant="ghost"
                data-dyna-action={`${props.itemId}:lower`}
                onClick={(event) =>
                  void controller.organize(
                    props.itemId,
                    props.fingerprint,
                    "lower",
                    event.currentTarget,
                  )
                }
                disabled={controller.busy || controller.blocked || props.priority === "low"}
              >
                Lower
              </Button>
              <Button
                color="secondary"
                size="xs"
                variant="ghost"
                data-dyna-action={`${props.itemId}:earlier`}
                onClick={(event) =>
                  void controller.organize(
                    props.itemId,
                    props.fingerprint,
                    "earlier",
                    event.currentTarget,
                  )
                }
                disabled={controller.busy || controller.blocked || !props.canMoveEarlier}
              >
                Earlier
              </Button>
              <Button
                color="secondary"
                size="xs"
                variant="ghost"
                data-dyna-action={`${props.itemId}:later`}
                onClick={(event) =>
                  void controller.organize(
                    props.itemId,
                    props.fingerprint,
                    "later",
                    event.currentTarget,
                  )
                }
                disabled={controller.busy || controller.blocked || !props.canMoveLater}
              >
                Later
              </Button>
            </div>
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
          <Badge
            color={
              props.lastRunStatus === "failed"
                ? "danger"
                : props.lastRunStatus === "succeeded"
                  ? "success"
                  : "secondary"
            }
            pill
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
    EmptyState: ({ props }) => <div className="dyna-empty">{props.message}</div>,
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
  const [todoPriority, setTodoPriority] = useState<"critical" | "high" | "normal" | "low">(
    "normal",
  );
  const [todoFollowUpOf, setTodoFollowUpOf] = useState<string>();
  const [view, setView] = useState<"queue" | "pipeline">("queue");
  const [query, setQuery] = useState("");
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
  const todoRequestId = useRef(crypto.randomUUID());
  const createdTodoFocus = useRef<string | undefined>(undefined);
  const hostContext = useRef<DynaHostContext>({});
  const pendingActions = useRef(
    new Map<string, { readonly requestId: string; readonly idempotencyKey: string }>(),
  );
  const annotationTrigger = useRef<HTMLElement | null>(null);
  const todoTrigger = useRef<HTMLElement | null>(null);
  const expansionTrigger = useRef<HTMLElement | null>(null);
  const actionTrigger = useRef<{ readonly element: HTMLElement; readonly key: string } | null>(
    null,
  );
  const annotationFocusAfterSave = useRef<string | undefined>(undefined);
  const dialog = useRef<HTMLDivElement | null>(null);
  current.current = payload;
  queryRef.current = query;

  const acceptPayload = useCallback((candidate: unknown) => {
    const parsed = DynaUiPayloadSchema.safeParse(candidate);
    if (parsed.success && dynaCatalog.validate(parsed.data.spec).success) {
      setPayload(parsed.data);
      setConnectionError(undefined);
    }
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
        if (next) acceptPayload(next);
        else setConnectionError(undefined);
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
      condenseInline: false,
      initialExpansionPending,
      locale,
      query,
      serverQuery: payload?.snapshot.query ?? "",
      view,
      setQuery,
      setView,
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
          <div className="dyna-connection" role="alert">
            {connectionError}
          </div>
        ) : null}
        <div className="dyna-empty">Loading dashboard…</div>
      </main>
    );
  }
  return (
    <ControllerContext.Provider value={controller}>
      {connectionError ? (
        <div className="dyna-connection" role="alert">
          {connectionError}
        </div>
      ) : null}
      {operationError ? (
        <div className="dyna-connection" role="alert">
          {operationError}
        </div>
      ) : null}
      <div
        inert={annotationItem !== undefined || todoOpen ? true : undefined}
        aria-hidden={annotationItem || todoOpen ? true : undefined}
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
            <h2 id="annotation-title">Add an executive note</h2>
            <label htmlFor="dyna-annotation">Note</label>
            <Textarea
              id="dyna-annotation"
              value={annotation}
              rows={4}
              maxLength={1_000}
              placeholder="Example: Create a new Codex task to review this MR"
              onChange={(event) => {
                setAnnotation(event.currentTarget.value);
              }}
              autoFocus
            />
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
            <h2 id="todo-title">Add to the priority queue</h2>
            <label htmlFor="dyna-todo-title">To-do</label>
            <input
              id="dyna-todo-title"
              className="dyna-input"
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
              className="dyna-input"
              value={todoPriority}
              onChange={(event) => {
                setTodoPriority(
                  event.currentTarget.value as "critical" | "high" | "normal" | "low",
                );
              }}
            >
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </select>
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

const style = document.createElement("style");
style.textContent = `${STYLE}\n${EXECUTIVE_STYLE}`;
document.head.append(style);

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

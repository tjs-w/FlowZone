# FlowZone architecture

The repository marketplace contains one installable FlowZone plugin. Markdown Review, Dyna, and CallFlow are statically registered capabilities inside its shared runtime. CallFlow keeps its domain contracts, CLI, UI, and private session state in dedicated packages, but it does not own a transport or add model-visible tools.

```text
Codex / MCP client
        │ local stdio
        ▼
flowzone MCP server → Markdown Review, Dyna, and CallFlow
```

CallFlow's human manifest and generated snapshot are distinct versioned documents. Its Graft adapter is a fixed direct subprocess boundary, all router actions are read-only, app helpers are component-only, and source disclosure requires a revision-bound expiring capability. See [docs/callflow.md](./docs/callflow.md).

FlowZone is one MCP server process with one selected transport and one model-visible data router. A fixed startup registry dispatches actions to independently owned modules. Markdown Review and Dyna retain established presentation tools for compatibility; CallFlow is routed exclusively through `flowzone`.

```text
Codex / MCP client
        │ local stdio
        ▼
flowzone(plugin, action, input)        model-visible data actions
        │
        ▼
static validated registry
        ├── in-process module (including CallFlow)
        ├── fixed allowlisted CLI/script
        └── fixed HTTPS backend API
        │
        ▼
render_markdown_review ──────────────> ui://flowzone/v5.html
render_dyna_dashboard ───────────────> ui://flowzone/dyna/v20.html
CallFlow private view data ──────────> ui://flowzone/callflow/v2.html

plugin-owned typed helper tools       app-only
```

The plugin transport is local stdio. Scheduled jobs publish through the installed plugin's absolute `<plugin-root>/bin/flowzone-publish --publisher <uuid>` launcher, which accepts one bounded JSON document on stdin and writes through the same validated Dyna store. Local tasks use `<plugin-root>/bin/dyna` for exact item-scoped synchronization after explicit one-time reconciliation of a user-layer rule bound to that installed launcher and its current verbs. CallFlow's `<plugin-root>/bin/callflow` remains the only surface for explicit index building, manifest writes, snapshot replacement, or export-file writes. Reconciliation replaces obsolete cache paths after an upgrade instead of allowing both versions. The CLIs rely on the current OS-user boundary; they do not add OAuth, Keychain, a network listener, a database-path argument, or a model-visible secret.

## Public MCP surface

The `flowzone` router is model-visible for data actions, including CallFlow discovery:

```json
{
  "plugin": "callflow",
  "action": "discover",
  "input": {
    "repositoryPath": "/absolute/path/to/repository",
    "entries": ["qualified.entryPoint"]
  }
}
```

The router advertises one compact direct-object schema with enumerated registered plugin and action names plus a generic object `input`. After selecting the route, FlowZone privately validates `input` against that action's strict schema and validates the plugin-owned result schema before returning this public envelope:

```json
{
  "schema": "flowzone/result-v1",
  "plugin": "markdown-review",
  "action": "open",
  "result": {}
}
```

Router annotations are deliberately conservative (`readOnly: false`, `destructive: true`, `openWorld: true`, `idempotent: false`) because a single MCP tool can reach actions with different risk. Existing presentation actions are registered as model-visible tools with action-specific risk metadata and dedicated resource URIs. CallFlow deliberately declares no presentation action, so it contributes no additional model-facing tool schema.

Plugin-owned component helpers remain separate typed tools. FlowZone registers them centrally with `_meta.ui.visibility: ["app"]`, so a module cannot accidentally make one model-visible. Markdown Review retains its four helper names for document checks, document loading, recovery, and image chunks. CallFlow's expansion, source, search, path, relayout, and visible-description helpers are likewise app-only and capability-bound.

## Plugin contract

Plugins declare data; they do not receive the raw MCP server:

```ts
interface FlowZonePlugin {
  readonly id: string;
  readonly displayName: string;
  readonly version?: string;
  readonly actions: readonly FlowZoneAction[];
  readonly appTools?: readonly FlowZoneAppTool[];
}
```

Each action owns strict input and output Zod schemas, risk metadata, one executor, and optional UI metadata. A presentation action additionally owns a fixed tool name and resource URI. Each UI action owns a private payload schema and a stable view ID. Every app-only helper owns its own input/output schemas and handler.

`createFlowZoneRegistry` validates bounded identifiers, descriptions, schema sizes, counts, duplicate routes, duplicate helper names, and executor configuration. It snapshots registration objects and their nested arrays/records before serving requests. Registration is static: there is no directory scan, runtime module import, user-selected executable, or mutable endpoint.

Skills are model workflow guidance only. A skill may explain which `plugin` and `action` to choose and how to handle the result, but it is never imported or executed as a runtime backend.

## Executors

### In-process modules

An in-process executor is a trusted bundled function. It receives validated input plus request ID, cancellation signal, and bounded progress reporting. The executor still must enforce plugin-domain policy such as Markdown canonical paths, file limits, publisher identity, or tenant authorization.

### Allowlisted CLI/scripts

CLI configuration is registration-owned and immutable. FlowZone requires an absolute canonical executable and working directory, fixed argument and environment allowlists, optional runtime credential injection, bounded JSON stdin/stdout, bounded diagnostics, a timeout, and process termination on timeout/cancellation. The executable identity and declared adapter files are checked again before every call; adapter files use SHA-256.

FlowZone invokes the executable directly with `shell: false`. Model input never becomes argv, a command string, a path, an environment-variable name, or a working directory. Shell executables must not be registered as adapters. Credentials must come from a credential provider, not static registration metadata.

This is process hardening, not an OS sandbox. The child inherits FlowZone's OS identity and therefore must be treated as trusted code with that user's filesystem and network authority.

### Backend APIs

HTTP configuration uses a fixed credential-free HTTPS URL with no query, fragment, or redirect following. Headers are validated; sensitive headers come from a runtime credential provider. Requests and streamed JSON responses are bounded, timeout/cancellation-aware, and validated against the same result envelope as CLI adapters. Error bodies, credentials, raw stderr, and untrusted exception details never enter model-visible errors.

FlowZone retries only explicitly idempotent actions and only retryable failures, with a small bounded backoff. Per-action concurrency and circuit-breaker limits contain repeated backend failure. The public HTTP MCP route additionally has a fixed process-local request limit; multi-instance deployments require an external shared limiter at the tunnel or reverse-proxy boundary.

## Presentation resources

`ui://flowzone/v5.html` remains the Markdown Review output resource. `ui://flowzone/dyna/v20.html` is a separate, smaller Dyna resource with a closed network CSP and clipboard-write permission limited to explicit copy actions; v19 remains a compatibility alias. `ui://flowzone/callflow/v2.html` is CallFlow's contained interactive resource, with v1 and the original standalone URI retained as compatibility aliases. Public model output stays small; Dyna payloads use typed private metadata, while complete CallFlow graphs and authorized excerpts travel only in typed private metadata. Treat each UI resource URI as a host cache key and bump its version whenever the shipped HTML, JavaScript, or CSS changes materially.

```json
{
  "schema": "flowzone/ui-v1",
  "plugin": "markdown-review",
  "action": "open",
  "view": "review",
  "payload": {}
}
```

Every resource is fixed in the startup registry. Unknown routes and invalid payloads fail closed. The resources permit no network, remote resource, or frame domains; requested host permissions remain narrowly scoped. Compatibility aliases for `ui://flowzone/v1.html` through `v4.html` and `ui://markdown-review/v30.html` serve the hardened Markdown shell for already cached views.

## Dyna

Dyna's scheduled jobs publish strict domain records, never a component tree. The incompatible `dyna/ui-v12` wire sends React only a Zod-validated `dyna/snapshot-v10` snapshot and a view capability. A closed typed React catalog deterministically projects that snapshot; scheduled output cannot choose components or actions. React uses Apps SDK UI buttons, badges, inputs, text areas, alerts, and theme tokens; native semantic controls cover simple filters and lifecycle selection, while small Dyna-owned structures and decorative SVG glyphs provide the product-specific attention ledger, four-stage lifecycle pipeline plus temporary Backlog, responsive inspector, compact note menu, and **Executive Brief**. Rich mode places the brief below the status/filter context; compact inline fallback places it after the bounded action queue so immediate work stays in the initial viewport. The brief is a presentation projection, not a stored or model-authored summary: it derives no more than four desktop points or two narrow/inline points from the current bounded snapshot, correlates only exact explicit labels shared by distinct source categories, and states active search/filter/window scope plus degraded source coverage. SQLite schema v12 retains immutable global item numbers and one-task/one-item identity, dashboard-scoped synchronization runs, exact targets, observation checkpoints, append-only task-attributed CLI receipts and work activity, optimistic editable annotation versions, and dashboard-local 24-hour Backlog preferences. Linked tasks receive bounded capabilities for their assigned item only; standalone to-do creation and bulk placement remain explicit human-approved operations. Dyna task completion is recorded independently from cached native controller status and cannot certify native success. Manual Refresh keeps the cached snapshot visible, sends one opaque run ID to the hosting Codex task, and re-renders after bounded native observations commit; automatic polling remains read-only. Human item numbers are presentation and search identifiers only; UUIDs, fingerprints, revisions, work-attempt ownership, and capabilities remain mutation authority. Request-scoped task-association reservations close the gap between native task rename and durable attachment. Item activity is global to the underlying record, while placement, Backlog, and archive disposition remain dashboard-local. Task-reported input and blockers project immediately, but only newer controller observations can supersede native conditions or certify linked-task success. Schema-version and integrity checks are transactional; limits cap the inventory at 100 dashboards and 100 publishers, each dashboard at 50 schedules, each sync run at 200 unique tasks, native batches at eight, and each item at eight task bindings, including in-flight creation and attachment reservations. Verified private point-in-time backups are store-only. Snapshot selection, full-group sequencing, ordering, and counts happen before details for at most 200 cards are batch-loaded. The browser advertises and capability-detects the standard MCP Apps fullscreen mode, respects the host-selected presentation, and offers explicit expansion; the protocol leaves left/right docking to the host. FlowZone retains five immediately visible inline rows on fine-pointer desktops, four on touch/mobile, and detail access through a wide side inspector or narrow focused route. The browser can prepare a revision- and fingerprint-bound allowlisted request; the controller revalidates those preconditions at claim time, while native task creation, navigation, naming, and status inspection remain in the current authenticated Codex task. A bounded model-visible `search-items` action supports headless hosts and discovery from the main conversation. Local scheduled publishers and item workers use the installed fixed launchers and accepted same-user trust boundary; local-preview credential issuance remains explicit and non-production.

See [docs/dyna.md](./docs/dyna.md) for the full boundary, implementation plan, and physical mobile Remote acceptance gate.

## Markdown Review compatibility

The `$flowzone:markdown-review` skill invokes `render_markdown_review` with the absolute path. Data actions remain on the router; rendered actions no longer make the router carry a universal output resource. The companion `$flowzone:dyna` skill drives the Dyna router, presentation tool, native Codex task handoff, and absolute installed item CLI. It verifies task identity through native task tools before attaching task-authored activity; `CODEX_THREAD_ID` is only a lookup hint. `$flowzone:callflow` uses the `flowzone` router for every model action and the installed CallFlow CLI only for explicit local effects. All three skills and the shared `flowzone` MCP server ship in the same plugin manifest.

The Markdown source remains canonical. Existing review submission schemas, state identity, document/image contracts, and app-only helper names are unchanged. A private legacy `document` metadata key accompanies the new FlowZone UI envelope during migration so cached v30 view code can hydrate safely.

## Add a plugin

1. Implement a plugin-owned factory and schemas without importing another plugin's internal modules.
2. Select one executor type and document its trust boundary. For CLI or HTTP, keep every destination and command field in static registration code.
3. Register any UI resource statically and keep helper tools typed and app-only. Add a dedicated presentation tool only when its extra model-facing schema is deliberate and justified.
4. Add the factory to the fixed `plugins` array in `server/src/runtime.ts`.
5. Add schema, error, cancellation, size, privacy, and integration tests through the public `flowzone` call.
6. Update the skill only for invocation guidance, rotate the plugin cachebuster, rebuild checked-in artifacts, and run `bun run verify` plus Firefox acceptance.

See [docs/plugin-authoring.md](./docs/plugin-authoring.md) and [SECURITY.md](./SECURITY.md) for the detailed checklist.

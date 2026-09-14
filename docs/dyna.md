# Dyna executive dashboards

Dyna turns bounded output from recurring Codex jobs into persistent, mobile-friendly executive dashboards. It is bundled inside the FlowZone plugin and uses Codex's existing agent, connector, schedule, and task capabilities instead of introducing a second agent runtime.

## Product requirements

- One user can create many dashboards and many scheduled publishers.
- The relationship is many-to-many: one scheduled publisher can feed several dashboards, and one dashboard can aggregate several publishers.
- Each new scheduled publisher registers the complete immutable set of source slices it must report, so a run cannot silently omit a planned connector; latest slice outcomes and freshness remain visible for diagnosis, while legacy manifestless publishers retain their data but migrate disabled pending safe re-registration.
- A job publishes normalized email, messaging, source-control, TWG, skill, or Codex records. It cannot publish HTML, JSX, JavaScript, CSS, prompts, MCP tool names, or a render tree.
- FlowZone validates those records as a versioned Zod snapshot and projects them through a closed, typed React component catalog backed by Apps SDK UI components.
- New information can replace an existing item's separate enrichment overlay using both the expected source fingerprint and enrichment version. The overlay records its provenance and base source version, rejects concurrent replacement, and becomes visibly stale and inactive when the source changes underneath it.
- Users can add annotations or new to-dos at any time, search the full bounded record text, override a priority band, sequence items inside a band, and request a supported Codex action from a card. Addressable provider records are ordinary links that support open, copy, and right-click behavior.
- The priority queue and progress view are two fixed projections of the same active items. The four user-facing lifecycle groups are **To Do**, **In Codex**, **Needs You**, and **Done**. Done is a short confirmation state: completed work remains there for the dashboard's configurable retention period (24 hours by default), then is archived on the next dashboard access. Waiting, failed, and unknown tasks all appear under **Needs You** with the precise condition **Input needed**, **Task failed**, or **Status unknown**; every successful task requires a bounded one-line completion outcome.
- Archive is a disposition, not a progress stage. Active work can be archived as **Invalid**, **Duplicate**, **No action needed**, **Superseded**, or **Other**; completed work uses **Completed**. Archived records never count as active work, remain searchable with their source/task/note/outcome and priority/order histories, support undo and restore, and are removed only by an explicit destructive dashboard or publisher purge. A later source refresh may update the record and mark it **Changed since archive**, but cannot reactivate it. Follow-ups are new active to-dos linked to an unchanged historical original.
- Leadership context is explicit provenance, not inferred authority. Only credible sender, author, owner, or approver evidence can raise an item, by at most one band; `critical` remains source-defined urgency.
- Task creation, attachment, navigation, and status inspection use the native Codex controller. Dyna stores the host/project identity and monotonic status observations only for explicitly linked tasks; it never scrapes or mirrors task transcripts.
- Manual Refresh keeps the cached dashboard visible while one dashboard-scoped controller run pulls bounded deltas for active linked Codex tasks. The backend cannot call native task APIs: the hosting Codex task reads compact native status/summaries, submits normalized batches, and lets the dashboard re-render after commit. Automatic 15/60-second polling remains read-only.
- Every item receives one immutable, Dyna-store-wide, monotonically increasing human identifier such as `:184:`. The allocation is never recycled, is searchable in active and archived work, and survives refresh, completion, archive, restore, and shared-dashboard membership. It is a display and lookup aid only; UUIDs, fingerprints, revisions, and capabilities remain authoritative for mutations.
- Every copied or Dyna-created work prompt carries a bounded `dyna/work-item-v2` reference. Any local Codex task can use the bundled item CLI to append durable progress, decisions, input requests, blockers, handoffs, completion reports, and typed result links without exposing a view capability, publisher credential, or database path. Legacy v1 references remain resolvable by UUID. Task-authored completion remains pending until the native controller verifies success.
- Every associated native Codex task is named `:<itemNumber>: <task title>` after an ownership precheck and exact controller read-back. Dyna removes bidirectional controls and every existing leading Dyna number token before adding one correct prefix, preserves number-like tokens inside the descriptive suffix, and never trims or transforms the observed title while verifying native rename success. One task ID can belong to only one Dyna item; multiple tasks may belong to the same item. Cached legacy titles carry a bounded title-sync-needed projection until a verified refresh repairs them.
- Queue and Progress place a compact **Executive Brief** immediately below the status and filter context in expanded mode. Compact inline fallback places its two-point brief after the bounded action queue so the first five desktop or four touch/mobile actions stay immediately visible. It is deterministic and evidence-bound, states the active search/filter/window scope plus any degraded source coverage, and never turns an unavailable source into a false all-clear.
- The component must remain usable in the mobile app through a Codex Remote connection.

## Architecture

```text
CLI adapter       MCP adapter       publisher adapter
     \                 │                  /
      └──────── DynaApplicationService ──┘
                       │
                 DynaRepository
                       │
              SqliteDynaRepository
                       │
                     SQLite

Codex scheduled tasks ── bounded publication ──┐
Codex task controller ── task observations ────┼─> DynaApplicationService
Dyna MCP Apps UI ─────── capability actions ───┘            │
                                                            ▼
                                                   fixed React catalog
                                                      dyna/ui-v9
```

Each adapter owns only its transport concerns: argv/stdin/stdout for the CLI, tool schemas and host cancellation for MCP, and the fixed-publisher launch contract for scheduled publication. `DynaApplicationService` owns capabilities, dashboard membership, optimistic versions, lifecycle, retention, task-sync leases/checkpoints, idempotency, projection, and transaction orchestration. `DynaRepository` is private to that service; `SqliteDynaRepository` owns schema v9, migrations, backups, parameterized SQL, row mapping, append-only item-number/task-observation ledgers, and physical read/write transaction mechanics. Future transports must call the same application operations instead of reaching into persistence.

The packages divide responsibility as follows:

| Package                     | Responsibility                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `@flowzone/dyna-contracts`  | Strict source, work/activity, action, snapshot, CLI-result, and UI payload schemas               |
| `@flowzone/dyna-node`       | Transport-neutral application rules plus private typed SQLite repository implementation          |
| `@flowzone/dyna-ui`         | Responsive React renderer, Apps SDK UI controls, activity, polling, and host messaging           |
| `@flowzone/mcp-server/dyna` | Model-visible actions, private app tools, and the dedicated presentation tool                    |
| `<plugin-root>/bin/dyna`    | Bounded work discovery, evidence, updates, lifecycle, placement, to-do, and follow-up operations |

The dedicated `render_dyna_dashboard` tool renders `ui://flowzone/dyna/v17.html`, with v16 retained as a compatibility alias. It is separate from Markdown Review so Dyna does not inherit Mermaid's bundle weight. It keeps a closed network CSP and requests clipboard-write permission only for explicit copy actions. An ordinary external-link click is delegated once through the MCP Apps host; the underlying bounded `http:` or `https:` anchor remains available for modified clicks, right-click, copy-link, and text selection. A bounded, static context menu gives exact selected text, links, linked Codex tasks, work items, and the dashboard context-appropriate actions while unselected editable fields retain the host's native editing menu; touch-generated selection menus also stay native. Its combined checked-in HTML, JavaScript, and CSS budget is 932 KiB, including cached-first task synchronization and three locally embedded Latin variable fonts so Remote/mobile rendering never depends on a font CDN. The versioned URI is the host cache key and must change whenever the shipped UI bundle changes materially.

### Executive Brief projection

The Executive Brief is an operational digest, not another card wall and not permanent report data. In expanded Queue and Progress it appears immediately after the status/filter context, where it can guide the next scan before the longer item list. In compact inline fallback it follows the bounded action queue so useful work is never pushed below the initial viewport. Archive omits it because that view is historical rather than an active-work surface.

The renderer derives at most four concise points from the authoritative snapshot:

1. **Act Now** names the highest-ranked actionable item and its concrete deadline or next step when present.
2. **Across Sources** shows up to two shared themes only when the same normalized, explicit label appears on active items from at least two distinct provider categories. It does not use fuzzy title matching, people names, or inferred causality, and generic work-type labels such as `decision` or `blocked` do not become correlations.
3. **In Motion** summarizes controller-backed Codex work, including exact input-needed, blocked, and completion-verification conditions.
4. **Recently Done** shows the latest unarchived completed outcome still inside Done retention.

Every brief names its current scope: all active items, the applied search and filters, or the highest-priority bounded window when more records exist than the snapshot carries. Source coverage is independently visible. Failed, partial, stale, revoked, or never-run sources are reported as degraded or unavailable rather than contributing a zero. Empty active work is described as clear only when coverage supports that conclusion.

The projection remains deterministic React code over existing snapshot fields. Scheduled jobs cannot provide brief prose or choose its components; there is no model call, database column, migration, new scheduled-output field, or persisted correlation state. Refreshing the authoritative snapshot recomputes the brief. Only explicit brief links and filter actions are interactive, so selecting text or clicking surrounding copy cannot trigger navigation.

### UI component decision

Dyna deliberately uses a small closed stack rather than a general-purpose dashboard framework:

1. Strict Zod contracts accept only the bounded `dyna/ui-v9` payload containing a `dyna/snapshot-v7` snapshot. Scheduled output cannot supply component names, implementation code, styling, prompts, or actions. A typed `DynaComponentCatalog` in the browser owns the only permitted projections.
2. `@openai/apps-sdk-ui` supplies Codex-native `Button`, `Badge`, `Input`, `Textarea`, `Alert`, and theme integration. Dyna maps the supplied neutral OKLCH theme onto those host-aware semantics, uses locally bundled Oxanium for sparse dashboard landmarks, Geist for readable working text and controls, and Geist Mono for compact machine-state data, and retains the SDK focus behavior without pulling a second design system into the app.
3. Small semantic Dyna components implement the product-specific attention ledger, locally bundled provider marks, all-stage progress grouping, direct queue movement, and responsive inspector. Provider names remain in accessible labels, filters, and provenance while compact rows use offline SVG marks. Native `select` and `details` elements cover the remaining simple semantics. Heavy generic menus, popovers, selectors, dashboards, and community registries stay off the mobile critical path.

The installed Apps SDK UI 0.2.2 package provides useful atoms but no dense ledger row, pipeline rail, data grid, tabs, drawer/sheet, or responsive side-inspector primitive. The build enforces a 924 KiB single-resource budget. This includes the three offline Latin font files, bounded activity-page contracts that keep historical work out of the initial snapshot, the lazy metadata-only Codex session picker, guarded workflow changes, bounded bulk-selection controls, stable human item IDs, and the dependency-free accessible context menu. Prior incremental bundle measurements showed about 49 KiB for the json-render browser renderer, 31 KiB for `SegmentedControl`, 106 KiB for `Menu`, and 116 KiB for `Select`; the picker and status control therefore use compact native selects rather than importing those SDK components. Decorative glyphs are local SVGs so the broad icon barrel does not pull unused modules into the offline resource. `EmptyMessage` fits at about 2 KiB but provides no semantic or density improvement over Dyna's action-aware empty state. These are bundled JavaScript and CSS deltas, not npm package sizes. Dyna exact-pins Apps SDK UI because its selective theme stylesheet imports are intentionally smaller than the package's full public CSS export; every SDK upgrade must re-audit those paths and the payload budget.

The larger controls are also a weaker semantic fit. Queue and Pipeline are real tab panels, while Apps SDK UI's `SegmentedControl` is a Radix toggle group. The three bounded filters contain four to six options, where native `select` preserves the operating system's compact mobile picker. Queue order uses direct pointer drag, arrow-key movement, and a row-level disclosed Move fallback for touch rather than an inspector-only application menu. Dyna therefore does not add shadcn/ui, TanStack Table, another headless component system, CopilotKit, or Tambo. Those choices would duplicate the Codex visual/runtime layer or force a desktop table onto a mobile-first action queue. A ready-made primitive is adopted only when it adds behavior or host consistency that the native element cannot provide within the payload, semantics, and touch-target budgets.

The browser acceptance suite also exercises the maximum 200-card snapshot on every supported desktop and mobile engine. It requires the complete surface to become usable within 2.5 seconds, keeps the rendered document below 6,000 elements, and requires progress switching plus immediate local full-text feedback within 500 milliseconds; a separate assertion waits for the authoritative server result. These deliberately conservative release budgets complement the payload cap without making normal CI timing-sensitive to small fluctuations.

The earlier implementation also compiled every snapshot to a json-render spec, validated it, and discarded it before the browser independently rebuilt a different tree. [Current json-render documentation](https://github.com/vercel-labs/json-render/blob/main/apps/web/app/%28main%29/docs/page.mdx) defines its useful path as a spec rendered by `Renderer` through a registry and state/visibility providers. The discard-only gate duplicated projection logic, had already drifted from the real component props, and was not the browser's security boundary, so Dyna removed it. If Dyna later needs model-selectable layouts, that is a wire-version redesign: the validated spec must become authoritative end to end. Additional scheduled information already re-renders immediately because every accepted snapshot is projected through the same closed React catalog.

## Persistence and refresh

Dyna uses Node's built-in `node:sqlite` API and therefore requires Node 22.13 or newer. Its plugin-root-relative launchers prefer the Node runtime bundled with the Codex desktop app, then fixed standard system locations. The worker-facing `bin/dyna` launcher deliberately ignores `FLOWZONE_NODE_PATH`, `NODE_OPTIONS`, `NODE_PATH`, and `PATH` runtime selection so its narrow Codex execution approval cannot become an arbitrary-code trampoline; controlled server and publisher launchers retain their separate trusted-host runtime configuration. The database lives under the operating system's per-user application-data directory, or under `FLOWZONE_DATA_DIR` in tests and controlled deployments. The connection enables WAL, foreign keys, and a five-second busy timeout. The formal schema is version 9: migration retains immutable item numbers and task ownership while adding dashboard-scoped task-sync runs, exact targets, per-task checkpoints, and append-only observation receipts; migrations and integrity checks run transactionally, future versions and foreign-key-corrupt legacy databases fail closed, and rejected schema/data changes roll back. The data directory is mode `0700`; the database, WAL, SHM, and verified backups are mode `0600`. Mutations use prepared statements and revision increments. View and action capabilities plus optional local-preview credentials are stored only as SHA-256 hashes.

Each publisher is registered against its native Codex schedule ID, title, state, freshness SLA (`staleAfterMinutes`), and last-run result. Every publisher created through the current MCP action must register its complete immutable manifest of up to 50 unique required `(source, sourceScope)` pairs. Existing publishers migrated without a manifest may register one later during binding/status reconciliation, provided it covers every slice with active records; afterward only the identical set is accepted, because changing or removing scopes could strand records. Inventory returns the registered manifest. A dashboard accepts at most 50 bound schedules. A successful global `replace` run is an atomic full snapshot: omitted publisher memberships become inactive. The store retains `upsert` only as an internal compatibility shape; migration never authorizes it. A multi-source run declares unique `sourceSlices` with a `succeeded` or `failed` result. When a publisher has a manifest, each run must declare exactly that set—including failed and successful-empty slices—and missing, extra, or duplicate declarations are rejected before any run or item state changes; the manifest is read and compared under the same immediate publication transaction as credential validation and persistence. Source-sliced runs use `replace`: omitted records retire only in successful slices, including successful empty slices, while failed slices preserve their last-known records. Items must belong to a declared successful slice, slice declarations determine the overall succeeded/partial/failed status, and partial or failed status requires a bounded aggregate error. External publishers migrated from pre-v3 schemas retain their records and any registered manifests, but migration disables them, invalidates their old credentials, and marks cached native schedule state `unknown`; it cannot pause a host-owned Codex task. Reconcile and pause the native task before re-registering a manifest-backed publisher for an explicit local preview. Manifest enrollment on the disabled legacy identity preserves its source declaration but does not reactivate the retired credential, and migration never authorizes manifestless publication. A source-sliced or legacy partial run visibly marks the schedule and aggregate dashboard stale; a fully failed run contains no items and preserves all prior records. Public failure diagnostics are normalized to one line, redacted for common credential forms, and capped before persistence. Every publication supplies both a stable run ID and the schedule execution's `sourceCompletedAt`. The run ID and a canonical request digest deduplicate exact retries—including source declarations supplied in another order—and reject conflicting reuse; the completion time prevents a delayed older execution from replacing a newer slice. Superseded runs are recorded but do not change the dashboard. Canonical identity is publisher-scoped so one scheduled authority cannot overwrite another. Scheduled records may carry bounded untrusted `people`, `attention`, `plan`, and `nextSteps` data, while only control-path enrichment marked `twg_org_tree` or `user_configured` can lift priority. That provenance is caller-attested in the local preview until a host-controlled identity registry or evidence adapter is available. Conversation-driven enrichment replaces those fields without mutating the source slice. User-created to-dos use dashboard-scoped request IDs for retry safety; priority/sequence choices are also dashboard-scoped, so both views update immediately without leaking preferences into another dashboard. Model-visible `search-items` returns at most 20 actionable records with stable IDs for non-UI clients and later enrichment. Publishers can be rotated, revoked, or revoked with record purge; bindings can be removed independently, and a dashboard can be purged after exact-ID confirmation.

An active visible component polls cached state every 15 seconds and refreshes immediately when it returns to the foreground. Hidden or unfocused components back off to 60 seconds. Those automatic reads never launch native task work. Manual Refresh paints the cached response first, then creates or joins one persisted dashboard-scoped task-sync run and sends only its opaque run UUID to the hosting Codex task. The controller checks no more than 200 active linked tasks, in native batches of eight, and the UI polls only the run's sanitized counts at one second while visible or five seconds while backgrounded. It fetches one fresh snapshot after the run reaches current, updated, partial, expired, or unavailable. The board never blanks or enters a dashboard-wide busy state. Refresh responses include a new private snapshot even when the data revision is unchanged so relative times and freshness continue to age. Each active schedule is fresh until 75% of its configured SLA, aging until the SLA, and stale after it. A bound revoked or never-run publisher is immediately stale and can never make the dashboard appear live; retained revoked records and historical run status remain visible for diagnosis, while schedule reconciliation is rejected. Partial and failed active schedules are also immediately stale. Every snapshot is read atomically. SQL deduplicates and orders the full eligible set, computes full summary counts, then batch-loads details for the highest-priority 200 cards. The UI reports when this is a bounded window; tokenized server-side full-text search still retrieves matching records outside it. View capabilities use a sliding 30-day lifetime and fail with an explicit reopen instruction after expiry.

Promoted and superseded runs persist normalized slice evidence. Publisher inventory and snapshots expose the latest promoted slice status with cadence-aware freshness; the dashboard shows compact unhealthy source badges and collapses fully healthy coverage to one line.

### Scheduled credential modes

With `credentialMode: "local_cli"`, Dyna requires an immutable source manifest and returns no secret. The scheduled job runs as the same macOS user and sends one bounded, schema-valid JSON run to the installed plugin's absolute `<plugin-root>/bin/flowzone-publish --publisher <uuid>` launcher over stdin. The publisher ID is fixed in the command rather than accepted from stdin. For unattended `workspace-write` schedules, use an exact Codex allow rule for that launcher, `--publisher`, and publisher ID; start the plain command in a PTY, write one compact JSON line followed by a newline, and then send EOF rather than using shell pipes, redirection, wrappers, or extra arguments. The launcher disables terminal echo before reading and fails closed if it cannot, so source records do not enter terminal output. Dyna validates source slices and records before changing the SQLite store. The launcher path and rule must be reconciled after installing FlowZone at a different path; it is not placed on the system `PATH`.

An existing manifest-backed publisher created in disabled mode can be transitioned idempotently with `enable-local-cli-publisher`, preserving its immutable native schedule identity and dashboard bindings.

This is intentionally a same-user trust boundary: any process running under that macOS account can publish through a registered `local_cli` publisher. Use `credentialMode: "disabled"` when that is not acceptable. `credentialMode: "local_preview"` remains an explicit non-production option that returns a model-visible secret and uses the MCP `publish-run` action.

### Local scheduled publication

The scheduled task normalizes records to this envelope and sends it to the bundled launcher through the documented echo-disabled PTY workflow:

```json
{
  "runId": "schedule-2026-09-06T18:00:00Z",
  "sourceCompletedAt": "2026-09-06T18:00:00Z",
  "mode": "replace",
  "status": "succeeded",
  "sourceSlices": [{ "source": "outlook", "sourceScope": "outlook:work", "status": "succeeded" }],
  "items": []
}
```

Connector login remains host-owned and independent. An Outlook source can use the user's existing manually authenticated session; Dyna never receives or manages that credential.

## Cross-session item synchronization

The installed `<plugin-root>/bin/dyna` launcher gives any local Codex task a narrow work-management interface to the same application service. It is resolved from the installed `$flowzone:dyna` skill rather than assumed to be on `PATH`. The launcher requires Node.js 22.13 or newer, accepts exact dashboard/item identifiers and expected versions in argv, and returns bounded JSON for `--help`, `--version`, and `setup`. Read commands use bounded argv only. Every mutation consumes exactly one strict, bounded JSON object through an echo-disabled PTY and returns one versioned JSON result. Launcher preflight failures use the same redacted JSON error envelope. It never accepts a database path, SQL, source-record mutation, publisher or schedule controls, controller operations, deletion, purge, or credentials.

The shared local store sits outside ordinary project workspaces, so unattended and separately sandboxed tasks require a one-time user-layer Codex rule. From the installed plugin, run `<plugin-root>/skills/dyna/scripts/reconcile-cli-rule.sh --check`; with explicit user approval, use `--install` when it reports `missing` or `stale`. The reconciler refuses source checkouts and atomically owns only `flowzone-dyna-worker.rules`. Its rules match the exact installed `<plugin-root>/bin/dyna` and the canonical noun/verb pairs below—never a shell, Node.js, database path, future verb, or general writable root. Restart Codex when it reports `restartRequired: true`. Re-run it after every FlowZone update because the cache path changes and the old launcher must stop matching.

Copied and Dyna-created prompts begin with a non-secret synchronization reference:

```text
Use $flowzone:dyna to keep this item synchronized while you work.

Dyna work reference:
{
  "schema": "dyna/work-item-v2",
  "dashboardId": "...",
  "itemId": "...",
  "itemNumber": 184,
  "expectedFingerprint": "...",
  "sourceUpdatedAt": "...",
  "copiedAt": "...",
  "workAttemptId": "..."
}

BEGIN UNTRUSTED DYNA CONTEXT
...
END UNTRUSTED DYNA CONTEXT
```

The reference contains only stable control identifiers, the source fingerprint, and timestamps. Dashboard names, linked-task titles/outcomes, source content, notes, and all other descriptive text remain inside the untrusted-context envelope. Older v1 and v2 references carrying legacy `dashboardName` and `linkedTasks` fields remain readable, but those fields are treated as untrusted display data. The reference contains no view token, claim token, publisher credential, database path, or reusable mutation request ID. Identifiers and fingerprints prevent accidental writes; under Dyna's accepted single-user trust boundary, they are not credentials against another process running as that user.

The CLI has one hard-cutover surface; the former `item update`, `item enrich`, `item place`, `item archive`, and `item restore` spellings are rejected rather than retained as aliases:

| Area      | Commands                                                                        |
| --------- | ------------------------------------------------------------------------------- |
| Dashboard | `dyna dashboard list`, `dyna dashboard show --dashboard-id D`                   |
| Evidence  | `dyna item search`, `dyna item show`, `dyna item history`, `dyna item activity` |
| Work      | `dyna work update`, `dyna work enrich`                                          |
| Organize  | `dyna organize place`, `dyna organize place-many`                               |
| Lifecycle | `dyna lifecycle archive`, `dyna lifecycle restore`                              |
| Creation  | `dyna todo create`, `dyna follow-up create`                                     |

`dashboard list` returns at most 100 records. `dashboard show` exposes only bounded operational identity, revision, freshness, active/archive counts, and scheduled-source health. `item search` defaults to active scope and returns at most 20 operational briefs; an exact `184` or `:184:` query ranks item `:184:` before textual collisions and before applying that cap. History retains four independent cursors with pages of at most 50, while activity pages contain at most 25 updates. Snapshot cards likewise carry only the latest update and its total count.

`work update` appends durable typed activity and up to four `http:`/`https:` artifact links. `work enrich` replaces the bounded evidence-derived overlay. `organize place` changes one dashboard-local placement; `organize place-many` atomically validates 1–200 unique items, preserves their current relative queue order, and appends them as one block in the target priority group. `lifecycle archive` and `restore` reuse the durable archive lifecycle. `todo create` creates an independent active to-do and forbids `followUpOfItemId`; only `follow-up create` creates new active work linked to an unchanged completed or archived original. Every logical mutation has a unique request UUID; an exact uncertain retry reuses it, while conflicting reuse or stale fingerprint/revision/enrichment context fails without partial writes.

Work updates are append-only and item-global, so the same record remains synchronized across dashboards. Placement, ordering, and archive disposition stay dashboard-local. Activity, outcomes, and artifacts survive completion, archive, restoration, full-text search, retrospective reporting, and routine refresh. A refresh may update an archived record and mark it changed, but never reactivates it.

Task-authored `needs_input` and `blocked` conditions surface immediately. A later task-authored progress update clears them. `completion_reported` remains **In Codex** with verification pending. Only a native controller observation attached to the exact task and host can supersede a task report or certify success, and **Done** still requires every linked task to be controller-observed as succeeded. For taskless items, the user can move between **To Do** and **Needs You**, or mark work **Done** with a required one-line outcome. The same guarded transition path powers the per-item status menu and Progress-lane drag-and-drop. Moving a taskless item to **In Codex** starts the native task flow; linked-item lane choices open or refresh the exact Codex task rather than manufacturing task state. Completed work cannot be reopened in place and instead creates a linked follow-up. `CODEX_THREAD_ID`, when available, is only a lookup hint for native task verification.

The companion skill records only durable milestones, decisions, exact input requests, blockers with recovery steps, handoffs, verified outcomes, and result artifacts. It excludes command narration, raw logs, speculative hypotheses, source bodies, secrets, and chain of thought. Routine updates and evidence-bound enrichment are permitted within assigned work; priority/order changes, archive, and restore require explicit user direction. Completed or archived originals cannot receive new execution state, so continued work creates a linked follow-up.

## Action protocol

For Slack, Outlook, GitLab, GitHub, Discord, Jira, Confluence, and other explicitly supported providers, the UI derives an `http` or `https` destination from the validated typed source identity. It never accepts an arbitrary URL from a publisher. The item title, inspector action, and provenance reference are real anchors, so normal open-in-new-tab, copy-link, and context-menu behavior works; a capable MCP Apps host receives the same derived destination through `openLink`. Source types without a verified portable URL, including Codex-only records, continue through the bounded opaque action flow below rather than inventing a link.

The browser never receives a native Codex session API or task transcript. It prepares allowlisted actions through a capability-bound private tool and sends the current task only:

`Handle Dyna action request <request-id> with $flowzone:dyna.`

No source text, prompt, tool name, file path, or task transcript is included in that message. The `$flowzone:dyna` workflow claims the request once and receives immutable context plus a one-time completion token. For `create_codex_task`, it resolves the exact claimed dashboard ID, retrieves context through the exact dashboard/item pair, and revalidates item membership and fingerprint before native creation. It then builds the same control-only `dyna/work-item-v2` reference used by **Copy work prompt**, using the immutable item number plus fresh copy/attempt IDs, while placing dashboard, linked-task, and source display text only in the untrusted-context envelope; action/view/claim/publisher tokens and request IDs are excluded.

Existing-task association is a two-step variant of the same flow. `list_codex_sessions` asks the native controller for at most 50 accessible Codex tasks and returns only task ID, host ID, optional project ID, title, and update time. The bounded list is held in memory for at most ten minutes, bound to the requesting view, dashboard, item, and action expiry, and exposed to the component only through app-private result metadata after view-token authorization. It is not stored in SQLite or returned in model-visible structured action status. A direct non-UI association calls `check-codex-task-association` with a fresh `reservationRequestId` before native rename; `attachable` returns a short-lived `reservationId` that must be passed to `attach-codex-task` as `associationReservationId`, while `same_item` requires no reservation. The UI-selected `attach_codex_task` action must cite the exact list request and candidate identity; its `claim-action` transaction reserves that task atomically, so the worker must not run a second check after claim. The skill removes bidi controls and every existing leading Dyna number token, applies one correct prefix within the native 200-codepoint title limit, calls the native title setter only when needed, and re-reads the task before reporting exact code-point equality. At completion Dyna rechecks short-lived authorization, active lifecycle, capacity, the reservation, global task ownership, and exact controller metadata. A same-item retry may update host routing after handoff, but a task ID can never move to another item. Uncertain attachment keeps its action-owned reservation for explicit reconciliation. Dyna persists only bounded controller status metadata and an optional verified one-line outcome—never a prompt, transcript, turn summary, or raw output.

The workflow then completes the state machine:

```text
PREPARED → DELIVERED → CLAIMED → SUCCEEDED
                               ├→ FAILED
                               └→ NEEDS_RECONCILIATION
```

Requests are bound to the dashboard revision, source fingerprint, item, task host, and a random per-attempt idempotency key. Ambiguous host delivery resends the same opaque request, and a remounted component recovers any matching nonterminal attempt from the server; a confirmed terminal result permits a deliberate new attempt. The controller atomically revalidates dashboard membership, revision, and fingerprint before claiming. Requests expire after ten minutes and claims have a five-minute completion lease; abandoned claims transition to `needs_reconciliation` on status inspection or before a new attempt. Claim and completion capabilities are 256-bit random values. Replays, stale screens, cross-dashboard status reads, regressive task observations, noncanonical controller titles, cross-item task reuse, and action-incompatible completion payloads fail closed. Uncertain creation or attachment is resolved only after native inventory and canonical-title read-back: `resolve-action-reconciliation` links the verified native task or records that no creation or association took effect. An item can retain at most eight linked Codex tasks. A claimed or uncertain creation reserves its final slot across competing status updates so a task already created by Codex cannot be stranded before its completion or reconciliation is recorded.

Linked-task pull synchronization uses a separate opaque controller protocol:

`Handle Dyna task sync <run-id> with $flowzone:dyna.`

App-private `dyna_begin_task_sync`, `dyna_mark_task_sync_delivered`, and `dyna_task_sync_status` tools expose only a capability-bound public summary. Model-visible `claim-task-sync`, `submit-task-sync-batch`, and `complete-task-sync` actions keep the one-time claim token and opaque checkpoints inside the hosting controller turn. A claim selects at most 200 unique active task bindings independently of visible filters; the controller calls native `wait_threads` in groups of eight with saved cursors and may use `read_thread` with `turnLimit: 1` and `includeOutputs: false` only for exact identity, title/status confirmation, or handoff recovery. It never pages history or reads raw transcripts and outputs. Each retry-safe batch carries at most eight normalized task statuses, one optional durable delta per task, four validated artifacts, or bounded unavailable reasons. Finalization revalidates ownership and checkpoints, commits each observation once, and touches affected dashboards once. Failed reads preserve the prior status; only controller-observed native success can produce Done. When that native success has no usable one-line outcome, Dyna still records Done without fabricating content and reports only a sanitized `incompleteMetadataTasks` count in the partial terminal summary. Five-minute claims and fifteen-minute run expiry permit safe reclaim without duplicate task activity. `dyna work update` remains the richer immediate fallback and the CLI gains no controller or synchronization administration surface.

## Mobile and Remote acceptance

The Dyna surface is a compact attention ledger rather than a card wall. Each flat row presents a source mark and action title first, then the exact lifecycle or exception, relevant person, one-line attention reason, and a deadline only when one exists. Priority is carried by the queue section rather than repeated on every row; Progress carries lifecycle through its columns, so neither view renders a redundant four-step locator. A safe source title is a real anchor with native open-in-new-tab, copy-link, and context-menu behavior; ordinary activation delegates to the MCP Apps host so Codex opens the record externally, while clicking the rest of the row opens details. Queue items move directly by pointer drag or arrow keys, and touch users get the same raise, lower, earlier, and later operations from a row-level Move control without opening details.

After the MCP Apps handshake, Dyna automatically requests `fullscreen` once and deduplicates simultaneous expansion requests. The bounded inline dashboard renders immediately while Codex resolves that request, so host-selected presentation latency never blocks useful content or controls. MCP Apps exposes `inline`, `fullscreen`, and `pip`; it does not expose a left/right docking parameter, so Codex owns the outer app presentation. Within Dyna itself, details reserve space in a non-overlapping right inspector at 980 pixels and wider and become a focused route on narrow screens. Inline fallback shows five useful rows on a fine-pointer desktop when space permits and four on touch/mobile; rich mode adds the full queue, priority/source/workflow/leadership filters, all four progress groups at once, and to-do capture. The Executive Brief sits directly below status/filter context in rich mode; compact inline fallback places its two highest-value points after the bounded queue so immediate actions retain the initial viewport. Desktop actions remain immediately under the inspector heading, while touch hosts use a bottom action bar. Both modes preserve 44-pixel coarse-pointer targets, no hover-only actions, no horizontal table, light/dark support, CSS and host-provided safe-area insets, and reduced-motion support. Dyna intentionally bundles Oxanium for sparse navigation and section landmarks, Geist for working text and controls, Geist Mono for comparable machine-state data, and a Nord-derived dark canvas. These requested product choices are documented deviations from OpenAI's preference for host typography and system colors; semantic action, focus, contrast, safe-area, and responsive behavior still follow the host guidance. Full-text filtering tokenizes terms locally for immediate feedback, announces settled counts to assistive technology, and refreshes a server-filtered snapshot so records outside the 200-card window remain discoverable. An inline-only or rejecting host retains the concise two-point Executive Brief, detail access, and an explicit retry when fullscreen was advertised. Hosts without server-tool capability receive a read-only dashboard, while hosts without text-message capability keep annotations, to-dos, priority changes, and provider links but disable only Codex-task handoff actions. The annotation and to-do sheets trap focus, dismiss with Escape, restore their triggers, and retain drafts after rejected saves.

A release is not considered mobile-ready from browser emulation alone. Acceptance requires the current iOS and Android ChatGPT mobile apps connected to a Codex Remote host:

1. Open a dashboard from a remotely running task.
2. Background and foreground the app; verify the cached snapshot catches up without duplicate cards, then manually Refresh and verify linked-task synchronization completes through the paired Mac without blanking the board.
3. Add an annotation with the software keyboard open.
4. Create a Codex task from a card, verify exactly one task appears, and open it from the refreshed card.
5. Add and reprioritize a to-do; verify it appears in both the queue and **To Do** pipeline column.
6. Move a linked task through running, waiting, and succeeded; verify the pipeline, task link, one-line outcome, and completed-to-follow-up path.
7. Interrupt connectivity during creation and verify the request becomes failed or needs reconciliation rather than silently succeeding.
8. Verify light/dark themes, large text, screen-reader labels, and 320-pixel-wide layout.

## Delivery status

The implemented vertical slice includes strict contracts, the SQLite store, native schedule inventory, atomic publisher-isolated run slices, fingerprint-and-version-bound enrichment overlays, provenance-gated leadership ranking, retry-safe manual to-dos, dashboard-local priority and full-group sequence preferences with append-only history, server-backed full-text filtering, a bounded model-visible brief, the active priority queue, complete progress pipeline, durable searchable archive with undo and restore, annotations, publisher/binding/dashboard lifecycle controls, the leased one-time action protocol, existing-task attachment, cached-first linked-task pull synchronization with durable checkpoints and partial-failure reporting, conservative multi-session status aggregation and outcomes, copied work references, append-only cross-task activity and typed artifacts, the item-scoped CLI and exact installed-launcher rule reconciler, completed and archived follow-ups, the dedicated UI resource, integration tests against the checked-in Node bundles, and Dyna-specific accessibility/action/reflow journeys on Chromium, WebKit, mobile Chromium, and mobile WebKit.

The remaining release acceptance is deliberately host- or operator-owned:

1. Back leadership lifts with a host-controlled VIP registry using stable identities or an opaque evidence capability from a trusted org adapter; until then, enrichment provenance is caller-attested.
2. Run the physical Remote acceptance matrix above and record host/app versions.
3. Expose backup retention and offline restore through a documented trusted-operator workflow; the verified store primitive is intentionally not a model-visible action.

The design follows the official [OpenAI plugin UI guidelines](https://developers.openai.com/plugins/concepts/ui-guidelines), [MCP Apps UI reference](https://developers.openai.com/plugins/reference), [scheduled tasks guidance](https://learn.chatgpt.com/docs/automations), [Remote connections guidance](https://learn.chatgpt.com/docs/remote-connections), and [agent-friendly CLI guidance](https://learn.chatgpt.com/use-cases/agent-friendly-clis).

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
- The component must remain usable in the mobile app through a Codex Remote connection.

## Architecture

```text
Codex scheduled tasks                Codex task controller
 email / chat / SCM / TWG / skills      create / read / open task
            │                                       ▲
            │ publish bounded records               │ opaque action request
            ▼                                       │
      Dyna SQLite store ── strict Zod snapshot ──> fixed React catalog
            ▲                                         │
            │ annotations / enrichment                ▼
            └──────────── app-only tools ──────> Dyna MCP Apps UI
                                                dyna/ui-v6
```

The packages divide responsibility as follows:

| Package                     | Responsibility                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `@flowzone/dyna-contracts`  | Strict Zod source records, actions, snapshots, and snapshot-only UI payload               |
| `@flowzone/dyna-node`       | SQLite persistence, capability tokens, action state machine, and snapshots                |
| `@flowzone/dyna-ui`         | Responsive React renderer, Apps SDK UI controls, annotations, polling, and host messaging |
| `@flowzone/mcp-server/dyna` | Model-visible actions, private app tools, and the dedicated presentation tool             |

The dedicated `render_dyna_dashboard` tool renders `ui://flowzone/dyna/v8.html`. It is separate from Markdown Review so Dyna does not inherit Mermaid's bundle weight. It keeps a closed network CSP and requests clipboard-write permission only for the explicit **Copy work prompt** action; selected text uses the host's native context menu. Its combined checked-in HTML, JavaScript, and CSS budget is 825 KiB, including locally embedded Latin variable fonts so Remote/mobile rendering never depends on a font CDN. The versioned URI is the host cache key and must change whenever the shipped UI bundle changes materially.

### UI component decision

Dyna deliberately uses a small closed stack rather than a general-purpose dashboard framework:

1. Strict Zod contracts accept only the bounded `dyna/ui-v6` snapshot. Scheduled output cannot supply component names, implementation code, styling, prompts, or actions. A typed `DynaComponentCatalog` in the browser owns the only permitted projections.
2. `@openai/apps-sdk-ui` supplies Codex-native `Button`, `Badge`, `Input`, `Textarea`, `Alert`, icons, and theme integration. Dyna maps the supplied neutral OKLCH theme onto those host-aware semantics, uses locally bundled Oxanium for the interface and Geist Mono for compact operational metadata, and retains the SDK focus behavior without pulling a second design system into the app.
3. Small semantic Dyna components implement the product-specific attention ledger, locally bundled provider marks, all-stage progress grouping, direct queue movement, and responsive inspector. Provider names remain in accessible labels, filters, and provenance while compact rows use offline SVG marks. Native `select` and `details` elements cover the remaining simple semantics. Heavy generic menus, popovers, selectors, dashboards, and community registries stay off the mobile critical path.

The installed Apps SDK UI 0.2.2 package provides useful atoms but no dense ledger row, pipeline rail, data grid, tabs, drawer/sheet, or responsive side-inspector primitive. The build enforces an 825 KiB single-resource budget; the current HTML, JavaScript, and CSS total is 839,927 bytes, leaving 4,873 bytes of headroom. This includes the two offline Latin font files. Prior incremental bundle measurements showed about 49 KiB for the json-render browser renderer, 31 KiB for `SegmentedControl`, 106 KiB for `Menu`, and 116 KiB for `Select`. `EmptyMessage` fits at about 2 KiB but provides no semantic or density improvement over Dyna's action-aware empty state. These are bundled JavaScript and CSS deltas, not npm package sizes. Dyna exact-pins Apps SDK UI because its selective theme stylesheet imports are intentionally smaller than the package's full public CSS export; every SDK upgrade must re-audit those paths and the payload budget.

The larger controls are also a weaker semantic fit. Queue and Pipeline are real tab panels, while Apps SDK UI's `SegmentedControl` is a Radix toggle group. The three bounded filters contain four to six options, where native `select` preserves the operating system's compact mobile picker. Queue order uses direct pointer drag, arrow-key movement, and a row-level disclosed Move fallback for touch rather than an inspector-only application menu. Dyna therefore does not add shadcn/ui, TanStack Table, another headless component system, CopilotKit, or Tambo. Those choices would duplicate the Codex visual/runtime layer or force a desktop table onto a mobile-first action queue. A ready-made primitive is adopted only when it adds behavior or host consistency that the native element cannot provide within the payload, semantics, and touch-target budgets.

The browser acceptance suite also exercises the maximum 200-card snapshot on every supported desktop and mobile engine. It requires the complete surface to become usable within 2.5 seconds, keeps the rendered document below 6,000 elements, and requires progress switching plus immediate local full-text feedback within 500 milliseconds; a separate assertion waits for the authoritative server result. These deliberately conservative release budgets complement the payload cap without making normal CI timing-sensitive to small fluctuations.

The earlier implementation also compiled every snapshot to a json-render spec, validated it, and discarded it before the browser independently rebuilt a different tree. [Current json-render documentation](https://github.com/vercel-labs/json-render/blob/main/apps/web/app/%28main%29/docs/page.mdx) defines its useful path as a spec rendered by `Renderer` through a registry and state/visibility providers. The discard-only gate duplicated projection logic, had already drifted from the real component props, and was not the browser's security boundary, so Dyna removed it. If Dyna later needs model-selectable layouts, that is a wire-version redesign: the validated spec must become authoritative end to end. Additional scheduled information already re-renders immediately because every accepted snapshot is projected through the same closed React catalog.

## Persistence and refresh

Dyna uses Node's built-in `node:sqlite` API and therefore requires Node 22.13 or newer. Its plugin-root-relative launchers prefer the Node runtime bundled with the Codex desktop app, then standard system locations; controlled hosts can set `FLOWZONE_NODE_PATH` to a trusted executable. The database lives under the operating system's per-user application-data directory, or under `FLOWZONE_DATA_DIR` in tests and controlled deployments. The connection enables WAL, foreign keys, and a five-second busy timeout. The formal schema is version 5: migrations and integrity checks run transactionally, future versions and foreign-key-corrupt legacy databases fail closed, and rejected schema/data changes roll back. The data directory is mode `0700`; the database, WAL, SHM, and verified backups are mode `0600`. Mutations use prepared statements and revision increments. View and action capabilities plus optional local-preview credentials are stored only as SHA-256 hashes.

Each publisher is registered against its native Codex schedule ID, title, state, freshness SLA (`staleAfterMinutes`), and last-run result. Every publisher created through the current MCP action must register its complete immutable manifest of up to 50 unique required `(source, sourceScope)` pairs. Existing publishers migrated without a manifest may register one later during binding/status reconciliation, provided it covers every slice with active records; afterward only the identical set is accepted, because changing or removing scopes could strand records. Inventory returns the registered manifest. A dashboard accepts at most 50 bound schedules. A successful global `replace` run is an atomic full snapshot: omitted publisher memberships become inactive. The store retains `upsert` only as an internal compatibility shape; migration never authorizes it. A multi-source run declares unique `sourceSlices` with a `succeeded` or `failed` result. When a publisher has a manifest, each run must declare exactly that set—including failed and successful-empty slices—and missing, extra, or duplicate declarations are rejected before any run or item state changes; the manifest is read and compared under the same immediate publication transaction as credential validation and persistence. Source-sliced runs use `replace`: omitted records retire only in successful slices, including successful empty slices, while failed slices preserve their last-known records. Items must belong to a declared successful slice, slice declarations determine the overall succeeded/partial/failed status, and partial or failed status requires a bounded aggregate error. External publishers migrated from pre-v3 schemas retain their records and any registered manifests, but migration disables them, invalidates their old credentials, and marks cached native schedule state `unknown`; it cannot pause a host-owned Codex task. Reconcile and pause the native task before re-registering a manifest-backed publisher for an explicit local preview. Manifest enrollment on the disabled legacy identity preserves its source declaration but does not reactivate the retired credential, and migration never authorizes manifestless publication. A source-sliced or legacy partial run visibly marks the schedule and aggregate dashboard stale; a fully failed run contains no items and preserves all prior records. Public failure diagnostics are normalized to one line, redacted for common credential forms, and capped before persistence. Every publication supplies both a stable run ID and the schedule execution's `sourceCompletedAt`. The run ID and a canonical request digest deduplicate exact retries—including source declarations supplied in another order—and reject conflicting reuse; the completion time prevents a delayed older execution from replacing a newer slice. Superseded runs are recorded but do not change the dashboard. Canonical identity is publisher-scoped so one scheduled authority cannot overwrite another. Scheduled records may carry bounded untrusted `people`, `attention`, `plan`, and `nextSteps` data, while only control-path enrichment marked `twg_org_tree` or `user_configured` can lift priority. That provenance is caller-attested in the local preview until a host-controlled identity registry or evidence adapter is available. Conversation-driven enrichment replaces those fields without mutating the source slice. User-created to-dos use dashboard-scoped request IDs for retry safety; priority/sequence choices are also dashboard-scoped, so both views update immediately without leaking preferences into another dashboard. Model-visible `search-items` returns at most 20 actionable records with stable IDs for non-UI clients and later enrichment. Publishers can be rotated, revoked, or revoked with record purge; bindings can be removed independently, and a dashboard can be purged after exact-ID confirmation.

An active visible component polls every 15 seconds and refreshes immediately when it returns to the foreground. Hidden or unfocused components back off to 60 seconds. Refresh responses include a new private snapshot even when the data revision is unchanged so relative times and freshness continue to age. Each active schedule is fresh until 75% of its configured SLA, aging until the SLA, and stale after it. A bound revoked or never-run publisher is immediately stale and can never make the dashboard appear live; retained revoked records and historical run status remain visible for diagnosis, while schedule reconciliation is rejected. Partial and failed active schedules are also immediately stale. Every snapshot is read atomically. SQL deduplicates and orders the full eligible set, computes full summary counts, then batch-loads details for the highest-priority 200 cards. The UI reports when this is a bounded window; tokenized server-side full-text search still retrieves matching records outside it. View capabilities use a sliding 30-day lifetime and fail with an explicit reopen instruction after expiry.

Promoted and superseded runs persist normalized slice evidence. Publisher inventory and snapshots expose the latest promoted slice status with cadence-aware freshness; the dashboard shows compact unhealthy source badges and collapses fully healthy coverage to one line.

### Scheduled credential modes

With `credentialMode: "local_cli"`, Dyna requires an immutable source manifest and returns no secret. The scheduled job runs as the same macOS user and sends one bounded, schema-valid JSON run to the installed plugin's absolute `<plugin-root>/bin/flowzone-publish --publisher <uuid>` launcher over stdin. The publisher ID is fixed in the command rather than accepted from stdin. For unattended `workspace-write` schedules, use an exact Codex allow rule for that launcher, `--publisher`, and publisher ID; start the plain command in a PTY, write one compact JSON line followed by a newline, and then send EOF rather than using shell pipes, redirection, wrappers, or extra arguments. The launcher disables terminal echo before reading and fails closed if it cannot, so source records do not enter terminal output. Dyna validates source slices and records before changing the SQLite store. The launcher path and rule must be reconciled after installing FlowZone at a different path; it is not placed on the system `PATH`.

An existing manifest-backed publisher created in disabled mode can be transitioned idempotently with `enable-local-cli-publisher`, preserving its immutable native schedule identity and dashboard bindings.

This is intentionally a same-user trust boundary: any process running under that macOS account can publish through a registered `local_cli` publisher. Use `credentialMode: "disabled"` when that is not acceptable. `credentialMode: "local_preview"` remains an explicit non-production option that returns a model-visible secret and uses the MCP `publish-run` action.

### Local scheduled publication

The scheduled task normalizes records to this envelope and pipes it to the bundled launcher:

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

## Action protocol

For Slack, Outlook, GitLab, GitHub, Discord, Jira, Confluence, and other explicitly supported providers, the UI derives an `http` or `https` destination from the validated typed source identity. It never accepts an arbitrary URL from a publisher. The item title, inspector action, and provenance reference are real anchors, so normal open-in-new-tab, copy-link, and context-menu behavior works; a capable MCP Apps host receives the same derived destination through `openLink`. Source types without a verified portable URL, including Codex-only records, continue through the bounded opaque action flow below rather than inventing a link.

The browser never receives a native Codex session API. It prepares an allowlisted action through a capability-bound private tool and sends the current task only:

`Handle Dyna action request <request-id> with $flowzone:dyna.`

No source text, prompt, tool name, file path, or task transcript is included in that message. The `$flowzone:dyna` workflow claims the request once and receives immutable context plus a one-time completion token. It then uses the native Codex task tools and completes the state machine:

```text
PREPARED → DELIVERED → CLAIMED → SUCCEEDED
                               ├→ FAILED
                               └→ NEEDS_RECONCILIATION
```

Requests are bound to the dashboard revision, source fingerprint, item, task host, and a random per-attempt idempotency key. Ambiguous host delivery resends the same opaque request, and a remounted component recovers any matching nonterminal attempt from the server; a confirmed terminal result permits a deliberate new attempt. The controller atomically revalidates dashboard membership, revision, and fingerprint before claiming. Requests expire after ten minutes and claims have a five-minute completion lease; abandoned claims transition to `needs_reconciliation` on status inspection or before a new attempt. Claim and completion capabilities are 256-bit random values. Replays, stale screens, cross-dashboard status reads, regressive task observations, and action-incompatible completion payloads fail closed. Uncertain task creation places an item-scoped lock on new creation attempts until `resolve-action-reconciliation` links the verified native task or records that inventory verification found no created task. An item can retain at most eight linked Codex tasks. A claimed or uncertain creation reserves its final slot across competing status updates so a task already created by Codex cannot be stranded before its completion or reconciliation is recorded.

## Mobile and Remote acceptance

The Dyna surface is a compact attention ledger rather than a card wall. Each flat row presents a source mark and action title first, then the exact lifecycle or exception, relevant person, one-line attention reason, and a deadline only when one exists. Priority is carried by the queue section rather than repeated on every row; Progress carries lifecycle through its columns, so neither view renders a redundant four-step locator. A safe source title is a real anchor with native open-in-new-tab, copy-link, and context-menu behavior, while clicking the rest of the row opens details. Queue items move directly by pointer drag or arrow keys, and touch users get the same raise, lower, earlier, and later operations from a row-level Move control without opening details.

After the MCP Apps handshake, Dyna automatically requests `fullscreen` once and deduplicates simultaneous expansion requests. While Codex resolves that request, the required initial inline surface contains only a lightweight launch status rather than the working dashboard. MCP Apps exposes `inline`, `fullscreen`, and `pip`; it does not expose a left/right docking parameter, so Codex owns the outer app presentation. Within Dyna itself, details reserve space in a non-overlapping right inspector at 980 pixels and wider and become a focused route on narrow screens. Inline fallback shows five useful rows on a fine-pointer desktop when space permits and four on touch/mobile; rich mode adds the full queue, priority/source/workflow/leadership filters, all four progress groups at once, and to-do capture. Desktop actions remain immediately under the inspector heading, while touch hosts use a bottom action bar. Both modes preserve 44-pixel coarse-pointer targets, no hover-only actions, no horizontal table, light/dark support, CSS and host-provided safe-area insets, and reduced-motion support. Dyna intentionally bundles Oxanium for interface text, Geist Mono for compact operational metadata, and a Nord-derived dark canvas. These requested product choices are documented deviations from OpenAI's preference for host typography and system colors; semantic action, focus, contrast, safe-area, and responsive behavior still follow the host guidance. Full-text filtering tokenizes terms locally for immediate feedback, announces settled counts to assistive technology, and refreshes a server-filtered snapshot so records outside the 200-card window remain discoverable. An inline-only or rejecting host retains the complete Executive Brief, detail access, and an explicit retry when fullscreen was advertised. Hosts without server-tool capability receive a read-only dashboard, while hosts without text-message capability keep annotations, to-dos, priority changes, and provider links but disable only Codex-task handoff actions. The annotation and to-do sheets trap focus, dismiss with Escape, restore their triggers, and retain drafts after rejected saves.

A release is not considered mobile-ready from browser emulation alone. Acceptance requires the current iOS and Android ChatGPT mobile apps connected to a Codex Remote host:

1. Open a dashboard from a remotely running task.
2. Background and foreground the app; verify the snapshot catches up without duplicate cards.
3. Add an annotation with the software keyboard open.
4. Create a Codex task from a card, verify exactly one task appears, and open it from the refreshed card.
5. Add and reprioritize a to-do; verify it appears in both the queue and **To Do** pipeline column.
6. Move a linked task through running, waiting, and succeeded; verify the pipeline, task link, one-line outcome, and completed-to-follow-up path.
7. Interrupt connectivity during creation and verify the request becomes failed or needs reconciliation rather than silently succeeding.
8. Verify light/dark themes, large text, screen-reader labels, and 320-pixel-wide layout.

## Delivery plan

The implemented vertical slice includes strict contracts, the SQLite store, native schedule inventory, atomic publisher-isolated run slices, fingerprint-and-version-bound enrichment overlays, provenance-gated leadership ranking, retry-safe manual to-dos, dashboard-local priority and full-group sequence preferences with append-only history, server-backed full-text filtering, a bounded model-visible brief, the active priority queue, complete progress pipeline, durable searchable archive with undo and restore, annotations, publisher/binding/dashboard lifecycle controls, the leased one-time action protocol, existing-task attachment, conservative multi-session status aggregation and outcomes, completed and archived follow-ups, the dedicated UI resource, integration tests against the checked-in Node bundle, and Dyna-specific accessibility/action/reflow journeys on Chromium, WebKit, mobile Chromium, and mobile WebKit.

Before declaring the feature generally available:

1. Add a host-provided protected credential channel for scheduled publishers; until then, scheduled publishers remain disabled by default, with an explicit trusted local-preview escape hatch limited to single-user non-production data.
2. Back leadership lifts with a host-controlled VIP registry using stable identities or an opaque evidence capability from a trusted org adapter; until then, enrichment provenance is caller-attested.
3. Run the physical Remote acceptance matrix above, verify the host-selected panel location, and record host/app versions.
4. Expose backup retention and offline restore through a documented trusted-operator workflow; the verified store primitive is intentionally not a model-visible action.

The design follows the official [OpenAI plugin UI guidelines](https://developers.openai.com/plugins/concepts/ui-guidelines), [MCP Apps UI reference](https://developers.openai.com/plugins/reference), [scheduled tasks guidance](https://learn.chatgpt.com/docs/automations), and [Remote connections guidance](https://learn.chatgpt.com/docs/remote-connections).

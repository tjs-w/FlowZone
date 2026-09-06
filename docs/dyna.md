# Dyna executive dashboards

Dyna turns bounded output from recurring Codex jobs into persistent, mobile-friendly executive dashboards. It is bundled inside the FlowZone plugin and uses Codex's existing agent, connector, schedule, and task capabilities instead of introducing a second agent runtime.

## Product requirements

- One user can create many dashboards and many scheduled publishers.
- The relationship is many-to-many: one scheduled publisher can feed several dashboards, and one dashboard can aggregate several publishers.
- A job publishes normalized email, messaging, source-control, TWG, skill, or Codex records. It cannot publish HTML, JSX, JavaScript, CSS, prompts, MCP tool names, or a render tree.
- FlowZone compiles those records into a fixed, validated `json-render` catalog backed by Apps SDK UI components.
- New information can replace an existing item's separate enrichment overlay using both the expected source fingerprint and enrichment version. The overlay records its provenance and base source version, rejects concurrent replacement, and becomes visibly stale and inactive when the source changes underneath it.
- Users can add annotations or new to-dos at any time, search the full bounded record text, override a priority band, sequence items inside a band, and request a supported Codex action from a card.
- The priority queue and progress pipeline are two fixed projections of the same items. Completed work leaves the active priority queue and focus count but remains searchable in the pipeline for its outcome and follow-up. The pipeline groups unlinked items as **To do** and linked Codex tasks as **Executing**, **Paused for input**, **Needs attention**, or **Completed**, retaining every exact task link; every successful task requires a bounded one-line completion outcome.
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
      Dyna SQLite store ── snapshot ─┬─> pure compiler
            ▲                     │          │
            │ annotations/         │          ▼ validate
            │ enrichment           │   @json-render catalog
            │                     ▼
            └──── app-only tools ── Dyna MCP Apps UI
                                  dyna/ui-v5 snapshot only
```

The packages divide responsibility as follows:

| Package                     | Responsibility                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `@flowzone/dyna-contracts`  | Strict Zod records and snapshot-only UI payload; fixed catalog on the `/catalog` subpath  |
| `@flowzone/dyna-core`       | Deterministic priority ordering and snapshot-to-spec compilation                          |
| `@flowzone/dyna-node`       | SQLite persistence, capability tokens, action state machine, and snapshots                |
| `@flowzone/dyna-ui`         | Responsive React renderer, Apps SDK UI controls, annotations, polling, and host messaging |
| `@flowzone/mcp-server/dyna` | Model-visible actions, private app tools, and the dedicated presentation tool             |

The dedicated `render_dyna_dashboard` tool renders `ui://flowzone/dyna/v5.html`. It is separate from Markdown Review so Dyna does not inherit Mermaid's bundle weight or clipboard permission. Its combined checked-in HTML, JavaScript, and CSS budget is 750 KiB.

### UI component decision

Dyna deliberately uses three layers rather than a general-purpose component framework:

1. `@json-render/core` and `@json-render/react` provide the closed schema and component-catalog validation on the server. Each snapshot is deterministically compiled and validated before release, but the compiled component tree is discarded: the `dyna/ui-v5` wire carries only `schema`, `viewToken`, and `snapshot`. Scheduled output therefore cannot supply implementation code, styling, or arbitrary actions, and browser imports of domain contracts do not pull json-render.
2. `@openai/apps-sdk-ui` supplies Codex-native `Button`, `Badge`, `Input`, `Textarea`, `Alert`, icons, and theme integration. These reviewed controls inherit the host's visual language, focus behavior, and light/dark tokens without pulling a second design system into the app.
3. Small, semantic Dyna structures implement the product-specific attention ledger, five-stage rail, and responsive inspector. Native `select` and `details` elements cover the remaining simple semantics. Heavy generic menus, popovers, selectors, dashboards, and community registries stay off the mobile critical path.

The reviewed Apps SDK UI package does not currently provide dense ledger rows, a pipeline rail, a data grid, or a responsive side-inspector primitive. Pulling compound menu, popover, and form modules into this single-resource MCP App also pushed the aggregate artifact over its 750 KiB budget. Dyna therefore does not add shadcn/ui, another Radix bundle, CopilotKit, or Tambo. A ready-made primitive is adopted only when it adds behavior or host consistency that the native element cannot provide within the payload and touch-target budgets.

## Persistence and refresh

Dyna uses Node's built-in `node:sqlite` API and therefore requires Node 22.13 or newer. Its plugin-root-relative launcher prefers the Node runtime bundled with the Codex desktop app, then standard system locations; controlled hosts can set `FLOWZONE_NODE_PATH` to a trusted executable. The database lives under the operating system's per-user application-data directory, or under `FLOWZONE_DATA_DIR` in tests and controlled deployments. The connection enables WAL, foreign keys, and a five-second busy timeout. The formal schema is version 1: migration and integrity checks run transactionally, future versions and foreign-key-corrupt legacy databases fail closed, and rejected schema/data changes roll back. Verified point-in-time backups use SQLite's online snapshot mechanism, a private same-directory staging file, integrity and schema checks, mode `0600`, and no-overwrite publication; an offline restore is covered by the store tests. Mutations use prepared statements and revision increments; publisher secrets, view capabilities, and completion capabilities are stored only as SHA-256 hashes. Hashing protects the stored copy, not the one-time create/rotate result or a scheduled-task prompt: the current publisher credential flow is explicitly a trusted single-user local preview, not a production secret channel.

Each publisher is registered against its native Codex schedule ID, title, state, freshness SLA (`staleAfterMinutes`), and last-run result. A dashboard accepts at most 50 bound schedules. A successful `replace` run is an atomic full snapshot: omitted publisher memberships become inactive. `upsert` is available for explicit deltas. A `partial` run must use `upsert`, include at least one successfully gathered item and a bounded failure message, and never retires unseen records; Dyna promotes the good slice while visibly marking the source and aggregate dashboard stale. A fully failed run contains no items and preserves the last good slice. Public failure diagnostics are normalized to one line, redacted for common credential forms, and capped before persistence. Every publication supplies both a stable run ID and the schedule execution's `sourceCompletedAt`. The run ID and a canonical request digest deduplicate exact retries and reject conflicting reuse; the completion time prevents a delayed older execution from replacing a newer slice. Superseded runs are recorded but do not change the dashboard. Canonical identity is publisher-scoped so one scheduled authority cannot overwrite another. Scheduled records may carry bounded untrusted `people`, `attention`, `plan`, and `nextSteps` data, while only verified enrichment provenance can lift priority. Conversation-driven enrichment replaces those fields without mutating the source slice. User-created to-dos use dashboard-scoped request IDs for retry safety; priority/sequence choices are also dashboard-scoped, so both views update immediately without leaking preferences into another dashboard. Model-visible `search-items` returns at most 20 actionable records with stable IDs for non-UI clients and later enrichment. Publishers can be rotated, revoked, or revoked with record purge; bindings can be removed independently, and a dashboard can be purged after exact-ID confirmation.

An active visible component polls every 15 seconds and refreshes immediately when it returns to the foreground. Hidden or unfocused components back off to 60 seconds. Refresh responses include a new private snapshot even when the data revision is unchanged so relative times and freshness continue to age. Each active schedule is fresh until 75% of its configured SLA, aging until the SLA, and stale after it; a partial, failed, or never-run active schedule is immediately stale. Every snapshot is read atomically. SQL deduplicates and orders the full eligible set, computes full summary counts, then batch-loads details for the highest-priority 200 cards. The UI reports when this is a bounded window; tokenized server-side full-text search still retrieves matching records outside it. View capabilities use a sliding 30-day lifetime and fail with an explicit reopen instruction after expiry.

## Action protocol

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

The Dyna surface is a compact attention ledger rather than a card wall. Its roughly 82-pixel rows keep priority, source, workflow, deadline, decision context, leadership signal, and one **Details** affordance scannable without opening each item. Inline mode is a four-row executive brief; rich mode adds the full queue, priority/source/workflow/leadership filters, five-stage progress rail, to-do capture, and a desktop side inspector that becomes an in-flow detail surface on narrow screens. Both modes use 44-pixel mobile touch targets, no hover-only controls, no horizontal table, system typography, light/dark support, CSS and host-provided safe-area insets, and reduced-motion support. Full-text filtering tokenizes terms locally for immediate feedback, announces settled counts to assistive technology, and refreshes a server-filtered snapshot so records outside the 200-card window remain discoverable. Dyna respects the host-selected presentation and offers an explicit **Expand dashboard** action when the host advertises `fullscreen`. MCP Apps does not expose a left/right docking parameter: Codex owns exact panel placement, and the left-panel requirement must be verified against the target desktop build. Inline-only hosts retain the complete four-item brief and detail access; a rejected expansion leaves the current view and accessible retry feedback. The annotation and to-do sheets trap focus, dismiss with Escape, restore their triggers, and retain drafts after rejected saves.

A release is not considered mobile-ready from browser emulation alone. Acceptance requires the current iOS and Android ChatGPT mobile apps connected to a Codex Remote host:

1. Open a dashboard from a remotely running task.
2. Background and foreground the app; verify the snapshot catches up without duplicate cards.
3. Add an annotation with the software keyboard open.
4. Create a Codex task from a card, verify exactly one task appears, and open it from the refreshed card.
5. Add and reprioritize a to-do; verify it appears in both the queue and **To do** pipeline column.
6. Move a linked task through running, waiting, and succeeded; verify the pipeline, task link, one-line outcome, and completed-to-follow-up path.
7. Interrupt connectivity during creation and verify the request becomes failed or needs reconciliation rather than silently succeeding.
8. Verify light/dark themes, large text, screen-reader labels, and 320-pixel-wide layout.

## Delivery plan

The implemented vertical slice includes the contracts, compiler, SQLite store, native schedule inventory, atomic publisher-isolated run slices, fingerprint-and-version-bound enrichment overlays, evidence-bound leadership ranking, retry-safe manual to-dos, dashboard-local priority and full-group sequence preferences, server-backed full-text filtering, a bounded model-visible brief, the active priority queue and complete progress pipeline, annotations, publisher/binding/dashboard lifecycle controls, the leased one-time action protocol, existing-task attachment, conservative multi-session status aggregation and outcomes, completed follow-ups, the dedicated UI resource, integration tests against the checked-in Node bundle, and Dyna-specific accessibility/action/reflow journeys on Chromium, WebKit, mobile Chromium, and mobile WebKit.

Before declaring the feature generally available:

1. Add a host-provided protected credential channel for scheduled publishers; until then, publisher use remains a trusted local preview with non-production data.
2. Run the physical Remote acceptance matrix above, verify the host-selected panel location, and record host/app versions.
3. Expose backup retention and offline restore through a documented trusted-operator workflow; the verified store primitive is intentionally not a model-visible action.

The design follows the official [OpenAI plugin UI guidelines](https://developers.openai.com/plugins/concepts/ui-guidelines), [MCP Apps UI reference](https://developers.openai.com/plugins/reference), [scheduled tasks guidance](https://learn.chatgpt.com/docs/automations), and [Remote connections guidance](https://learn.chatgpt.com/docs/remote-connections).

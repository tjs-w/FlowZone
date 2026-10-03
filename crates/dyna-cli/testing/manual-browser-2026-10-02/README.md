# Manual internal-browser E2E — 2026-10-02

## Result

**Partial acceptance: three confirmed UI gaps; pointer drag remains unverified.**

The current Dyna UI was exercised interactively in the Codex internal browser. These are manual UI results, not a replay of the automated Playwright suite.

The browser harness uses isolated temporary data directories and real current TypeScript MCP/application/SQLite operations. Native Codex inventory, naming, synchronization and external-link opening are fixture host/controller simulations. This does **not** establish Rust CLI-backed UI cutover, real native session navigation, source authentication, or Mobile Remote parity.

No live dashboard, installed plugin, schedule, permission rule, production source file or lockfile was changed. Existing dirty source/build files were SHA-256 checked against the start-of-pass baseline and remain unchanged. Only this report and generated screenshots were added.

## Confirmed findings

### 1. Executive Brief misrepresents empty or Backlog-filtered results

- With search `nomatch-manual-e2e-xyz`, the page correctly says **0 search matches / Nothing matched**, but the Brief says **No action signals were found in the latest complete refresh**. The same dashboard contains active work; an empty search is not an empty collection result.
- With one item in Backlog, the Backlog filter correctly renders one card and `1/4 shown`, but the Brief says **0 filtered items** and uses the same misleading no-signals text.
- Confirmed source: `buildExecutiveSummary` selects its empty text from coverage without distinguishing an empty search/filter ([index.tsx](/Users/twanjari/gh/flowzone/packages/dyna-ui/src/index.tsx:4669)). `SnapshotDashboard` excludes Backlog cards before calculating the Brief's scope ([index.tsx](/Users/twanjari/gh/flowzone/packages/dyna-ui/src/index.tsx:4918)).
- Suggested correction: use search/filter-specific empty wording; represent Backlog scope honestly or explicitly state that the actionable Brief excludes deferred work.

![Empty search is incorrectly described as no collected action signals](/Users/twanjari/gh/flowzone/crates/dyna-cli/testing/manual-browser-2026-10-02/32-empty-search-proof.jpg)

![A visible Backlog item is counted as zero in the Brief](/Users/twanjari/gh/flowzone/crates/dyna-cli/testing/manual-browser-2026-10-02/06-backlog-filter-summary.jpg)

### 2. Linked items cannot be marked Done from their status menu

- An unlinked To Do item offers `To Do`, `Needs You`, `Backlog for 1 day`, and `Done…`; completing it correctly requires an outcome.
- Linked In Codex and Needs You items offer only their current stage and `Backlog for 1 day`. This occurs in Queue, Progress and the inspector.
- Confirmed source: the linked branch of [StatusSelect](/Users/twanjari/gh/flowzone/packages/dyna-ui/src/index.tsx:1333) intentionally omits Done.
- This conflicts with the requested distinction between explicit Dyna completion and separately observed native task success. A fix must close the Dyna item with an outcome without certifying native success or allowing a later sync to reopen it.

### 3. Done cards show the old next-action text instead of the outcome

- Item `:1:` was completed with **Manual E2E: reviewed release risk and recorded approval.**
- Its inspector and Recently Done brief show the outcome. Its Done card still says **Confirm the risk posture and either approve the release or name the blocker.**
- The original controller-completed fixture also retains generic old action text on its Done card.
- Confirmed source: card `rowDetail` prefers `workflowSummary`, attention and priority rationale, never the outcome ([index.tsx](/Users/twanjari/gh/flowzone/packages/dyna-ui/src/index.tsx:3193)).
- Suggested correction: prefer the one-line completion outcome for Done; use a clearly labeled missing-outcome fallback when no outcome is available.

![Done cards retain action text while the inspector has the completion result](/Users/twanjari/gh/flowzone/crates/dyna-cli/testing/manual-browser-2026-10-02/31-reloaded-completed-history.jpg)

## Passed manual checks

| Area                    | Interactions and observed result                                                                                                                                                                                                      | Evidence                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Queue and inspector     | Card body opens details; title activation does not open details. Desktop inspector is on the right and the main content shifts instead of being covered.                                                                              | `03-inspector-notes.jpg`, `11-follow-up-reference.jpg`                                    |
| Typography              | Computed styles: dashboard H1 uses Oxanium Variable at 20px; reading/section text uses Geist Variable; item IDs use Geist Mono Variable. Compact controls were visually inspected.                                                    | `01-dark-queue.jpg`, `17-light-four-sources.jpg`                                          |
| Notes                   | Add with Enter; Shift+Enter creates a newline. Edit with Enter, edited timestamp, delete confirmation, cancellation and confirmed deletion worked. Notes show date/time.                                                              | `02-centered-note.jpg`, `03-inspector-notes.jpg`                                          |
| Note modal              | Centered at default desktop and 480×900; 13px Geist input; no horizontal overflow. A narrow-screen note was successfully saved.                                                                                                       | `19-narrow-light-note.jpg`                                                                |
| Context menus           | Item right-click exposes item actions. Selected inspector text remains selected and receives a Copy selected text menu. Note actions expose Edit/Delete. No stacked Dyna menus observed.                                              | `12-selected-text-context.jpg`                                                            |
| Copied work prompt      | Browser clipboard contained v2 reference, item number and untrusted-context envelope; checked forbidden credential/token/database-path field names were absent. This is the current pre-cutover format, not the planned v3 reference. | Inspector copy action                                                                     |
| Source activation       | Title and Open source each caused one host open-link dispatch. Two clicks yielded two dispatches, not four. Source title click did not open the inspector.                                                                            | Harness DOM dispatch counters                                                             |
| Status filters          | Needs You, blocked, Backlog and total/shown controls filtered/reset the expected records. Blocked remains a condition, not an extra progress stage.                                                                                   | `06-backlog-filter-summary.jpg`, `23-blocked-condition-filter.jpg`                        |
| Full-text search        | Item IDs, including `:207:`, found the exact item. Artifact label and numeric `8842` matched older activity after the asynchronous search response completed. Empty results can be cleared.                                           | `24-artifact-search.jpg`                                                                  |
| Bulk organization       | Selected two items, moved both to Needs Attention, and observed one new dashboard revision and retained relative order.                                                                                                               | `05-bulk-priority.jpg`                                                                    |
| Backlog                 | Deferred a Needs You item for one day. It moved into Backlog, left the attention count, and returned explicitly to Needs You.                                                                                                         | `06-backlog-filter-summary.jpg`                                                           |
| Progress                | To Do, In Codex, Needs You and Done were visible together, with a separate Backlog section. No redundant per-card four-stage locator.                                                                                                 | `07-progress-four-lanes.jpg`, `30-final-progress.jpg`                                     |
| Dyna completion         | Unlinked item completion required a precise outcome and entered Done. Inspector labels direct Dyna completion separately from native task status.                                                                                     | `31-reloaded-completed-history.jpg`                                                       |
| Archive completed       | Archive now removed the item from Done and active total. Archive retained its number, note, outcome and source.                                                                                                                       | `09-archive-retained-context.jpg`                                                         |
| Archive active          | Archived a Needs You item as Duplicate, without implying completion. Active total changed 4→3 and need-you count 1→0. Immediate Undo restored the item and Needs You state.                                                           | `10-archive-undo.jpg`                                                                     |
| Restore                 | Confirmation was required. Restoring a completed item returned it to Done; restoring a light-theme No Action Needed item preserved its evidence, note and item number.                                                                | `21-mobile-light-archive.jpg`, `31-reloaded-completed-history.jpg`                        |
| Archive search/count    | Search by `:1:` found the archived item. Archive tab had no accumulating count; count appeared within Archive. Archived items were excluded from active counts.                                                                       | `09-archive-retained-context.jpg`, `21-mobile-light-archive.jpg`                          |
| Follow-up               | Created new item `:5:` from completed `:1:`. The original remained completed with its outcome and note. Expanded provenance shows Follow-up to `:1:`.                                                                                 | `11-follow-up-reference.jpg`                                                              |
| Standalone to-do        | Empty form disabled submission. Created high-priority item `:6:` with context and a new number.                                                                                                                                       | `15-session-associated-prefix.jpg`                                                        |
| Session picker          | Loaded recent sample sessions with host/status context. Linked local and remote sample sessions to `:6:`; both received exactly one `:6:` prefix. Already-linked session disappeared from subsequent choices.                         | `15-session-associated-prefix.jpg`                                                        |
| Session chooser         | Single session has a direct icon. Two sessions produce a chooser with separate exact `codex://threads/...` targets, status and host. Inspector retains both links. Actual native activation was not attempted for fake IDs.           | `16-multiple-session-chooser.jpg`                                                         |
| Cached-first Refresh    | Existing cards remained rendered; Add to-do stayed enabled while Refresh/controller work ran. Final fixture result updated three items and rendered Updated 3.                                                                        | `13-cached-sync-in-progress.jpg`, `14-sync-updated.jpg`                                   |
| Partial synchronization | Five cached cards stayed present. Final UI reported one unavailable task and one missing outcome. The unavailable task retained its prior blocked state rather than becoming unknown.                                                 | `25-light-sync-partial.jpg`                                                               |
| Work activity           | Task attribution, kind, date/time, append-only correction and retained earlier update rendered. Artifact activation produced one exact host dispatch. Textual completion remained In Codex pending controller observation.            | `22-work-activity-artifacts.jpg`, `24-artifact-search.jpg`                                |
| Correlated sources      | Jira, two MRs and Slack produced one `:1:` card with four distinct ordinary HTTP(S) links and collector-supplied relationship provenance. Slack dispatched its validated permalink once.                                              | `17-light-four-sources.jpg`, `18-correlation-provenance.jpg`                              |
| Separate source         | Exact MR separation required confirmation. Original `:1:` retained the other sources; separated MR got new `:2:`. Cited combined summary was labeled last known.                                                                      | Correlation inspector after separation                                                    |
| Partial source health   | Friendly Partially refreshed / Not refreshed / current labels replaced repeated error pills. Empty available data was not presented as a complete healthy source refresh.                                                             | `27-partial-source-coverage.jpg`                                                          |
| Narrow layouts          | Tested 480×900 and 390×844. At 390px, Progress stages stack; document width equals viewport width. Narrow inspector uses a full-page detail view with a Back control. These are viewport tests, not real touch/Mobile Remote tests.   | `19-narrow-light-note.jpg`, `20-mobile-width-progress.jpg`, `21-mobile-light-archive.jpg` |
| Dense dashboard         | Rendered 200 items, searched a low-ranked record, looked up its exact Dyna ID, and combined source/priority filters. This is usability coverage, not a launch-time benchmark.                                                         | `28-dense-200-items.jpg`, `29-dense-filter-controls.jpg`                                  |
| Reopen/persistence      | Reopened the cached fixture; item IDs, six-item total, task associations, completion outcome and edited note persisted. Checked successful fixture tabs had no captured console warnings/errors.                                      | `31-reloaded-completed-history.jpg`                                                       |

## Not accepted by this pass

- **Pointer drag:** genuine pointer drags in Progress and Queue did not move the item. The second Progress attempt used DOM-verified lane bounds; Queue also used verified source/target bounds. No synthetic drag events were injected to turn this into a pass. A physical-user check is still needed to distinguish an IAB automation limitation from a drag implementation defect. Bulk placement and status-menu alternatives worked.
- **Native integration:** real external-browser opening, modified-click/native copy-link menus, native Codex deep-link activation, actual title repair, real native task inventory/sync and Mobile Remote were not certified. The harness intercepts link opens and simulates native controllers.
- **Rust backend:** this UI still exercises the TypeScript backend. CLI-only adapters/skills, per-dashboard Rust databases, migration/recovery and production packaging cutover are not established by these results.
- **Time-dependent/source workflows:** no real 24-hour retention wait, live source outage/recovery, archived-source change ingestion or report generation was performed through the UI.
- **Broader gates:** this is not a Chromium/WebKit/Firefox matrix, full accessibility audit, security audit or quantitative latency run.

## Test setup notes

- Two ephemeral localhost harness servers isolated all state from the user's data. Harness host flags are used only for fixtures, never to claim real native behavior.
- `work-activity`, `correlated-sources` and partial-source fixtures require separate cases: activity fixtures expect five specific ordinary-card titles, whereas correlated-source fixtures consolidate different titles, and partial-source fixtures publish no initial cards. Combining those flags produced harness setup failures; compatible individual cases were then run successfully.
- Search is asynchronous. Artifact searches and search clearing were verified after semantic result waits, not solely from an immediate transient empty/narrow snapshot.
- There are 32 non-empty JPEG evidence files. `08-archive-completed.jpg` captures archive loading, not the settled archive; use `09-archive-retained-context.jpg` for the final result.
- The primary sample dashboard is left open in the internal browser. Fixture state is disposable and is not production data.

## Representative screenshots

![Centered light-theme note modal at 480px](/Users/twanjari/gh/flowzone/crates/dyna-cli/testing/manual-browser-2026-10-02/19-narrow-light-note.jpg)

![Four distinct contributing source links](/Users/twanjari/gh/flowzone/crates/dyna-cli/testing/manual-browser-2026-10-02/17-light-four-sources.jpg)

![Cached content remains available during Refresh](/Users/twanjari/gh/flowzone/crates/dyna-cli/testing/manual-browser-2026-10-02/13-cached-sync-in-progress.jpg)

![Progress stacks at 390px without horizontal overflow](/Users/twanjari/gh/flowzone/crates/dyna-cli/testing/manual-browser-2026-10-02/20-mobile-width-progress.jpg)

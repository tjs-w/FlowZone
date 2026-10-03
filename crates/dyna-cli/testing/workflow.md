# Workflow and data property tests

Date: 2026-10-02. This covers all three rounds of the newly authorized behavioral
test pass (maximum three material rounds), distinct from the closed review in
[REVIEW.md](../REVIEW.md).

Scope: the isolated Rust foundation. Every repository is created inside an
explicit `tempfile` directory. No installed store, plugin, worker rule, native
task or network is used. Only this report and
[workflow_properties.rs](../tests/workflow_properties.rs) were added by this
reviewer; production implementation and existing tests belong to root.

## Verification

Baseline read: [VALIDATION.md](../VALIDATION.md) records 71 default / 75 isolated
tests. Those counts are prior evidence, not a rerun by this reviewer.

```sh
rustfmt --edition 2024 crates/dyna-cli/tests/workflow_properties.rs
cargo test --offline --manifest-path crates/dyna-cli/Cargo.toml \
  --target-dir /private/tmp/dyna-workflow-cargo.YdB5Z2 \
  --test workflow_properties -- --nocapture
```

Final round-1 execution: **11 tests; 4 passed, 7 failed**; exit 101. Failing
assertions were retained as regressions, not ignored or changed to assert the defect.
The first execution had an incorrect dashboard-archive fixture revision; the
fixture was corrected and the full file rerun with the same result counts.

Round 2 after root fixes: **13 tests; 12 passed, 1 failed**; exit 101. All seven
round-1 regressions now pass. Added search-cursor coverage passes: 23 matches over
eight three-item pages without duplicates; total/truncated consistency; stale
query/scope/operation/revision rejection; limits 0 and 21 rejected; CLI accepts
limit and cursor. Rich search now prints both formats and returns every match.

The remaining failed test is
`equal_timestamp_permutations_keep_people_and_primary_source_stable`. Diagnostic
reexecution, without implementation changes, confirms three primary source refs/
labels and three capped people projections. This is remaining WF-2 coverage,
not a fourth material round.

Final round 3: **13 tests passed; 0 failed, 0 ignored**; exit 0. The unchanged
assertions pass after root's shared preferred-contribution selector and stable
people aggregation. `rustfmt --check` passed for the owned test file. No new
material finding remains reproduced in this examined workflow/data scope.

| Material round | Focused file result             | Disposition                                                           |
| -------------- | ------------------------------- | --------------------------------------------------------------------- |
| 1              | 4 passed / 7 failed (11 tests)  | Five new finding families reported                                    |
| 2              | 12 passed / 1 failed (13 tests) | Original failures fixed; primary source and people order still varied |
| 3              | 13 passed / 0 failed (13 tests) | All recorded regressions pass; review closed within its limit         |

The four passing tests cover:

- 125 combinations of three native task states, each under all six task orders
  (750 projections), including waiting/failed/unknown/succeeded precedence.
- Fifteen native-state/worker-condition pairs, worker observation equality,
  and manual stage timestamps at and before the latest observation.
- Atomic stale annotation versions and exact committed edit receipts after a
  later edit, item archive and dashboard rename; current notes remain intact.
- Completed-source merge, alias reads, rejection of writes through stale aliases,
  numbered follow-up creation, and original completion history.

## New material findings

### WF-1: source correlation drops explicit live lifecycle settings

Tests:
`source_correlation_preserves_explicit_backlog_from_a_merged_item` and
`source_correlation_preserves_explicit_manual_stage_from_a_merged_item`.

Reproduction:

1. Publish independent Jira `LIN-501` and MR 2 records, creating two cards.
2. Put MR 2 in Backlog until `2026-10-02T10:00:00.000Z`, or set its manual stage
   to `needs_you`, at `2026-10-01T11:00:00.000Z`.
3. Publish exact MR-to-Jira relationship evidence joining MR 2 to `LIN-501`.
4. Read the surviving card at the same instant.

Expected: one card retains the current deferral or explicit input request.
Actual: Backlog becomes absent (`null`, count 0); manual `needs_you` becomes
`todo`. Historical evidence remains, so this is loss of active workflow state,
not a claim that stored history was deleted.

Cause: `publication::merge` transfers completed/archive/task/activity/note
state but omits `backlog_until`, `manual_stage` and `manual_stage_at`.

Minimal fix: transfer a sole current Backlog and the most recent explicit
manual stage to the survivor. Resolve conflicting explicit settings
deterministically, while retaining completed/archive precedence and history.

### WF-2: equal-time source order changes displayed actions without a fingerprint change

Test: `equal_timestamp_correlated_record_permutations_keep_displayed_facts_stable`.

Reproduction: publish three MR records, all with the same `sourceUpdatedAt` and
proved Jira `LIN-501` identity. Give each different title, summary, attention,
plan and next step. Refresh them under all six input orders in the same fixture.

Expected: the identical evidence set selects the same displayed facts.
Actual: one source fingerprint and one card, but three distinct title/summary/
attention/plan/next-step projections. The last equal-ranked contribution wins.
For example, an unchanged source fingerprint displays either `Ship mr-1`,
`Ship mr-2` or `Ship mr-3`.

Cause: `publication::refresh_item` uses only Jira preference, freshness and source
timestamp when ranking contributions. `max_by_key` resolves ties by vector order,
which publication upserts change.

Minimal fix: use a stable provider-record identity tie breaker for preferred
facts and source selection. Preserve the existing semantic precedence before
that tie breaker. Verify source/enrichment fingerprints remain consistent.

Round-2 disposition: displayed facts and fingerprints are now stable. The new
extended test supplies three correlated MR records with eight distinct people
each and runs all six orders. The selected primary MR still varies between 1,
2 and 3; the capped eight-person projection also varies three ways. Source
navigation and the visible stakeholders can therefore change on an identical
evidence refresh. Leadership score/count remain 0, correctly, because declared
source provenance is untrusted for leadership promotion; no leadership-count
regression is claimed. Use the deterministic preferred contribution for the
primary source and deterministic aggregation before the eight-person cap.

Round-3 disposition: primary source, capped people, displayed facts and source
fingerprints remain stable across all six orders. The extended test passes.

### WF-3: full-text search operates on JSON serialization rather than user text

Tests: `full_text_search_matches_user_quotes_and_backslashes` and
`multiword_search_matches_terms_across_work_fields`.

Reproduction: create the title `Review "quoted" paths C:\work\repo`. Search both
`item search` and `dashboard snapshot` for `"quoted"` or `C:\work\repo`.

Expected: the exact text contained in the title matches the item.
Actual: zero matches for all four operation/query combinations.

Cause: `application::search_text` serializes the entire `Item` to JSON, escaping
quotes/backslashes; `snapshot` searches that encoding as a contiguous substring.

The second test also demonstrates zero results for `alpha omega` when the title
contains `Alpha` and the summary contains `Omega`. The shipping search explicitly
uses separate terms (`snapshotSearchTerms` in the graph), but strict adapter
parity is already an open cutover requirement. This term-matching assertion is
coverage within WF-3, not a separate new integration finding.

Minimal fix: build search text from decoded user/evidence string values and
canonical/alias item numbers. Apply normalized terms consistently to search and
snapshot, preserving exact-number ordering.

### WF-4: rich item search cannot produce a bounded result or continuation

Test: `rich_search_pages_fit_output_budget_and_return_every_match`.

Reproduction: seed 20 matching items, each with 32 distinct, validated GitLab
source references. Each project path is 493 characters, within the 512-character
contract, with multibyte Unicode. Each typed source reference is validated; the
fixture adds bounded persisted evidence through the public repository boundary. Read `item search`
with limit 20 and print either output format.

Expected: byte-bounded pages and a cursor that retrieve all 20 matches.
Actual: the application returns all 20 rich briefs; output fails with
`output_limit`: `Dyna result is too large; use pagination or a narrower query.`
Search ignores the accepted `limit`/`cursor` for page construction and provides
no continuation. Snapshot/evidence byte paging does not protect search.

This is a many-record result overflow, not the already documented oversized
single-history-record limitation. The test does not send one oversized CLI
publication payload; it constructs a valid rich persisted fixture.

Minimal fix: run search briefs through the existing byte-aware page builder,
bind the cursor to dashboard revision/query/scope/operation, and preserve total
match count. Confirm human and JSON output and complete cursor traversal.

### WF-5: publication receipts cannot replay after later inactive-state changes

Test: `publication_receipts_replay_after_publisher_revocation_or_dashboard_archive`.

Reproduction: commit one valid publication, then revoke its publisher or archive
the dashboard with the current revision. Retry the exact original publication.

Expected: the committed receipt returns `deduplicated: true`, its original
control/revision and accepted count, with no writes.
Actual: `forbidden` after publisher revocation and `dashboard_archived` after
dashboard archive. Other mutation receipts already replay before current
lifecycle checks, and the annotation/rename test confirms that behavior.

Cause: `application::publish` checks active dashboard and publisher state before
receipt lookup.

Minimal fix: retain operator/input validation, resolve the dashboard identity and
look up an exact committed receipt before new-publication active-state checks.
Fresh or conflicting requests must still respect current authorization/state.

## Scope limits and handoff

These are foundation behavior defects. Missing native/controller/discovery/
action protocols, source separation/Undo Merge, migration, production adapters,
binary installation and work-reference v3 remain the known
[CUTOVER.md](../CUTOVER.md) gaps; they are not reported as new bugs here.

No production fix was made by this reviewer. Root owns fixes and broad gates.
The final thirteen focused cases support approval within this tested foundation
workflow/data scope. All five recorded finding families are resolved by root's
changes; the reviewer did not change or weaken existing tests. Full-suite and
release gates remain root's responsibility. This pass is closed after the third
material round. No new review loop or production-cutover approval is implied.

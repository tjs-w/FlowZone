# Dyna Rust foundation: expert review and fixes

Review date: 2026-10-02. Scope: the uninstalled Rust foundation and disposable
fixtures, not the production backend or live Dyna store.

The user requested a new differentiated review pass after the initial foundation
implementation. Three reviewers covered storage/recovery, security/work rules,
and workflow/correlation. Root implemented the fixes; reviewers made no source
changes. This pass used three material rounds for storage and workflow and two
for security. No additional review loop is required.

## Findings and disposition

| Finding                                                                                  | Fix and verification                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Completed originals could be reopened or have outcomes overwritten through stage changes | Reject fresh stage changes on completed work; preserve exact replay. Operator and linked-worker regressions cover both Dyna and native completion, unchanged evidence/history/revision, and numbered follow-ups.                                                     |
| Multi-target messages could merge independent work depending on publication order        | Process work anchors first and require every target to resolve to one established anchor. All six input permutations preserve separate work; a common Jira anchor still merges. Previously ambiguous messages can join once later evidence proves the common anchor. |
| Expired Backlog remained on cards after its count expired                                | One timestamp-aware projection is used by cards, item reads and counts. Exact expiry, resume, completed work and archive/restore are tested without erasing history or churning revision.                                                                            |
| A newer retired/failed contribution made a newly accepted summary look stale             | Acceptance and rendering share the current-citation selector. Current source links/freshness take precedence over unavailable evidence. Real changes to cited facts still make the summary last known.                                                               |
| Missing committed item rows were accepted by integrity and backup replay                 | Validate allocations in both directions; committed items must exist. Reserved gaps remain valid. Live integrity, new backups and replay of damaged backups are tested.                                                                                               |
| Backups accepted foreign-key corruption                                                  | Run page and foreign-key integrity checks on every copied database; failures never produce a complete manifest. Creation and replay are tested.                                                                                                                      |
| Stored dashboard names could issue terminal control commands                             | Escape C0/C1/DEL and directional controls in human labels and picker output. OSC52, ordinary Unicode and unchanged JSON round-tripping are tested.                                                                                                                   |
| Rich snapshots and evidence pages could exceed stdout limits                             | Byte-aware pages expose total, truncated and nextCursor. Snapshot cursors are revision/query/scope-bound. Rich cards/history are retrieved completely across bounded pages in both human and JSON output. The final newline is included in the output limit.         |
| A non-fixture binary could ignore the fixture environment and select production storage  | Fail closed when fixture storage is requested without the debug fixture feature. Release builds still reject that feature; process regression verifies no fixture directory is created.                                                                              |
| Stricter allocation validation could hide unrelated healthy dashboards                   | Classify logical corruption as dashboard-local unavailability before recovery. Reopening, healthy reads/writes, damaged reads, integrity, backup and recovery counts are tested.                                                                                     |
| Source upserts could reorder evidence and silently skip the next source page             | Bind source cursors to revision and return stale_cursor after a refresh. Restarting returns every source. Activity/history retain append-stable cursor behavior.                                                                                                     |

Storage defects were reproduced by deliberate valid-SQLite fixture corruption;
no ordinary-operation data-loss trigger was established.

## Final reviewer disposition

- Storage/recovery: foundation-only approval; 11 focused repository tests passed.
- Security/work rules: no remaining material findings; isolated standalone and
  production fixture-environment tests passed.
- Workflow/correlation: foundation-only approval; 17 focused publication,
  Backlog, pagination and activity tests passed.

The approvals apply only to the reviewed isolated foundation. They are not
approval to migrate, package, install, grant worker rules or switch the backend.

## Remaining plan gaps

The [cutover checklist](CUTOVER.md) is still open. In particular, production
MCP/publisher/skill workflows still use the existing TypeScript gateway. Actual
legacy data conversion and coordinated restore, native/controller/view/action/
sync/discovery protocols, reversible source corrections, strict adapter parity,
work-reference v3 and binary/rule packaging remain unfinished.

Paged reads can reject a single exceptionally large historical record with a
static output_limit error; they never discard its stored evidence or claim an
empty successful page. Complete legacy-history projection and adapter handling
of paged snapshots still require cutover acceptance tests.

No live store was changed. No dependencies, worker rules or installed plugin
were changed. Nothing was pushed, merged, installed or reloaded.

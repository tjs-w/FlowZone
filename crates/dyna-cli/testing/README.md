# Differentiated Dyna testing and fixes

Date: 2026-10-02. Scope: the **uninstalled Rust foundation**, not the live store
or CLI-only production cutover. The user requested this new test/fix pass after
the preceding expert review. Three independent agents used disposable fixtures;
root implemented source fixes and integrated verification. No pass exceeded
three rounds.

## Testing tracks

| Perspective                                | New tests                | Final focused result                       | Evidence                                                                                     |
| ------------------------------------------ | ------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Persistence, recovery and concurrency      | `storage_stress.rs`      | 10 isolated / 6 default passed; two rounds | [Storage report](storage.md)                                                                 |
| Executable CLI security and protocol       | `cli_adversarial.rs`     | 14 isolated passed; three rounds           | [CLI report](cli.md)                                                                         |
| Workflow, correlation and property testing | `workflow_properties.rs` | 13 passed; three rounds                    | [Workflow report](workflow.md)                                                               |
| Root: large dashboard reads                | `scale.rs`               | 1 passed                                   | 241 rich cards retrieved once each through 7 byte-bounded pages, with stable counts/revision |

The pass adds 38 test functions in isolated mode. Workflow tests additionally
exercise all 125 three-task state combinations in six association orders.
Concurrency tests use 24 actual processes for identical and conflicting request
replays. Executable tests use a cleared environment, empty `PATH`, copied binaries
in Unicode/space paths, isolated data homes, real stdin/stdout and PTYs.

## Confirmed finding families and fixes

1. An unavailable pending create/rename hid healthy dashboards. Recovery now
   retains failed local intents and reports dashboard-local unavailability;
   restoration resumes the original rename exactly once.
2. A committed task owner could lose its durable binding without failing
   integrity or backup replay. Reverse checks require the canonical binding,
   while allowing uncommitted reservation gaps and valid merge redirection.
3. Human JSON reads emitted nested C1 and directional controls. Shared valid JSON
   escapes prevent terminal commands/spoofed display and preserve exact data on
   parsing. Page budgets account for escape expansion, including the newline.
4. Domain errors returned the storage/internal exit code. Invalid operations use
   exit 2; stale/archive/identity conflicts use exit 4. Static errors, empty
   mutation stdout and atomic rejection remain intact.
5. Source correlation dropped explicit Backlog/manual-stage choices. Merges
   preserve the later deferral and latest manual stage, retaining both originals
   in merge history; existing manual priority is not lost.
6. Equal-time records changed facts, capped stakeholder lists and source
   navigation under reordering despite one fingerprint. A shared stable preferred
   source and deterministic contribution ordering keep those projections aligned.
7. Search matched JSON-escaped text and treated multi-word input as one phrase.
   It now searches actual values and requires all whitespace-separated terms,
   including across different work fields.
8. Rich search results exceeded stdout bounds. Search is byte-paged with at most
   20 briefs and supports `--limit`/`--cursor`; query, scope, operation and revision
   changes invalidate the cursor instead of silently skipping work.
9. Committed publication retries failed after publisher revocation or dashboard
   archive. Exact receipt lookup now precedes current-state rejection; fresh or
   conflicting requests still fail without partial writes.

CodeGuard informed input-validation, redaction, terminal-display and scoped-worker
tests. Fixtures contain no credentials, private source bodies or certificate/key
material. No OAuth, Keychain, new dependency, server or credential layer was added.

## Integrated gates

See [validation](../VALIDATION.md) for final Rust, package and audit results.
The test pass preserves baseline UI/E2E/harness/bundle, lockfile and user-owned
instruction changes by checksum. Existing browser results are historical and
exercise the unchanged shipping backend; no new native/browser parity claim is
made for Rust. Debug scale measurements are not useful-content launch budgets.

## Remaining gaps and authority

The [cutover checklist](../CUTOVER.md) remains open: actual legacy conversion and
coordinated restore, native/controller/view/action/sync/discovery protocols,
reversible source corrections, strict CLI-backed MCP/publisher/skill adapters,
work-reference v3, rules and packaged binaries still require implementation and
acceptance. In particular, executable worker tests verify rejected/spoofed
association; successful native association is not available through this CLI
yet and is not simulated.

No live database, installed plugin or worker permission was changed. Nothing was
pushed, merged, installed or reloaded. Full production cutover, fresh JavaScript
dependency remediation and native desktop/Mobile Remote acceptance are not
implied by this foundation-only verification.

# Dyna executable adversarial test report

Date: 2026-10-02. Final disposition: **14 executable tests passed; no remaining
material finding in this pass's tested scope.** This covers the isolated Rust
foundation, not production cutover or native integration acceptance.

The starting [review](../REVIEW.md) and [validation](../VALIDATION.md) record 71
default and 75 isolated tests. This pass adds
[cli_adversarial.rs](../tests/cli_adversarial.rs) and uses actual subprocesses
without network, dependencies, installed plugins, worker rules, or live storage.
Root implemented the production fixes; this tester owns only the new test file
and this report.

## New reproduced failures and fixes

### Nested human output could carry terminal controls

Severity: medium. Human `item show`, `dashboard snapshot`, and `item history`
emitted raw C1 and directional controls from stored titles and annotations.
Dashboard labels were already protected, but the generic pretty-JSON renderer
was not. Untrusted evidence could therefore change a human terminal's visual
presentation. This is an output-encoding defect; stored source text is valid
data and must remain available unchanged through JSON.

Executable reproduction:

1. Create a disposable dashboard and a todo whose title contains
   `Visible 雪\u009b31m\u202espoof\u202c\u2066isolated\u2069`.
2. Add an annotation containing
   `Note 雪\u009d52;c;fixture\u009c\u200fspoof`.
3. Read the item, dashboard snapshot, and item history without `--json`.

Before the fix, raw U+009B, U+009C, U+009D, U+200F, U+202C, U+202E, U+2066 and
U+2069 were present in human stdout. Expected: encoded terminal-safe text,
ordinary Unicode retained, valid JSON with unchanged values after parsing.

The minimal fix is one shared safe pretty-JSON representation used by both
human output and byte budgeting. Root implemented it in
`src/contracts.rs:20`, `src/cli.rs:394`, and `src/application.rs:1239`.
`human_item_snapshot_and_history_escape_nested_terminal_controls` verifies
all three read surfaces. `escaped_control_rich_snapshots_fit_human_budget_and_round_trip_source_text`
creates eight items with twenty 1,000-character annotations each, checks the
expanded human pages stay within 512 KiB including the newline, parses them
back to the same source values, and retrieves every item across the pages.

### Public domain errors were classified as storage/internal failures

Severity: medium for scripted error handling. The error JSON identified the
request or conflict correctly, but the process returned exit 1, documented as
storage/internal failure. A caller could not reliably choose request correction
or a fresh context read from the advertised exit classes.

Each row below was reproduced with the round-1 isolated executable. All failed
commands emitted empty stdout and a static error diagnostic. The final tests
also verify rejected work/publication leaves durable state unchanged.

| Trigger                                                           | Error code                 | Before | Expected and final |
| ----------------------------------------------------------------- | -------------------------- | ------ | ------------------ |
| Create a follow-up for active, unarchived work                    | `invalid_lifecycle`        | 1      | 2                  |
| Archive without the required confirmation field                   | `confirmation_required`    | 1      | 2                  |
| Enrich ordinary work to critical without critical source evidence | `invalid_priority`         | 1      | 2                  |
| Reuse a snapshot cursor after changing dashboard revision         | `stale_cursor`             | 1      | 4                  |
| Update an archived item                                           | `item_archived`            | 1      | 4                  |
| Create work on an archived dashboard                              | `dashboard_archived`       | 1      | 4                  |
| Reuse a publication external ID for a different provider identity | `record_identity_conflict` | 1      | 4                  |

The minimal fix is a consistent mapping in `src/error.rs:29`. Root applied the
mapping and additionally classified `title_sync_needed` as conflict and
`output_limit` as invalid input. The latter two additions were not separately
reproduced by these executable tests; they are source-inspected changes.

## Verification

Every test copies the feature-built executable to a path containing spaces and
Unicode, clears its environment, supplies an empty `PATH`, and selects a unique
disposable `DYNA_ISOLATED_TEST_HOME`. `CARGO_BIN_EXE_dyna` identifies the built
binary; no unqualified `target/debug/dyna` or actual account data-home command is
used. The test file is disabled unless `isolated-tests` is enabled.

The focused command was:

```sh
cargo test --offline --manifest-path crates/dyna-cli/Cargo.toml --features isolated-tests --target-dir /private/tmp/dyna-cli-adversarial-target.rVZQoG --test cli_adversarial -- --nocapture
```

| Round | Result                                | Interpretation                                                                                                                                                                                                                                                    |
| ----- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | 9 passed, 3 failed; 12 tests          | Two production defects above. The third failure was an incorrect test expectation that `codex status` fails; it correctly succeeds with `available:false` and `state:unavailable`. Additional round-1 binary probes reproduced the four conflict classifications. |
| 2     | 12 passed, 2 failed; 14 tests         | Both production fixes passed. Two comparisons incorrectly included different `generatedAt` values from independent reads. Only that top-level presentation timestamp was removed from equality checks.                                                            |
| 3     | **14 passed, 0 failed; 9.70 seconds** | All final assertions passed. No fourth round is needed.                                                                                                                                                                                                           |

`rustfmt --edition 2024 --check crates/dyna-cli/tests/cli_adversarial.rs` passed.
The full crate/default suite, Clippy, packaging, and production gates are owned
by the root validation pass and are not claimed by this focused result.

The passing tests cover:

- Rejected duplicate/unknown/oversized argv, numeric bounds and unsupported
  commands, with no fixture store initialization or raw argument disclosure.
- Empty/non-object/multiple JSON values, equivalent escaped duplicate keys,
  lone surrogates, invalid UTF-8, BOM, pipe EOT, NUL, and 32 KiB overflow, with
  unchanged dashboard state and no consumed work number or request receipt.
- Acceptance of exactly 32 KiB with 200 Unicode title characters and 1,000
  summary characters; rejection of one extra byte.
- Correctable semantic create rejection followed by one successful creation
  and an exact replay.
- Not-found, stale, forbidden and domain/conflict exit classes; truthful native
  unavailable metadata.
- Unlinked worker rejection, operator task-attribution spoofing rejection,
  static diagnostics, and zero activity/state changes from rejected work.
- Exact replay after later work and dashboard rename/UUID selection;
  conflicting request reuse rejected without additional activity.
- Successful writes whose stdout pipe fails: static `output_unavailable`, no
  private summary echo, exact retry returning the single committed item, and
  unchanged numbering.
- Plain and control-rich multibyte evidence pagination, complete item coverage,
  byte bounds, human control escaping and unchanged JSON source text.
- Rejected malformed PTY JSON with EOT: no submitted-body echo, ECHO/ICANON
  restored, bounded error, and no fixture store initialization.

CodeGuard guidance focused the tests on allowlisted input, attribution, output
encoding/redaction and fixture isolation. Submitted markers are synthetic test
data, not credentials. No cryptography or certificate operation was introduced.

## Coverage boundary

The exposed executable cannot create or controller-verify a native task link.
Consequently this pass proves rejection of unlinked/spoofed workers, not a
successful linked-worker/native integration workflow or title-sync recovery.
Those remain cutover acceptance coverage, as described in [CUTOVER.md](../CUTOVER.md).
Storage corruption/recovery, symlink/hardlink policy, adapters, live deployment,
and installed rule grants are outside this tester's scope. No production
storage, plugin, rule or external service was changed.

# Rust foundation validation

Status on 2026-10-02: **isolated foundation, not production cutover acceptance**.
The installed plugin, live database, TypeScript adapters and skill are unchanged.

## Rust implementation

| Gate                        | Result                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formatting                  | `cargo fmt --check` passed                                                                                                                           |
| Clippy                      | All targets with isolated tests; warnings denied; passed                                                                                             |
| Default test suite          | 91 passed                                                                                                                                            |
| Isolated-process test suite | 113 passed                                                                                                                                           |
| Release build               | Passed offline; binary is 3,428,288 bytes                                                                                                            |
| Release runtime inspection  | macOS system libraries only; no Node, Bun or dynamic SQLite dependency                                                                               |
| RustSec audit               | Cached scan of 1,279 advisories found no vulnerabilities in 82 packages; no-fetch, stale database permitted, yanked-crate checks explicitly disabled |
| Architecture                | SQLite confined to the repository; application/projectors transport-independent                                                                      |

The isolated-process tests include complete ordinary operator workflows with an
empty `PATH`, an otherwise cleared environment, Unicode/spaces installation
paths, publication/source retention, schedule-binding metadata, exact retries
after multi-process contention, PTY non-echo and signal restoration. All files
used by those tests are disposable fixtures, not the installed Dyna store.

Storage, work/security and cutover reviewers completed three material review
loops during the initial implementation. The later explicit review request
authorized a separate pass of at most three rounds. All three differentiated
reviewers approved the resulting fixes within their foundation-only scope; the
[review record](REVIEW.md) captures the defects and regression evidence. No
further loop or production approval is implied.

The latest explicit testing request then authorized a separate differentiated
test/fix pass, again capped at three rounds. Storage, executable security and
workflow/property agents added 37 test functions; root added one scale test.
All 38 new isolated tests pass. The [testing record](testing/README.md) links exact
reproductions, fixes, commands, coverage boundaries and the final dispositions.
The final 91/113 counts above are full integrated reruns after the last source
fix, not sums of selected earlier reviewer executions.

## Existing FlowZone regression gates

| Gate                                      | Result                                                                |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `bun run check`                           | Passed; 459 tests plus format/lint/types/build/license/package checks |
| Chromium/WebKit desktop/mobile matrix     | 497 passed, 9 skipped, 2 WebKit teardown timeouts                     |
| Isolated reruns of the two timeout cases  | 8 passed across desktop/mobile WebKit, repeated twice, one worker     |
| Launch-time performance gates             | 4 passed                                                              |
| Firefox archive/search/context/link smoke | 17 passed                                                             |
| Generated bundle parity                   | Passed against the existing backend                                   |
| `git diff --check` and `graft build`      | Passed                                                                |

The latest full matrix used two workers. Its failing cases were dark-theme work
activity and editable-note/native-status rendering; isolated reruns passed with
unchanged assertions and timeout settings. The full matrix is **not** recorded
as a clean pass. These browser and package gates exercise the existing shipping
backend, not a Rust adapter or native integration.

`bun run check` was rerun in this test pass and passed all 459 tests and release
checks. Browser results above are from the earlier implementation validation;
the matrix was not rerun for this Rust-only pass. Checksums confirm that the
pre-existing UI source, E2E fixtures and generated Dyna bundle were unchanged.

## Security and remaining delivery work

The existing JavaScript dependency audit reports six high-severity findings in
transitive `brace-expansion` and `fast-uri`. No dependency or lockfile updates
were made. Compatible public-npm patch resolution was denied by the approval
reviewer because it would disclose dependency names/versions to that registry;
the requested user approval remains pending. No alternate fetch or indirect
workaround was used.

The [cutover checklist](CUTOVER.md) remains authoritative: complete legacy
migration/shared-card splitting and receipt compatibility, coordinated restore,
source corrections, controller/view/action/sync/discovery protocols, verified
native integration or the approved fallback, CLI-backed MCP/publisher/skills,
work-reference v3, binaries/notices/rules and differential acceptance are still
required. The current read-only migration preview does not perform any of those
data conversions.

Nothing was pushed, merged, installed, reloaded or migrated on the live store.

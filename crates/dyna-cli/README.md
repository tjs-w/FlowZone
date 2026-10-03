# Dyna Rust backend foundation

Implementation status: **isolated foundation, not a production cutover**.

This crate implements standalone Dyna work management in Rust. It uses bundled
SQLite directly and does not start Node, Bun, MCP, an AI runtime, a daemon, an
HTTP service or a scheduler. Only the repository module accesses SQLite. The
application, publication, evidence and migration-planning modules are
transport-independent.

The installed FlowZone launcher, TypeScript backend, MCP adapters and skill are
still unchanged. The crate is not yet packaged or installed. Do not replace the
installed launcher with this binary or treat these tests as end-to-end cutover
acceptance.

## Implemented and tested

- Explicit named dashboards, bounded discovery, terminal selection, UUID/key
  routing, key aliases and recoverable database rename.
- Independent dashboard files; append-only global number allocations and
  task-ownership/work-attempt reservations in a metadata catalog.
- Standalone operator work updates, corrections, completion, enrichment, notes,
  organization, backlog, archive, restore, to-dos and follow-ups.
- Linked-worker validation against an existing verified binding. No invented
  native task attribution or inferred native success.
- Typed source publication, proved cross-source correlation, stale-source
  retention, retirement, merge history, alias search and cited summaries.
- Idempotent receipts, optimistic checks, transaction rollback, static errors,
  32 KiB stdin, 512 KiB stdout and PTY non-echo/terminal restoration.
- Catalog initialization/rename recovery, unavailable-database reporting,
  coordinated backups, integrity checking and a read-only v14 migration preview.

See [the cutover checklist](CUTOVER.md) for incomplete requirements.
The [expert review record](REVIEW.md) captures this pass's findings, fixes,
regressions and foundation-only approvals.
The subsequent [differentiated test pass](testing/README.md) records crash,
adversarial-executable and workflow/property regressions.

## Development verification

```sh
cargo fmt --manifest-path crates/dyna-cli/Cargo.toml --check
cargo clippy --manifest-path crates/dyna-cli/Cargo.toml --offline --all-targets --features isolated-tests -- -D warnings
cargo test --manifest-path crates/dyna-cli/Cargo.toml --offline
cargo test --manifest-path crates/dyna-cli/Cargo.toml --offline --features isolated-tests
cargo audit --file crates/dyna-cli/Cargo.lock
cargo build --manifest-path crates/dyna-cli/Cargo.toml --release --offline
```

`isolated-tests` enables a **debug-only** fixture data home used by process tests.
Release builds reject that feature. Production commands have no database-path or
runtime-selection flag and ignore caller-selected home/runtime environment
variables. Ordinary data commands use the existing account-owned Dyna data home.
Setting the fixture-home variable on a non-fixture build fails closed rather
than falling back to production storage. Every human-readable result escapes
terminal and directional controls while preserving normal Unicode. Human JSON
uses valid Unicode escapes and round-trips to the original data; page budgets
account for this expansion.
An existing legacy store causes `migration_required`; no automatic conversion or
number reset is attempted. A missing catalog in an initialized store also fails
closed.

The executable workflow tests copy the binary to a path containing spaces and
Unicode, clear the process environment, and set an empty `PATH`. They exercise
ordinary work updates, annotation versions, patch enrichment, bulk placement,
backlog, completion, archive/search/restore, follow-ups, history pagination,
publication and source retention, schedule-binding metadata, dashboard aliases,
backup and integrity checks. Concurrent processes also prove that retrying an
exact request after a `busy` response preserves one item and its global number.
These tests do not connect to Codex or a source provider and do not replace the
remaining migration/controller/adapter acceptance tests.

`maintenance migration-plan --json` reads only bounded v14 identity metadata and
returns proposed dashboard keys, independent item copies, ownership counts and
a metadata fingerprint. It does not read source bodies, notes or transcripts,
rename tasks, allocate numbers, create a catalog or perform a migration. Proposed
copy numbers are not reserved. The result explicitly reports
`readyForCutover: false`.

## Command surface

Run the built executable with `--help` for exact flags. Human output is the
default; `--json` gives a versioned envelope. Mutations take one strict object on
stdin. Dashboard selection is always explicit, with `--dashboard <key-or-UUID>`;
the terminal picker never changes a global default.

The implemented nouns are `dashboard`, `item`, `work`, `annotation`, `organize`,
`lifecycle`, `todo`, `follow-up`, `publisher`, `publication`, `schedule` and
`maintenance`. Old mutating `item update/enrich/place/archive/restore` commands
remain rejected. Schedule commands manage Dyna binding metadata, not a native
scheduler. `codex status` reports unavailable; no native operation is simulated.

Read commands may intentionally return bounded work content. Mutation results
return control metadata, never submitted bodies, outcomes, source content,
credentials, SQL or filesystem paths.

`dashboard snapshot --limit N --cursor C` pages at most 200 cards, and
`item search --limit N --cursor C` pages at most 20 operational briefs. Rich pages
may contain fewer to honor the 512 KiB output bound. Search matches actual text,
including quotes and backslashes, and requires every whitespace-separated term
to occur somewhere in the item. Snapshots, search and paginated evidence reads
expose `total`, `truncated` and `nextCursor`. Restart a read on
`stale_cursor`: snapshot/search cursors bind revision, query and scope; source cursors
bind revision so refresh cannot silently skip reordered evidence. Activity and
history cursors remain anchored across new appended entries. A single record
larger than the safe output bound fails without echoing it or deleting it.

Completed originals cannot be reopened or have their completion overwritten by
fresh stage changes. Continued execution requires a linked follow-up; annotations
and dispositions retain their existing rules. Backlog expiry is projected using
the same time for counts and item/card output, without erasing the deferral's
history.

# Persistence, recovery, and contention test pass

Date: 2026-10-02. Scope: the uninstalled Rust foundation and disposable SQLite
fixtures. This pass does not establish production cutover acceptance. Live
storage, installed plugins, worker rules, dependencies, and network state were
not touched. The tester changed only `tests/storage_stress.rs` and this report;
root owns the production fixes in `src/repository.rs`.

The baseline review and validation documents were read before testing. Their
reported 71 default / 75 isolated tests were prior results, not rerun counts for
this focused suite.

## Findings, reproduction, and verified fixes

### Pending dashboard recovery could hide unrelated healthy dashboards

Two deterministic fixtures reproduced the same isolation failure:

- `unavailable_pending_rename_does_not_hide_healthy_dashboard_and_can_later_recover`
  creates two independent dashboards and one item in each, seeds the exact
  pending rename intent/key/receipt/catalog state that exists after the first
  rename commit, and temporarily withholds only the old database file. Before
  the fix, `SqliteDynaRepository::open` returned `recovery_required` with
  `A Dyna rename is incomplete; restore its coordinated backup.` The healthy
  dashboard could no longer be selected through a new CLI invocation.
- `unavailable_pending_creation_does_not_hide_healthy_dashboard` leaves one
  dashboard in `creating` with its receipt unfinished and changes only its
  disposable database schema version to 16. Before the fix, opening the whole
  store returned `schema_mismatch`, also hiding the healthy dashboard.

Expected behavior is local unavailability: retain the failed intent, reserved
keys and unfinished receipt; report one unavailable dashboard; continue healthy
reads and writes; reject integrity and complete backups while the damaged
dashboard remains unavailable. A later restoration of the original rename file
must finish the original intent once, preserve item IDs and global numbers, and
deduplicate the original request.

Root changed `recover_locked` to contain failures per creation/rename rather
than aborting the repository open. Round 2 passes both regressions. In the rename
fixture, healthy work receives global number 3 while the damaged dashboard is
unavailable; restoring the withheld file resumes the rename at exactly one
additional revision and its retry returns `deduplicated: true`. No complete
backup manifest is produced during the unavailable phase.

### Integrity and backup replay accepted lost committed native task bindings

Both regressions first use repository operations to reserve a native task and
persist its binding so the catalog ownership state becomes `committed`. They
then remove only the task binding from the item's `linkedTasks` JSON payload.
The physical SQLite integrity check remains `ok`; item allocation and identity
are unchanged.

- `committed_task_without_durable_binding_fails_integrity_and_new_backup`
  alters the live disposable dashboard. Before the fix, integrity returned
  `valid: true` despite the orphaned committed owner.
- `backup_replay_rejects_a_lost_committed_native_task_binding` creates a valid
  coordinated backup and alters only its copied dashboard payload. Before the
  fix, retrying that backup ID returned `complete: true` and deduplicated the
  damaged copy.

Expected behavior is a reverse ownership check: every committed catalog task
owner must have its durable binding on the corresponding canonical item.
Verified merge redirection is valid, as are uncommitted reservation gaps.

Root added this reverse check to `finalize_numbers`, which is shared by
availability, integrity and copied-backup validation. Round 2 passes both
regressions: live corruption is dashboard-local unavailability, integrity/new
backups fail, and an altered backup cannot replay as complete.
`uncommitted_native_task_reservations_remain_valid_recovery_gaps` confirms that
an unattached reserved task survives reopen and remains valid for integrity,
backup and exact reservation retry.

These defects required deliberately unavailable/corrupted fixture state. No
ordinary-operation trigger for lost native task bindings was established.

## Additional exercised behavior

The other five tests passed before and after the fixes:

- Rename recovery after the physical file move, and after the dashboard state
  commit but before catalog finalization. Reopening twice and retrying through
  the old alias preserve the UUID, items, healthy neighbor and exactly one
  revision increment.
- Twenty-four processes sending the identical todo request commit exactly one
  item, allocation, receipt and history event. Every result retains the original
  control metadata; later exact retry deduplicates.
- Twenty-four processes split between two bodies with the same request ID
  retain one winning body and return twelve `request_conflict` results, without
  an extra allocation or revision.
- Two dashboard updates using the same optimistic revision admit exactly one
  winner; the other is `stale_dashboard`. The winning exact request replays even
  after the revision advances, and only one receipt exists.
- Identical request IDs on different dashboard databases produce independent
  item IDs, globally unique numbers 1 and 2, and independent exact replays.

Process tests are compiled only with `isolated-tests`. Every child uses the
binary supplied by `CARGO_BIN_EXE_dyna` from this test build, an empty `PATH`, a
cleared environment and `DYNA_ISOLATED_TEST_HOME` pointing to a temporary fixture.
The target directory was independently created with `mktemp -d`; no existing
`target/debug/dyna` binary was used. Busy retries preserve exact arguments and
input and are bounded to 100 attempts with 5 ms spacing. The initial harness
needed correction to permit a second busy response while already-launched
siblings were still running, and to read card titles from dashboard snapshot.
Neither harness correction was reported as a production failure.

## Commands and counts

Reproduction and isolated verification used the same command:

```sh
cargo test --offline --manifest-path crates/dyna-cli/Cargo.toml \
  --target-dir /private/tmp/dyna-storage-target.fswEkt \
  --features isolated-tests --test storage_stress -- --nocapture
```

- Round 1, after correcting the harness: 6 passed, 4 failed. The four failing
  names are the regressions documented above.
- Round 2, after root's fixes, with the same regression expectations: 10 passed,
  0 failed.

The feature-free build verifies that only disposable in-process fixtures run:

```sh
cargo test --offline --manifest-path crates/dyna-cli/Cargo.toml \
  --target-dir /private/tmp/dyna-storage-target.fswEkt --test storage_stress
```

Round 2 result: 6 passed, 0 failed. Formatting of the owned test file was checked
with `rustfmt --edition 2024 --check`.

No remaining material failure was found within these ten focused fixtures. Two
material rounds were used; a third round was not required. Physical power loss,
filesystem faults during actual writes, legacy conversion, coordinated restore,
native App Server task integration and production adapter parity remain outside
this pass. Native task ownership tests use synthetic bindings in disposable
stores, not a native task integration.

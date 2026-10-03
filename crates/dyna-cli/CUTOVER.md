# CLI-only production cutover checklist

The consolidated CLI-only backend plan is **not complete**. The Rust crate is an
isolated foundation; passing its tests does not remove the current production
TypeScript database gateway.

## Required before replacing the installed backend

1. Implement v14-to-v15 staging, coordinated backup/restore, legacy shared-item
   splitting, origin references and historical receipt compatibility. Verify
   complete evidence, notes, placement, archive, task and history preservation.
   The existing read-only migration preview is not a migration implementation.
2. Complete view/action capabilities, association reservations, action delivery,
   reconciliation, checkpointed task pull, session discovery and all controller
   protocols. Port reversible source separation/Undo Merge. Preserve existing
   capability, cancellation and idempotency behavior.
3. Prove native App Server connectivity and desktop/Mobile Remote parity. Native
   listing/naming support in documentation is not proof of a desktop connection.
   Keep the approved host fallback outside the skill and never report unavailable
   native operations as successful.
4. Route every production MCP, component and publisher data operation through
   one bounded CLI adapter; one snapshot invocation per dashboard. Remove
   production TypeScript SQLite/service construction only after parity passes.
5. Reconcile changed strict schemas, resource aliases and `dyna/work-item-v3`
   references. Rewrite the installed skill and all update/sync/collection
   references to CLI-only workflows, including legacy-reference resolution.
6. Package platform binaries, notices, launchers and the temporary publisher
   forwarding shim. Add Rust build checks, package isolation, binary size,
   payload budgets and generated-artifact parity to shipping validation.
7. Pin the worker allow rule to `--actor linked-worker`, not merely the command
   prefix. Test omitted/replaced/duplicated actor flags. The standalone CLI
   defaults to a local operator and must never inherit the broader old worker
   rule. Preserve rule-installation approval and report restart requirements.
8. Pass differential v14 fixtures and cross-adapter tests, crash/failure recovery,
   multiprocessing contention, architecture guards and native/browser acceptance
   for the **new** backend before switching routing. Existing browser tests cover
   the unchanged production UI, not Rust adapter parity.

## Existing operation coverage

| Existing operation family                                                    | Rust foundation | Remaining production work                                                                    |
| ---------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------- |
| Dashboard create/list/update/archive/restore                                 | Implemented     | Adapter/result compatibility, safe legacy migration                                          |
| Named keys, pick and database rename                                         | Implemented     | Installed skill selection and migration aliases                                              |
| Search/context/history/activity/source pages                                 | Implemented     | Strict output compatibility, complete legacy-history pagination                              |
| Typed work, completion, patch enrichment                                     | Implemented     | Legacy receipts and MCP deliberate replace-enrichment compatibility                          |
| Notes, priority/order/bulk placement, stages/backlog, archive/restore        | Implemented     | Component capability protocol and cross-adapter parity                                       |
| Standalone to-do and linked follow-up                                        | Implemented     | Migration origin/reference mapping and adapters                                              |
| Publisher setup/revoke, manifest validation and publication                  | Implemented     | Publisher shim, independent multi-dashboard result reporting, legacy publisher compatibility |
| Schedule list/bind/unbind/status metadata                                    | Implemented     | Installed schedule reconciliation through optional native adapter                            |
| Source evidence, proved correlation, aliases and merge history               | Implemented     | Separate Source/Undo Merge and migrated relationship parity                                  |
| Native association, exact title repair and action claims                     | Not implemented | Full controller and verified native integration                                              |
| Task sync, session inventory/discovery, checkpoints and partial results      | Not implemented | Full persisted protocols and cached-first UI integration                                     |
| Integrity/recovery and coordinated backup                                    | Implemented     | Coordinated restore and legacy migration recovery                                            |
| Work-reference v3, presentation-only panel open, rules and packaged binaries | Not implemented | Skill, host adapter, schemas and package changes                                             |

## Review limit and delivery authority

Storage, work/security and cutover reviewers completed three material review
loops. Their findings led to catalog-loss protection, unavailable-store handling,
backup verification, status precedence, merge/work-attempt preservation, alias
search, contradictory-publication rejection and PTY non-echo fixes.

The subsequent explicit request authorized a new review/fix pass, limited to
three rounds. Its [review record](REVIEW.md) documents the material defects,
regressions and foundation-only approvals. That pass is closed; no further review
loop or production-cutover approval is implied.

The later explicit testing request authorized a new differentiated behavioral
pass, capped at three rounds. Its [testing record](testing/README.md) captures
storage recovery/ownership, actual-executable security/protocol and
workflow/correlation/search regressions. All recorded findings are fixed and
full foundation suites pass; that pass is also closed. This does not close the
production requirements above.

Push, merge, plugin installation/upgrade/reload, rule installation and live native
acceptance remain separate delivery actions. Source authentication remains
user-owned. Preserve the pre-existing UI, generated bundle, `.prettierignore`,
`AGENTS.md` and other unrelated changes.

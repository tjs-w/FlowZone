# CallFlow workflow maps

CallFlow is a separate installable Codex plugin in this repository. It builds a bounded, deterministic graph for one selected code workflow and presents the same evidence through a headless CLI, read-only MCP tools, exports, and an interactive three-pane view.

CallFlow does not generate whole-repository diagrams. Start from a function, route, table, queue, transaction, sink, or external integration and narrow the map to the path that answers the question.

## Evidence model

Human workflow intent and generated evidence are separate:

- `callflow/workflow-manifest-v1` records anchors, boundaries, stage labels, exclusions, presentation hints, reviewed semantic links, and explicitly typed human-curated workflow relationships such as asynchronous handoffs and retries.
- `callflow/graph-snapshot-v1` records generated nodes, typed edges, evidence, warnings, repository identity, and adapter identity.
- `callflow/graph-diff-v1` reports `current`, `changed`, `broken`, and `unverified` elements.
- `callflow/export-bundle-v1` is the sanitized portable representation used by exports.

Every node and edge cites evidence. Evidence state is `exact`, `ambiguous`, `stale`, `failed`, or `unavailable`; a failed or unavailable adapter slice is never reported as a healthy empty result. AI-authored material can explain, label, group, or support a `semantic-link`, but cannot support a static call edge.

Stable identifiers hash repository identity, qualified symbols, signatures, relationships, and evidence identity. Display labels and coordinates are excluded, so reviewed intent and selection can survive relayout and ordinary refreshes.

## Graft adapter

CallFlow v1 supports an external Graft `0.18.x` executable. Discovery first runs Graft's read-only `check --json` drift check; Graft 0.18 does not expose `--no-refresh` on `check`. Every graph-reading command (`map`, `ask`, `callers`, `grep`, and `skeleton`) uses JSON output with `--no-refresh`. CallFlow proves the status/discovery path leaves repository and index bytes and timestamps unchanged, and it never refreshes or builds an index implicitly.

The adapter invokes a canonical executable directly with a fixed subcommand allowlist and `shell: false`. Repository and source paths are realpath-checked against one Git worktree, output is bounded, and each process has cancellation and a 30-second timeout. Unexpected versions, malformed output, stale indexes, and missing evidence fail closed.

`callflow adapter build` is the only index-building command. It is an explicit local mutation and is not exposed as an MCP tool.

## CLI

The checked-in `plugins/callflow/bin/callflow` launcher uses Node.js and the bundled CLI. Commands emit stable JSON to stdout and bounded, sanitized diagnostics to stderr.

```text
callflow adapter status --repo REPO
callflow adapter build --repo REPO [--lsp]

callflow workflow discover --repo REPO [--entry SYMBOL] [--sink SYMBOL]
callflow workflow create --repo REPO --manifest PATH
callflow workflow validate --manifest PATH
callflow workflow refresh --manifest PATH [--against REF] [--write]
callflow workflow diff --manifest PATH --against REF

callflow graph inspect --manifest PATH --node ID|--edge ID
callflow graph query --manifest PATH

callflow workflow export --manifest PATH \
  --format markdown|graph-json|bundle-json|mermaid|svg|html \
  --output PATH
```

Manifest creation consumes reviewed JSON from stdin. Query consumes a bounded query object from stdin. Refresh is a dry run unless `--write` is supplied. Generated snapshots never replace the human manifest.

## MCP surface

The separate local stdio server exposes six model-visible, read-only tools:

- `callflow_discover`
- `render_callflow`
- `callflow_query`
- `callflow_validate`
- `callflow_diff`
- `callflow_export`

Component-only expansion, search, path, relayout, description, and source helpers are marked with `_meta.ui.visibility: ["app"]`. Public results contain only bounded summaries and identifiers. The complete graph and authorized source excerpt stay in private component metadata.

The presentation tool binds to `ui://callflow/workflow/v1.html`. The resource has a closed network/resource/frame CSP and no source or network capability. Its private envelope is revision-bound and uses an expiring session capability.

## Interface

The view coordinates:

1. An accessible stage/function outline.
2. A controlled left-to-right workflow canvas with nested stages, typed edges, a minimap, and a distinct retry/back-edge lane.
3. An evidence inspector for source identity, span, revision, state, and incoming/outgoing relationships.

L0 shows stages and major systems, L1 shows functions and workflow entities, and L2 callsites remain in the inspector. Zoom changes presentation only. Expansion, callers, callees, paths, isolation, sibling collapse, pinning, search, fit, and reset are explicit actions.

The initial view contains 10–30 nodes. One expansion adds at most 25. The component refuses to render more than 250 nodes or 600 edges without a narrower selection. Filters preserve hidden counts and reasons; pinned nodes survive collapse; selection moves to the closest visible ancestor when necessary. Viewport, layout, selection, breadcrumbs, filters, pins, and navigation history are reducer state rather than regenerated UI state.

## Source privacy

Source remains local by default. Loading source requires an exact repository-relative file span, purpose, byte budget, unexpired session capability, matching graph revision, and matching content digest. The server checks all of them immediately before the bounded read.

Default exports omit source bodies and absolute paths. The browser never receives model or network access, never renders repository-provided HTML, and does not store capability tokens in browser storage.

CallFlow is local code running with the current OS user's filesystem authority; these controls are defense in depth, not an operating-system sandbox.

## Build and release gates

- Browser HTML, JavaScript, and CSS: at most 1.25 MiB uncompressed.
- Combined CallFlow CLI and MCP bundles: at most 5 MiB.
- Initial private graph payload: at most 8 MiB with no source bodies.
- Initial useful paint: at most 250 ms in the browser harness.
- Local selection and filtering: at most 100 ms.
- Layout: at most 250 ms for 30 nodes and one second for 250 nodes.
- Accessibility: WCAG 2.2 AA checks, complete keyboard access, visible focus, forced colors, reduced motion, and a usable 320-pixel reflow.

React Flow is pinned to `12.11.6`. ELK is pinned to `0.12.0`, runs in a cancellable Node worker, and is used under its EPL-2.0 option. The shipped bundle retains third-party notices and the EPL-2.0 license. Release stops if license or bundle gates fail.

`bun run license:check` compares the installed dependency metadata and notices with the exact approved pins, verifies the shipped license files byte-for-byte, and fails the release gate if either dependency changes its version or declared license.

CallFlow's checked bundles retain byte-exact clean-build parity. The pre-existing FlowZone bundles are deliberately not regenerated as part of CallFlow verification: all ten legacy shipping artifacts are guarded by exact digests, and a separate reproducible digest covers their complete tracked source/static inputs, legacy build configuration, workspace manifests, and relevant resolved lockfile closure. CI and the Playwright harness build CallFlow only, then exercise those unchanged FlowZone artifacts. This is an immutable non-regression boundary; it does not claim to repair the older FlowZone bundle's known clean-install reproducibility debt.

The Linus acceptance data under `tests/fixtures/callflow/linus-opensearch/` pins commit `cd2949c1e4a686359900a3f47e8dbd2e2b44b861`. Its reviewed manifest models `signalOpenSearch` to `Worker.Run` as a human-curated `async-handoff`; a direct-call edge between those anchors is explicitly forbidden. The fixture contains selectors and expectations only—no Linus source and no Linus-specific core behavior.

## Local installation

Build and validate the repository, then add this checkout as a marketplace if it is not already configured:

```sh
bun run verify
codex plugin marketplace add /absolute/path/to/flowzone
codex plugin add callflow@flowzone
```

Restart Codex and start a new task so it receives CallFlow's tool and skill registrations. Invoke `$callflow:callflow` or call the headless tools directly.

# CallFlow workflow maps

CallFlow is a contained FlowZone capability. It builds a bounded, deterministic graph for one selected code workflow and presents the same evidence through FlowZone's existing MCP router, a headless CLI, exports, and an interactive three-pane view. Installing FlowZone once installs CallFlow, Markdown Review, and Dyna; CallFlow does not start a second MCP server or add model-visible `callflow_*` tools.

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

`callflow adapter build` is the only index-building command. It is an explicit local mutation and is not exposed through the FlowZone router.

## CLI

The checked-in `bin/callflow` launcher is part of the FlowZone installation and uses Node.js with the bundled CLI. Commands emit stable JSON to stdout and bounded, sanitized diagnostics to stderr.

```text
callflow adapter status --repo REPO
callflow adapter build --repo REPO [--lsp]

callflow workflow discover --repo REPO --entry SYMBOL [--entry SYMBOL ...] [--sink SYMBOL]
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

## FlowZone router surface

The model uses the existing `flowzone` tool. CallFlow contributes the read-only actions `discover`, `query`, `validate`, `diff`, and `export` to that router:

```json
{
  "plugin": "callflow",
  "action": "discover",
  "input": {
    "repositoryPath": "/absolute/path/to/repository",
    "entries": ["qualified.entryPoint"],
    "sink": "qualified.sink"
  }
}
```

Model-visible results contain bounded summaries and sanitized topology. A query returns at most 30 nodes and 60 edges with display labels, typed endpoints, assertions, and evidence states; it excludes qualified names, signatures, paths, and evidence bodies. Graft output and complete graphs remain in server-side session state; capability tokens and authorized source excerpts travel only through private component metadata. The router's `export` action is a CLI-only preflight: it returns the requested format, size, and digest, but never the export body. Use the CLI when an explicit local export file is required. This keeps CallFlow's graph size out of model and component transport while preserving useful headless actions.

Interactive expansion, source loading, fixed-text search, path finding, relayout, and visible-graph description use capability-bound app-only helpers. FlowZone centrally marks them with `_meta.ui.visibility: ["app"]`; they are not model-facing alternatives to the router.

The interactive resource is `ui://flowzone/callflow/v2.html`; the server retains the previous FlowZone URI and original standalone URI as compatibility aliases. It is registered by the one FlowZone MCP server with a closed network/resource/frame CSP and clipboard-only host permission. No separate `.app.json`, CallFlow plugin manifest, or CallFlow MCP registration is shipped.

MCP Apps binds an output template statically to a tool descriptor, so the shared multi-capability `flowzone` router cannot select CallFlow's separate resource dynamically. Routed discovery is therefore headless in current Codex hosts. A host that explicitly presents the registered resource can use the private helpers; otherwise `callflow ui open --manifest PATH` provides the local interactive view. CallFlow does not add a `render_callflow` model tool to work around this protocol constraint.

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

- Combined shared FlowZone server, publisher, and Dyna CLI bundles: at most 5 MiB.
- Combined shared FlowZone MCP server, CallFlow CLI, and CallFlow layout worker: at most 5 MiB.
- CallFlow browser HTML, JavaScript, and CSS: at most 1.25 MiB uncompressed.
- Initial private graph payload: at most 8 MiB with no source bodies.
- Initial useful paint: at most 250 ms in the browser harness.
- Local selection and filtering: at most 100 ms.
- Layout: at most 250 ms for 30 nodes and one second for 250 nodes.
- Accessibility: WCAG 2.2 AA checks, complete keyboard access, visible focus, forced colors, reduced motion, and a usable 320-pixel reflow.

React Flow is pinned to `12.11.6`. ELK is pinned to `0.12.0`, runs in a cancellable Node worker, and is used under its EPL-2.0 option. The FlowZone bundle retains third-party notices and the EPL-2.0 license. Release stops if license or bundle gates fail. Existing Markdown Review and Dyna behavior remains protected by compatibility tests even though the shared server bundle now includes CallFlow.

`bun run license:check` compares the installed dependency metadata and notices with the exact approved pins, verifies the shipped license files byte-for-byte, and fails the release gate if either dependency changes its version or declared license.

The Linus acceptance data under `tests/fixtures/callflow/linus-opensearch/` pins commit `cd2949c1e4a686359900a3f47e8dbd2e2b44b861`. Its reviewed manifest models `signalOpenSearch` to `Worker.Run` as a human-curated `async-handoff`; a direct-call edge between those anchors is explicitly forbidden. The fixture contains selectors and expectations only—no Linus source and no Linus-specific core behavior.

## Local installation

Build and validate the repository, then add this checkout as a marketplace if it is not already configured:

```sh
bun run verify
codex plugin marketplace add /absolute/path/to/flowzone
codex plugin add flowzone@flowzone
```

Restart Codex and start a new task so it receives the updated shared server and bundled skill. Invoke `$flowzone:callflow`, or call `flowzone` with `plugin: "callflow"` for headless use.

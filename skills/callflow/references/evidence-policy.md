# Evidence policy

CallFlow separates relationship meaning from how the relationship was asserted.

## Evidence states

- `exact`: the producer resolved the source identity and span at the recorded revision.
- `ambiguous`: more than one target remains possible; present every bounded candidate.
- `stale`: the repository or source digest no longer matches the evidence revision.
- `failed`: the producer attempted the operation and returned a bounded error code.
- `unavailable`: the producer, index, comparison revision, or runtime observation does not exist.

A failed or unavailable slice is not a successful slice with zero items. Preserve that distinction in explanations and exports.

## Evidence kinds

- `graft-exact` can support static call relationships when its evidence is exact.
- `source-literal` can identify anchors and source facts, but cannot synthesize a call edge.
- `human-curated` records reviewed workflow intent and semantic relationships.
- `ai-inferred` can support labels, grouping, explanations, or `semantic-link` only.
- `runtime-observed` is reserved for a future adapter and remains unavailable in v1.

Every node and edge has at least one evidence identifier. Never upgrade ambiguous or semantic evidence into a direct call. When different evidence sources disagree, show the disagreement and revision rather than choosing silently.

## Source disclosure

Source stays on the local host. Request only the selected repository-relative file span, state why it is needed, and use the smallest useful byte budget. Revalidate the graph revision and source digest immediately before reading. Do not copy source bodies or absolute paths into default exports.

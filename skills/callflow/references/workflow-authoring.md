# Workflow manifest authoring

The human manifest and generated snapshot are separate documents.

- The `callflow/workflow-manifest-v1` document owns the workflow name, repository, anchors, optional sink, boundaries, stage labels, exclusions, presentation hints, reviewed semantic links, and explicitly typed human-curated workflow relationships.
- The `callflow/graph-snapshot-v1` document is replaceable generated evidence tied to a repository and adapter revision.
- Refresh is a dry run unless `--write` is supplied. It may replace only the generated snapshot, never the human manifest.

Prefer qualified symbols plus repository-relative paths for anchors. Keep stages causal and few enough to scan. Record queues, tables, external systems, and asynchronous handoffs explicitly when they are part of the requested flow. Do not encode implementation-specific Linus rules in a reusable manifest or core package.

Use `acceptedRelationships` for reviewed causal structure that static extraction cannot assert, including `async-handoff`, `poll`, `claim`, state access, transaction boundaries, retry, and failure exits. `direct-call` and `conditional-call` are deliberately unavailable there: those edges require static or runtime evidence. `acceptedSemanticLinks` remains the compatibility field for reviewed semantic-only links.

Before accepting a refreshed graph, inspect changed, broken, and unverified elements. Human annotations survive refresh only through stable identifiers or explicit manifest declarations.

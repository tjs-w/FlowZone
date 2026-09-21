# Malformed evidence fixtures

Tests in `@callflow/contracts` and `@callflow/core` construct invalid snapshots in code so they can target one invariant at a time: missing evidence, missing endpoints, duplicate identifiers, AI evidence on static calls, and AI-inferred non-semantic edges. This directory is a stable location for adapter-level malformed JSON responses and graph-build evidence with an escaping path, inverted span, invalid digest, and dangling evidence reference. Each input must be rejected, never reported as a healthy empty result.

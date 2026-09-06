# Security policy and boundaries

Report suspected vulnerabilities privately through the repository owner's GitHub security contact rather than a public issue when disclosure could expose users.

FlowZone's shipped boundary is one local stdio server running as the current OS user. It is not a privilege boundary or an OS sandbox. Review plugins, CLI adapters, and backend registrations before bundling them.

The public attack surface is one strict router tool. Registrations are static, copied at startup, bounded, and schema-validated. Component helpers are centrally marked app-only. Complete Markdown, image bytes, and UI payloads remain private MCP metadata. Stable errors omit request content, secrets, backend bodies, raw stderr, and unexpected exception text.

CLI adapters use absolute canonical paths, fixed argv/cwd/environment configuration, `shell: false`, JSON stdin, bounded stdout/stderr, integrity checks, cancellation, and timeouts. Never register a shell executable or put model-controlled data in command fields. HTTP adapters use fixed HTTPS endpoints, runtime credentials, no redirects, bounded streaming, and strict response validation.

The universal UI declares an empty network/resource/frame CSP allowlist and only clipboard-write permission. Each view validates its private payload before rendering. Plugin-specific policies—including path containment, file identity, authorization, and tenant access—remain mandatory and are not replaced by router validation.

## Dyna boundaries

Dyna publishers submit bounded domain records, never components, HTML, code, prompts, or tool names. Server-side catalog validation is a release gate; the browser receives only a versioned snapshot and scoped view capability. Source identity is publisher-scoped, public failure text is normalized, redacted, and bounded before persistence, and publisher-supplied people cannot raise priority. Leadership enrichment submitted through the separate control path may raise priority; its provenance is a caller assertion until a host-controlled identity or evidence adapter is available.

The SQLite store rejects unknown future schemas and rolls back migrations that fail integrity or foreign-key checks. Dashboard schedule and item task-link cardinality are capped, including reservations for task creations whose external effect may already exist. Backups use a private same-directory staging file, integrity verification, restrictive permissions, and no-overwrite publication; backup and offline restore remain trusted operator operations rather than model-visible tools.

Publisher credentials, view capabilities, claim tokens, and completion tokens are stored only as hashes. The one-time publisher credential is nevertheless visible to the model at creation or rotation and remains exposed if copied into a scheduled prompt. Until Codex provides protected scheduled-task credentials, Dyna publishing is a trusted single-user local preview suitable only for non-production data.

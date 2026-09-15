# CLI reference

The CLI writes stable JSON to stdout and bounded diagnostics to stderr.

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
callflow workflow export --manifest PATH --format markdown|graph-json|bundle-json|mermaid|svg|html --output PATH
callflow ui serve --manifest PATH --listen 127.0.0.1 --port 0
callflow ui open --manifest PATH
```

`workflow create` consumes reviewed manifest JSON from stdin. `graph query` consumes a bounded query object from stdin. `workflow refresh` is read-only unless `--write` is present. `adapter build`, manifest writes, snapshot replacement, export files, and opening a browser are explicit local CLI effects and are unavailable through FlowZone router actions or app-only helpers.

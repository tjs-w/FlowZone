import {
  ExportBundleSchema,
  GraphSnapshotSchema,
  MAX_VISIBLE_EDGES,
  MAX_VISIBLE_NODES,
  type EvidenceRecord,
  type EvidenceReferenceSlice,
  type ExportBundle,
  type GraphEdge,
  type GraphNode,
  type GraphSnapshot,
} from "@callflow/contracts";

import { sha256Hex } from "./stable-id";

type Attributes = NonNullable<GraphNode["attributes"]>;

const SENSITIVE_ATTRIBUTE_PATTERN =
  /(secret|password|token|credential|authorization|cookie|api[_.-]?key|private[_.-]?key)/i;
const LOCAL_PATH_PATTERN =
  /(?:^|[^A-Za-z0-9_.:/-])(?:\/(?!\/)[^\s"'`<>{}[\]]+|[A-Za-z]:[\\/][^\s"'`<>{}[\]]+|\\\\[^\\\s]+\\[^\s"'`<>{}[\]]+)/;
// Repository-controlled text can hide an absolute path directly after a
// scheme-like key (for example, `path:/Users/alice/private.ts`). Valid network
// URLs use `://`; malformed or scheme-less `prefix:/...` values fail closed.
const PREFIXED_POSIX_PATH_PATTERN = /\b[A-Za-z][A-Za-z0-9_.-]{0,63}:\/(?!\/)[^\s"'`<>{}[\]]+/;
const MULTISLASH_POSIX_PATH_PATTERN = /(?:^|[^A-Za-z0-9_.:/-])\/{2,}[^\s"'`<>{}[\]]+/;
const WINDOWS_ROOTED_PATH_PATTERN = /(?:^|[^A-Za-z0-9_.\\-])(\\(?!\\)[^\s"'`<>{}[\]]+)/g;
const NON_PATH_ESCAPE_PATTERN =
  /^\\(?:[0abfnrtvdswDSWBZ]|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|u\{[0-9A-Fa-f]{1,6}\})$/;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(?:password|passwd|pwd|secret|token|api[_.-]?key|access[_.-]?key|client[_.-]?secret|authorization|cookie)\b\s*[:=]\s*[^\s,;]+/i;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i;
const WELL_KNOWN_SECRET_PATTERN =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh(?:p|o|u|s|r)_[A-Za-z0-9_]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b)/i;
const LOCAL_FILE_URI_PATTERN =
  /\b(?:file:(?:\/{1,3}|%2f|[A-Za-z]:[\\/])|vscode:\/\/file(?:\/|%2f))/i;
// The explicit ranges are intentional: portable/model-visible text must never
// retain non-printing control bytes other than normal whitespace.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function looksLocal(value: string): boolean {
  return (
    value.startsWith("local:") ||
    value.startsWith("file:") ||
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

function looksCredentialBearing(value: string): boolean {
  return (
    /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s]*@/.test(value) ||
    (/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`<>]+/.test(value) &&
      /[?&](?:password|secret|token|api[_.-]?key|access[_.-]?key)=/i.test(value))
  );
}

function containsWindowsRootedPath(value: string): boolean {
  return [...value.matchAll(WINDOWS_ROOTED_PATH_PATTERN)].some((match) => {
    const candidate = match[1];
    return candidate !== undefined && !NON_PATH_ESCAPE_PATTERN.test(candidate);
  });
}

/** Fail-closed sanitizer for any untrusted text entering model-visible or portable output. */
export function sanitizePublicText(value: string): string {
  if (
    LOCAL_PATH_PATTERN.test(value) ||
    PREFIXED_POSIX_PATH_PATTERN.test(value) ||
    MULTISLASH_POSIX_PATH_PATTERN.test(value) ||
    containsWindowsRootedPath(value) ||
    SECRET_ASSIGNMENT_PATTERN.test(value) ||
    BEARER_TOKEN_PATTERN.test(value) ||
    WELL_KNOWN_SECRET_PATTERN.test(value) ||
    LOCAL_FILE_URI_PATTERN.test(value) ||
    looksCredentialBearing(value)
  ) {
    return "[redacted-sensitive-text]";
  }
  const sanitized = value.replace(CONTROL_CHARACTER_PATTERN, " ").trim();
  return sanitized.length === 0 ? "[redacted-empty-text]" : sanitized;
}

function sanitizedIdentity(identity: string): string {
  return looksLocal(identity) || looksCredentialBearing(identity)
    ? `repository:sha256:${sha256Hex(identity)}`
    : sanitizePublicText(identity);
}

function sanitizeAttributes(attributes: Attributes | undefined): Attributes | undefined {
  if (attributes === undefined) return undefined;
  const entries = Object.entries(attributes)
    .filter(([key]) => !SENSITIVE_ATTRIBUTE_PATTERN.test(key))
    .filter(([, value]) => typeof value !== "string")
    .map(([key, value]) => [key, value] as const);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function sanitizeNode(node: GraphNode): GraphNode {
  const attributes = sanitizeAttributes(node.attributes);
  const { attributes: _attributes, ...base } = node;
  void _attributes;
  return {
    ...base,
    label: sanitizePublicText(node.label),
    ...(node.qualifiedName === undefined
      ? {}
      : { qualifiedName: sanitizePublicText(node.qualifiedName) }),
    ...(node.signature === undefined ? {} : { signature: sanitizePublicText(node.signature) }),
    ...(node.summary === undefined ? {} : { summary: sanitizePublicText(node.summary) }),
    ...(attributes === undefined ? {} : { attributes }),
  };
}

function sanitizeEdge(edge: GraphEdge): GraphEdge {
  const attributes = sanitizeAttributes(edge.attributes);
  const { attributes: _attributes, ...base } = edge;
  void _attributes;
  return {
    ...base,
    ...(edge.label === undefined ? {} : { label: sanitizePublicText(edge.label) }),
    ...(edge.condition === undefined ? {} : { condition: sanitizePublicText(edge.condition) }),
    ...(attributes === undefined ? {} : { attributes }),
  };
}

function sanitizeEvidence(evidence: EvidenceRecord): EvidenceRecord {
  const attributes = sanitizeAttributes(evidence.attributes);
  const { attributes: _attributes, ...base } = evidence;
  void _attributes;
  const source =
    evidence.source.type === "source-span"
      ? {
          ...evidence.source,
          ...(evidence.source.symbol === undefined
            ? {}
            : { symbol: sanitizePublicText(evidence.source.symbol) }),
        }
      : {
          ...evidence.source,
          system: sanitizePublicText(evidence.source.system),
          reference: `reference:sha256:${sha256Hex(evidence.source.reference)}`,
        };
  return {
    ...base,
    revision: sanitizePublicText(evidence.revision),
    source,
    producer: {
      name: sanitizePublicText(evidence.producer.name),
      version: sanitizePublicText(evidence.producer.version),
    },
    ...(evidence.details === undefined ? {} : { details: sanitizePublicText(evidence.details) }),
    ...(attributes === undefined ? {} : { attributes }),
  };
}

function sanitizeEvidenceSlice(slice: EvidenceReferenceSlice): EvidenceReferenceSlice {
  if (slice.status !== "unavailable") return slice;
  return { ...slice, reason: sanitizePublicText(slice.reason) };
}

/** Redacts a graph while preserving the graph-snapshot-v1 document shape. */
export function sanitizeGraphSnapshot(snapshotValue: GraphSnapshot): GraphSnapshot {
  const snapshot = GraphSnapshotSchema.parse(snapshotValue);
  return GraphSnapshotSchema.parse({
    ...snapshot,
    repository: {
      ...snapshot.repository,
      identity: sanitizedIdentity(snapshot.repository.identity),
      commit: sanitizePublicText(snapshot.repository.commit),
    },
    adapter: {
      ...snapshot.adapter,
      name: sanitizePublicText(snapshot.adapter.name),
      version: sanitizePublicText(snapshot.adapter.version),
      indexRevision: sanitizePublicText(snapshot.adapter.indexRevision),
    },
    nodes: snapshot.nodes.map(sanitizeNode),
    edges: snapshot.edges.map(sanitizeEdge),
    evidence: snapshot.evidence.map(sanitizeEvidence),
    warnings: snapshot.warnings.map((warning) => ({
      ...warning,
      message: sanitizePublicText(warning.message),
    })),
    ...(snapshot.extraction === undefined
      ? {}
      : { extraction: sanitizeEvidenceSlice(snapshot.extraction) }),
    ...(snapshot.runtimeEvidence === undefined
      ? {}
      : { runtimeEvidence: sanitizeEvidenceSlice(snapshot.runtimeEvidence) }),
  });
}

/** Creates the only graph shape allowed to leave the local MCP private-data boundary by default. */
export function sanitizeExportBundle(snapshotValue: GraphSnapshot): ExportBundle {
  const snapshot = sanitizeGraphSnapshot(snapshotValue);
  return ExportBundleSchema.parse({
    schemaVersion: "callflow/export-bundle-v1",
    graphId: snapshot.id,
    workflowManifestId: snapshot.workflowManifestId,
    repository: {
      identity: snapshot.repository.identity,
      commit: snapshot.repository.commit,
    },
    adapter: snapshot.adapter,
    nodes: snapshot.nodes,
    edges: snapshot.edges,
    evidence: snapshot.evidence,
    warnings: snapshot.warnings,
    presentation: snapshot.presentation,
    layoutHints: snapshot.layoutHints,
    ...(snapshot.extraction === undefined ? {} : { extraction: snapshot.extraction }),
    ...(snapshot.runtimeEvidence === undefined
      ? {}
      : { runtimeEvidence: snapshot.runtimeEvidence }),
  });
}

function markdownCode(value: string): string {
  const flattened = value.replace(/\r?\n/g, " ").replaceAll("|", "\\|");
  const longestRun = Math.max(0, ...(flattened.match(/`+/g)?.map((run) => run.length) ?? []));
  const fence = "`".repeat(longestRun + 1);
  // CommonMark removes one symmetric padding space, keeping hostile Markdown,
  // HTML, autolinks, and delimiter characters inert inside the code span.
  return `${fence} ${flattened} ${fence}`;
}

function evidenceLocation(evidence: EvidenceRecord): string {
  if (evidence.source.type === "source-span") {
    return `${evidence.source.path}:${evidence.source.start.line}:${evidence.source.start.column}`;
  }
  return `${evidence.source.system}:${evidence.source.reference}`;
}

function markdownIds(ids: readonly string[]): string {
  return markdownCode(ids.length === 0 ? "-" : ids.join(","));
}

export function exportMarkdown(snapshot: GraphSnapshot): string {
  const bundle = sanitizeExportBundle(snapshot);
  const lines = [
    `# ${bundle.workflowManifestId}`,
    "",
    `Graph: ${markdownCode(bundle.graphId)}`,
    `Repository: ${markdownCode(`${bundle.repository.identity}@${bundle.repository.commit}`)}`,
    "",
    "## Presentation",
    "",
    "| Presentation schema | Layout schema | Direction | Default overlay | Stage order |",
    "| --- | --- | --- | --- | --- |",
    `| ${markdownCode(bundle.presentation.schemaVersion)} | ${markdownCode(bundle.layoutHints.schemaVersion)} | ${bundle.presentation.direction} | ${bundle.presentation.defaultOverlay} | ${markdownIds(bundle.layoutHints.stageOrder)} |`,
    "",
    "## Nodes",
    "",
    "| ID | Stage ID | Level | Kind | Name | Evidence IDs |",
    "| --- | --- | --- | --- | --- | --- |",
    ...bundle.nodes.map(
      (node) =>
        `| ${markdownCode(node.id)} | ${markdownCode(node.stageId ?? "-")} | ${node.level} | ${node.kind} | ${markdownCode(node.label)} | ${markdownIds(node.evidenceIds)} |`,
    ),
    "",
    "## Edges",
    "",
    "| ID | Kind | Assertion | From | To | Evidence IDs |",
    "| --- | --- | --- | --- | --- | --- |",
    ...bundle.edges.map(
      (edge) =>
        `| ${markdownCode(edge.id)} | ${edge.kind} | ${edge.assertion} | ${markdownCode(edge.source)} | ${markdownCode(edge.target)} | ${markdownIds(edge.evidenceIds)} |`,
    ),
    "",
    "## Evidence",
    "",
    "| ID | State | Kind | Location | Revision | Content digest |",
    "| --- | --- | --- | --- | --- | --- |",
    ...bundle.evidence.map(
      (evidence) =>
        `| ${markdownCode(evidence.id)} | ${evidence.state} | ${evidence.kind} | ${markdownCode(evidenceLocation(evidence))} | ${markdownCode(evidence.revision)} | ${markdownCode(evidence.contentDigest)} |`,
    ),
    "",
  ];
  return lines.join("\n");
}

function assertVisualSize(bundle: ExportBundle): void {
  if (bundle.nodes.length > MAX_VISIBLE_NODES || bundle.edges.length > MAX_VISIBLE_EDGES) {
    throw new RangeError(
      `Visual exports support at most ${MAX_VISIBLE_NODES} nodes and ${MAX_VISIBLE_EDGES} edges; narrow the workflow first.`,
    );
  }
}

function mermaidLabel(value: string): string {
  const sanitized = value
    .replace(/[^A-Za-z0-9 ._:/()-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (sanitized.length === 0 ? "Unnamed" : sanitized).slice(0, 160);
}

function mermaidNodeId(nodeId: string): string {
  return `n_${sha256Hex(nodeId).slice(0, 20)}`;
}

export function exportMermaid(snapshot: GraphSnapshot): string {
  const bundle = sanitizeExportBundle(snapshot);
  assertVisualSize(bundle);
  const lines = [
    "flowchart LR",
    `  %% callflow-presentation schema=${bundle.presentation.schemaVersion} direction=${bundle.presentation.direction} overlay=${bundle.presentation.defaultOverlay}`,
    `  %% callflow-layout schema=${bundle.layoutHints.schemaVersion} stage-order=${bundle.layoutHints.stageOrder.join(",") || "-"}`,
  ];
  for (const evidence of bundle.evidence) {
    lines.push(
      `  %% callflow-evidence id=${evidence.id} kind=${evidence.kind} state=${evidence.state} digest=${evidence.contentDigest}`,
    );
  }
  for (const node of bundle.nodes) {
    lines.push(
      `  %% callflow-node alias=${mermaidNodeId(node.id)} id=${node.id} evidence=${node.evidenceIds.join(",")}`,
    );
    lines.push(`  ${mermaidNodeId(node.id)}["${mermaidLabel(node.label)}"]`);
  }
  for (const edge of bundle.edges) {
    const arrow = edge.kind === "retry" || edge.kind === "failure-exit" ? "-.->" : "-->";
    lines.push(
      `  %% callflow-edge id=${edge.id} source=${edge.source} target=${edge.target} assertion=${edge.assertion} evidence=${edge.evidenceIds.join(",")}`,
    );
    lines.push(
      `  ${mermaidNodeId(edge.source)} ${arrow}|${mermaidLabel(edge.label ?? edge.kind)}| ${mermaidNodeId(edge.target)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

interface SvgPosition {
  readonly x: number;
  readonly y: number;
}

function svgPositions(nodes: readonly GraphNode[]): ReadonlyMap<string, SvgPosition> {
  return new Map(
    nodes.map((node, index) => [
      node.id,
      { x: 40 + (index % 4) * 300, y: 40 + Math.floor(index / 4) * 120 },
    ]),
  );
}

function svgMapping(bundle: ExportBundle): string {
  return JSON.stringify({
    schema: "callflow/svg-mapping-v1",
    graphId: bundle.graphId,
    presentation: bundle.presentation,
    layoutHints: bundle.layoutHints,
    nodes: bundle.nodes.map((node) => ({ id: node.id, evidenceIds: node.evidenceIds })),
    edges: bundle.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      assertion: edge.assertion,
      evidenceIds: edge.evidenceIds,
    })),
    evidence: bundle.evidence.map((record) => ({
      id: record.id,
      kind: record.kind,
      state: record.state,
      contentDigest: record.contentDigest,
    })),
  });
}

export function exportSvg(snapshot: GraphSnapshot): string {
  const bundle = sanitizeExportBundle(snapshot);
  assertVisualSize(bundle);
  const columns = Math.max(1, Math.min(4, bundle.nodes.length));
  const rows = Math.max(1, Math.ceil(bundle.nodes.length / 4));
  const width = columns * 300 + 40;
  const height = rows * 120 + 40;
  const positions = svgPositions(bundle.nodes);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc" viewBox="0 0 ${width} ${height}" data-callflow-graph-id="${escapeXml(bundle.graphId)}" data-callflow-presentation-schema="${escapeXml(bundle.presentation.schemaVersion)}" data-callflow-layout-schema="${escapeXml(bundle.layoutHints.schemaVersion)}">`,
    `<title id="title">CallFlow workflow ${escapeXml(bundle.workflowManifestId)}</title>`,
    '<desc id="desc">A deterministic evidence-backed workflow graph.</desc>',
    `<metadata id="callflow-mapping">${escapeXml(svgMapping(bundle))}</metadata>`,
    '<g fill="none" stroke="#64748b" stroke-width="2">',
  ];
  for (const edge of bundle.edges) {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (source === undefined || target === undefined) continue;
    parts.push(
      `<line x1="${source.x + 240}" y1="${source.y + 32}" x2="${target.x}" y2="${target.y + 32}" data-callflow-edge-id="${escapeXml(edge.id)}" data-callflow-source-id="${escapeXml(edge.source)}" data-callflow-target-id="${escapeXml(edge.target)}" data-callflow-assertion="${edge.assertion}" data-callflow-evidence-ids="${escapeXml(edge.evidenceIds.join(","))}" />`,
    );
  }
  parts.push("</g>", '<g font-family="system-ui, sans-serif" font-size="14">');
  for (const node of bundle.nodes) {
    const position = positions.get(node.id);
    if (position === undefined) continue;
    parts.push(
      `<g data-callflow-node-id="${escapeXml(node.id)}" data-callflow-stage-id="${escapeXml(node.stageId ?? "")}" data-callflow-evidence-ids="${escapeXml(node.evidenceIds.join(","))}"><rect x="${position.x}" y="${position.y}" width="240" height="64" rx="8" fill="#f8fafc" stroke="#334155" />`,
      `<text x="${position.x + 12}" y="${position.y + 27}" fill="#0f172a">${escapeXml(node.label.slice(0, 36))}</text>`,
      `<text x="${position.x + 12}" y="${position.y + 48}" fill="#475569" font-size="12">${escapeXml(`${node.level} · ${node.kind}`)}</text></g>`,
    );
  }
  parts.push("</g></svg>");
  return parts.join("");
}

export function exportHtml(snapshot: GraphSnapshot): string {
  const bundle = sanitizeExportBundle(snapshot);
  const svg = exportSvg(snapshot);
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`,
    `<title>CallFlow — ${escapeXml(bundle.workflowManifestId)}</title>`,
    "<style>body{margin:0;padding:1rem;background:#fff;color:#0f172a;font-family:system-ui,sans-serif}svg{width:100%;height:auto}</style>",
    "</head>",
    `<body data-callflow-graph-id="${escapeXml(bundle.graphId)}"><main><h1>CallFlow — ${escapeXml(bundle.workflowManifestId)}</h1><p>Default overlay: <code>${bundle.presentation.defaultOverlay}</code></p>${svg}</main></body>`,
    "</html>",
    "",
  ].join("\n");
}

import {
  CallFlowSourceExcerptSchema,
  CallFlowUiPayloadSchema,
  MAX_VISIBLE_NODES,
  type CallFlowSourceExcerpt,
  type CallFlowUiPayload,
} from "@callflow/contracts";

const SOURCE_MAX_BYTES = 24 * 1024;
const MAX_BOOTSTRAP_CHARS = 8 * 1024 * 1024;
const MAX_LAYOUT_COORDINATE = 10_000_000;

export interface NodeListResult {
  readonly nodeIds: readonly string[];
}

export interface LayoutPosition {
  readonly nodeId: string;
  readonly x: number;
  readonly y: number;
}

export interface LayoutResult {
  readonly schema: "callflow/layout-v1";
  readonly graphRevision: string;
  readonly engine: "elk" | "deterministic-fallback";
  readonly positions: readonly LayoutPosition[];
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function toolFailed(result: unknown): boolean {
  return isRecord(result) && result["isError"] === true;
}

export function metadataPayload(value: unknown): CallFlowUiPayload | undefined {
  if (!isRecord(value) || !isRecord(value["_meta"])) return undefined;
  const parsed = CallFlowUiPayloadSchema.safeParse(value["_meta"]["callflowGraph"]);
  return parsed.success ? parsed.data : undefined;
}

export function structuredRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) && isRecord(value["structuredContent"])
    ? value["structuredContent"]
    : undefined;
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseStringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_VISIBLE_NODES) return undefined;
  const nodeIds: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 160) return undefined;
    nodeIds.push(entry);
  }
  return nodeIds;
}

export function parseNodeListResult(value: unknown): NodeListResult | undefined {
  const nodeIds = parseStringList(structuredRecord(value)?.["nodeIds"]);
  return nodeIds ? { nodeIds } : undefined;
}

export function parseLayoutResult(value: unknown): LayoutResult | undefined {
  const structured = structuredRecord(value);
  if (
    !structured ||
    !hasExactKeys(structured, ["schema", "graphRevision", "engine", "positions"]) ||
    structured["schema"] !== "callflow/layout-v1" ||
    (structured["engine"] !== "elk" && structured["engine"] !== "deterministic-fallback") ||
    typeof structured["graphRevision"] !== "string" ||
    structured["graphRevision"].length === 0 ||
    structured["graphRevision"].length > 160 ||
    !Array.isArray(structured["positions"]) ||
    structured["positions"].length > MAX_VISIBLE_NODES
  ) {
    return undefined;
  }
  const positions: LayoutPosition[] = [];
  const seen = new Set<string>();
  for (const candidate of structured["positions"]) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ["nodeId", "x", "y"]) ||
      typeof candidate["nodeId"] !== "string" ||
      candidate["nodeId"].length === 0 ||
      candidate["nodeId"].length > 160 ||
      seen.has(candidate["nodeId"]) ||
      typeof candidate["x"] !== "number" ||
      typeof candidate["y"] !== "number" ||
      !Number.isFinite(candidate["x"]) ||
      !Number.isFinite(candidate["y"]) ||
      Math.abs(candidate["x"]) > MAX_LAYOUT_COORDINATE ||
      Math.abs(candidate["y"]) > MAX_LAYOUT_COORDINATE
    ) {
      return undefined;
    }
    seen.add(candidate["nodeId"]);
    positions.push({ nodeId: candidate["nodeId"], x: candidate["x"], y: candidate["y"] });
  }
  return {
    schema: "callflow/layout-v1",
    graphRevision: structured["graphRevision"],
    engine: structured["engine"],
    positions,
  };
}

export function parseBootstrapPayloadText(value: string | null): CallFlowUiPayload | undefined {
  if (!value || value.length > MAX_BOOTSTRAP_CHARS) return undefined;
  try {
    const parsed = CallFlowUiPayloadSchema.safeParse(JSON.parse(value));
    return parsed.success && parsed.data.capability.sourceByteBudget === 0
      ? parsed.data
      : undefined;
  } catch {
    return undefined;
  }
}

export function readBootstrapPayload(documentValue: Document): CallFlowUiPayload | undefined {
  const element = documentValue.getElementById("callflow-bootstrap");
  if (!(element instanceof HTMLScriptElement) || element.type !== "application/json") {
    return undefined;
  }
  return parseBootstrapPayloadText(element.textContent);
}

/** Source text is deliberately accepted only from private MCP metadata. */
export function parseSourceExcerpt(value: unknown): CallFlowSourceExcerpt | undefined {
  if (!isRecord(value) || !isRecord(value["_meta"])) return undefined;
  const parsed = CallFlowSourceExcerptSchema.safeParse(value["_meta"]["callflowSource"]);
  if (
    !parsed.success ||
    new TextEncoder().encode(parsed.data.content).byteLength > SOURCE_MAX_BYTES
  ) {
    return undefined;
  }
  return parsed.data;
}

import {
  CallFlowCapabilityUpdateSchema,
  CallFlowLayoutResultSchema,
  CallFlowNodeListResultSchema,
  CallFlowSourceExcerptSchema,
  CallFlowUiPayloadSchema,
  MAX_INITIAL_GRAPH_BYTES,
  type CallFlowCapabilityUpdate,
  type CallFlowLayoutResult,
  type CallFlowNodeListResult,
  type CallFlowSourceExcerpt,
  type CallFlowUiPayload,
} from "@callflow/contracts";
import { FlowZoneUiEnvelopeBaseSchema } from "@flowzone/contracts";

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function toolFailed(result: unknown): boolean {
  return isRecord(result) && result["isError"] === true;
}

export function metadataPayload(value: unknown): CallFlowUiPayload | undefined {
  if (!isRecord(value) || !isRecord(value["_meta"])) return undefined;
  const metadata = value["_meta"];
  const envelope = FlowZoneUiEnvelopeBaseSchema.safeParse(metadata["flowzone"]);
  if (
    envelope.success &&
    envelope.data.plugin === "callflow" &&
    envelope.data.action === "discover" &&
    envelope.data.view === "workflow"
  ) {
    const parsed = CallFlowUiPayloadSchema.safeParse(envelope.data.payload);
    if (parsed.success) return parsed.data;
  }
  const legacy = CallFlowUiPayloadSchema.safeParse(metadata["callflowGraph"]);
  return legacy.success ? legacy.data : undefined;
}

export function metadataCapabilityUpdate(value: unknown): CallFlowCapabilityUpdate | undefined {
  if (!isRecord(value) || !isRecord(value["_meta"])) return undefined;
  const parsed = CallFlowCapabilityUpdateSchema.safeParse(value["_meta"]["callflowCapability"]);
  return parsed.success ? parsed.data : undefined;
}

export function structuredRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) && isRecord(value["structuredContent"])
    ? value["structuredContent"]
    : undefined;
}

export function parseNodeListResult(value: unknown): CallFlowNodeListResult | undefined {
  const parsed = CallFlowNodeListResultSchema.safeParse(structuredRecord(value));
  return parsed.success ? parsed.data : undefined;
}

export function parseLayoutResult(value: unknown): CallFlowLayoutResult | undefined {
  const parsed = CallFlowLayoutResultSchema.safeParse(structuredRecord(value));
  return parsed.success ? parsed.data : undefined;
}

export function parseBootstrapPayloadText(value: string | null): CallFlowUiPayload | undefined {
  if (!value || value.length > MAX_INITIAL_GRAPH_BYTES) return undefined;
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
  return parsed.success ? parsed.data : undefined;
}

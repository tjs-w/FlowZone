import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
  type MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";

/** Parent-bound MCP transport that validates messages without logging their private payloads. */
export class QuietParentTransport implements Transport {
  readonly eventTarget: Window;
  readonly eventSource: MessageEventSource;
  readonly messageListener: (event: MessageEvent<unknown>) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;
  private started = false;

  constructor(
    eventTarget: Window = window.parent,
    eventSource: MessageEventSource = window.parent,
  ) {
    this.eventTarget = eventTarget;
    this.eventSource = eventSource;
    this.messageListener = (event) => {
      if (event.source !== this.eventSource) return;
      const parsed = JSONRPCMessageSchema.safeParse(event.data);
      if (parsed.success) {
        this.onmessage?.(parsed.data);
        return;
      }
      if (
        event.data !== null &&
        typeof event.data === "object" &&
        "jsonrpc" in event.data &&
        event.data.jsonrpc === "2.0"
      ) {
        this.onerror?.(new Error("The parent sent an invalid JSON-RPC message."));
      }
    };
  }

  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    this.started = true;
    window.addEventListener("message", this.messageListener);
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    this.eventTarget.postMessage(message, "*");
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (!this.started) return Promise.resolve();
    this.started = false;
    window.removeEventListener("message", this.messageListener);
    this.onclose?.();
    return Promise.resolve();
  }
}

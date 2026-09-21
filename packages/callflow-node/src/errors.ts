import { z } from "zod";

export type CallFlowErrorCode =
  | "aborted"
  | "adapter_failed"
  | "adapter_incompatible"
  | "adapter_stale"
  | "already_exists"
  | "invalid_input"
  | "invalid_manifest"
  | "invalid_output"
  | "not_found"
  | "output_too_large"
  | "path_denied"
  | "process_failed"
  | "source_changed"
  | "timeout"
  | "unavailable";

export class CallFlowError extends Error {
  readonly code: CallFlowErrorCode;
  readonly retryable: boolean;

  constructor(code: CallFlowErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "CallFlowError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function asCallFlowError(error: unknown): CallFlowError {
  if (error instanceof CallFlowError) return error;
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return new CallFlowError("invalid_input", "CallFlow rejected schema-invalid input.");
  }
  return new CallFlowError("unavailable", "CallFlow could not complete the request.", true);
}

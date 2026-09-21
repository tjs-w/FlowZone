import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { spawn } from "node:child_process";

import { CallFlowError } from "./errors.js";

export const DEFAULT_PROCESS_TIMEOUT_MS = 30_000;
export const DEFAULT_PROCESS_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface ProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maximumOutputBytes?: number;
  readonly stdin?: string;
  readonly environment?: Readonly<Record<string, string>>;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

export async function resolveExecutable(candidates: readonly string[]): Promise<string> {
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue through the fixed, trusted candidate list.
    }
  }
  throw new CallFlowError("unavailable", "A required local executable is unavailable.", true);
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  state: { bytes: number },
  maximumBytes: number,
): boolean {
  if (state.bytes + chunk.byteLength > maximumBytes) return false;
  chunks.push(Buffer.from(chunk));
  state.bytes += chunk.byteLength;
  return true;
}

export const runBoundedProcess: ProcessRunner = async (
  request: ProcessRequest,
): Promise<ProcessResult> => {
  if (!isAbsolute(request.executable)) {
    throw new CallFlowError("invalid_input", "Executable paths must be absolute.");
  }
  if (request.signal?.aborted === true) {
    throw new CallFlowError("aborted", "The CallFlow operation was cancelled.", true);
  }
  const maximumBytes = request.maximumOutputBytes ?? DEFAULT_PROCESS_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new CallFlowError("invalid_input", "The subprocess output limit is invalid.");
  }

  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      env: {
        ...request.environment,
        PATH: process.env["PATH"],
        LANG: process.env["LANG"] ?? "C.UTF-8",
        LC_ALL: process.env["LC_ALL"] ?? "C.UTF-8",
      },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const state = { bytes: 0 };
    let settled = false;
    let terminationError: CallFlowError | undefined;

    const finish = (error?: CallFlowError, result?: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new CallFlowError("process_failed", "The local process failed."));
    };
    const terminate = (error: CallFlowError): void => {
      terminationError = error;
      child.kill("SIGKILL");
    };
    const onAbort = (): void => {
      terminate(new CallFlowError("aborted", "The CallFlow operation was cancelled.", true));
    };
    const timer = setTimeout(() => {
      terminate(new CallFlowError("timeout", "The local analysis process timed out.", true));
    }, request.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS);
    timer.unref();

    request.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", () => {
      finish(
        new CallFlowError("process_failed", "The local analysis process could not start.", true),
      );
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (!appendBounded(stdout, chunk, state, maximumBytes)) {
        terminate(
          new CallFlowError("output_too_large", "The local analysis output exceeded its limit."),
        );
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (!appendBounded(stderr, chunk, state, maximumBytes)) {
        terminate(
          new CallFlowError("output_too_large", "The local analysis output exceeded its limit."),
        );
      }
    });
    child.stdin.on("error", () => {
      // A child may exit before consuming stdin. Its close/error event owns
      // the externally visible result, so suppress a redundant EPIPE event.
    });
    child.on("close", (exitCode) => {
      if (terminationError) {
        finish(terminationError);
        return;
      }
      finish(undefined, {
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });

    if (request.stdin === undefined) child.stdin.end();
    else child.stdin.end(request.stdin, "utf8");
  });
};

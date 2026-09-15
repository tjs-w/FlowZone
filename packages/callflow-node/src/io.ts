import { randomUUID } from "node:crypto";
import { open, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { canonicalStringify } from "@callflow/core";

import { CallFlowError } from "./errors.js";

export const MAX_CALLFLOW_JSON_BYTES = 2 * 1024 * 1024;

export async function readBoundedJsonFile(pathInput: string): Promise<unknown> {
  const path = await realpath(resolve(pathInput)).catch(() => {
    throw new CallFlowError("not_found", "The requested JSON file is unavailable.");
  });
  const fileStat = await stat(path);
  if (!fileStat.isFile() || fileStat.size > MAX_CALLFLOW_JSON_BYTES) {
    throw new CallFlowError(
      "invalid_input",
      "The requested JSON file is not a bounded regular file.",
    );
  }
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error: unknown) {
    if (error instanceof CallFlowError) throw error;
    throw new CallFlowError("invalid_input", "The requested file does not contain valid JSON.");
  }
}

export async function readBoundedStdin(
  input: NodeJS.ReadableStream = process.stdin,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const rawChunk of input) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    bytes += chunk.byteLength;
    if (bytes > MAX_CALLFLOW_JSON_BYTES) {
      throw new CallFlowError("invalid_input", "Standard input exceeded the JSON size limit.");
    }
    chunks.push(chunk);
  }
  if (bytes === 0) throw new CallFlowError("invalid_input", "Expected JSON on standard input.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new CallFlowError("invalid_input", "Standard input does not contain valid JSON.");
  }
}

export function stableJson(value: unknown): string {
  return `${canonicalStringify(value)}\n`;
}

function explicitOutputPath(pathInput: string): string {
  if (!pathInput || pathInput.includes("\0") || /[\r\n]/.test(pathInput)) {
    throw new CallFlowError("invalid_input", "The output path is invalid.");
  }
  return resolve(pathInput);
}

export async function createJsonFile(pathInput: string, value: unknown): Promise<string> {
  return await createTextFile(pathInput, stableJson(value));
}

export async function createTextFile(pathInput: string, content: string): Promise<string> {
  const path = explicitOutputPath(pathInput);
  const parent = await realpath(dirname(path)).catch(() => {
    throw new CallFlowError("not_found", "The output directory is unavailable.");
  });
  const destination = resolve(parent, basename(path));
  const handle = await open(destination, "wx", 0o600).catch((error: unknown) => {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "EEXIST") {
      throw new CallFlowError("already_exists", "The destination file already exists.");
    }
    throw new CallFlowError("unavailable", "The destination file could not be created.");
  });
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return destination;
}

export async function replaceJsonFile(pathInput: string, value: unknown): Promise<string> {
  const path = explicitOutputPath(pathInput);
  const parent = await realpath(dirname(path)).catch(() => {
    throw new CallFlowError("not_found", "The output directory is unavailable.");
  });
  const destination = resolve(parent, basename(path));
  const temporary = resolve(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, stableJson(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } catch {
    await unlink(temporary).catch(() => undefined);
    throw new CallFlowError("unavailable", "The generated snapshot could not be replaced.");
  }
  return destination;
}

export function generatedSnapshotPath(manifestPath: string): string {
  const absolute = explicitOutputPath(manifestPath);
  return absolute.endsWith(".json")
    ? `${absolute.slice(0, -".json".length)}.generated.json`
    : `${absolute}.generated.json`;
}

export function requireAbsolutePath(pathInput: string, purpose: string): string {
  if (!isAbsolute(pathInput)) {
    throw new CallFlowError("invalid_input", `${purpose} requires an absolute path.`);
  }
  return resolve(pathInput);
}

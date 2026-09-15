import { createHash } from "node:crypto";

/** Vetted SHA-256 content addressing; this is hashing, never credential storage. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Locale-independent UTF-16 ordering for byte-stable output across hosts. */
export function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Canonical values cannot contain non-finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (typeof value === "undefined") return "null";
  if (typeof value !== "object")
    throw new TypeError(`Unsupported canonical value: ${typeof value}.`);
  if (seen.has(value)) throw new TypeError("Canonical values cannot contain cycles.");
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item, seen)).join(",")}]`;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical values must contain only arrays and plain objects.");
    }
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort(compareStableStrings)
      .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key], seen)}`);
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalStringify(value: unknown): string {
  return canonicalize(value, new Set<object>());
}

export function digestOf(value: unknown): `sha256:${string}` {
  return `sha256:${sha256Hex(canonicalStringify(value))}`;
}

export type StableIdKind = "manifest" | "graph" | "node" | "edge" | "evidence" | "diff";

export function stableId(kind: StableIdKind, identity: unknown): string {
  return `cf-${kind}-${sha256Hex(`${kind}\0${canonicalStringify(identity)}`)}`;
}

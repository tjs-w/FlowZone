import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DynaScheduleTaskInventory } from "@flowzone/dyna-node";

const MAX_AUTOMATIONS = 256;
const MAX_AUTOMATION_BYTES = 64 * 1_024;
const MAX_TOTAL_BYTES = 1 * 1_024 * 1_024;
const TOML_STRING = '"(?:\\\\.|[^"\\\\])*"';

function parseTomlString(line: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(${TOML_STRING})\\s*(?:#.*)?$`, "u").exec(line);
  if (!match?.[1]) return undefined;
  const parsed = JSON.parse(match[1]) as unknown;
  return typeof parsed === "string" ? parsed : undefined;
}

/**
 * Read only the immediate automation kind and target task identity needed to
 * keep scheduled work out of automatic Dyna discovery. Any ambiguity fails
 * closed so the controller can continue linked-task reconciliation without
 * importing a scheduled task.
 */
export function readDynaScheduleTaskInventory(
  environment: NodeJS.ProcessEnv = process.env,
): DynaScheduleTaskInventory {
  try {
    const configuredCodexHome = environment["CODEX_HOME"]?.trim();
    const normalizedCodexHome = configuredCodexHome === "" ? undefined : configuredCodexHome;
    const codexHome = normalizedCodexHome ?? join(homedir(), ".codex");
    const root = join(codexHome, "automations");
    const rootStatus = lstatSync(root);
    if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) return { state: "unavailable" };
    const entries = readdirSync(root, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink());
    if (directories.length > MAX_AUTOMATIONS) return { state: "unavailable" };
    const taskIds = new Set<string>();
    let totalBytes = 0;
    for (const entry of directories) {
      if (entry.isSymbolicLink()) return { state: "unavailable" };
      if (!entry.isDirectory()) return { state: "unavailable" };
      const path = join(root, entry.name, "automation.toml");
      const status = lstatSync(path);
      if (!status.isFile() || status.isSymbolicLink() || status.size > MAX_AUTOMATION_BYTES) {
        return { state: "unavailable" };
      }
      totalBytes += status.size;
      if (totalBytes > MAX_TOTAL_BYTES) return { state: "unavailable" };
      const source = readFileSync(path, "utf8");
      let kind: string | undefined;
      let targetThreadId: string | undefined;
      for (const line of source.split(/\r?\n/u)) {
        const parsedKind = parseTomlString(line, "kind");
        if (parsedKind !== undefined) {
          if (kind !== undefined) return { state: "unavailable" };
          kind = parsedKind;
        }
        const parsedTarget = parseTomlString(line, "target_thread_id");
        if (parsedTarget !== undefined) {
          if (targetThreadId !== undefined) return { state: "unavailable" };
          targetThreadId = parsedTarget;
        }
      }
      if (kind !== "heartbeat" && kind !== "cron") return { state: "unavailable" };
      if (targetThreadId !== undefined) {
        const normalized = targetThreadId.trim();
        if (!normalized || normalized.length > 512) return { state: "unavailable" };
        taskIds.add(normalized);
      }
    }
    return { state: "available", taskIds: [...taskIds].sort() };
  } catch {
    return { state: "unavailable" };
  }
}

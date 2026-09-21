import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Dyna application authority", () => {
  test("keeps implementation-derived types and the legacy service alias out of the public boundary", () => {
    const source = readFileSync(resolve(import.meta.dir, "../src/service.ts"), "utf8");
    expect(source).not.toContain("Parameters<DynaRepository");
    expect(source).not.toContain("ReturnType<DynaRepository");
    expect(source).not.toContain("class DynaService");
  });

  test("enforces bounded actor capabilities at application entry points", () => {
    const fixture = resolve(import.meta.dir, "application-capabilities-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      boundedRead: true,
      deniedBeforePersistence: true,
      todoCreateIsolation: true,
      invalidDescriptorsRejected: true,
    });
  });
});

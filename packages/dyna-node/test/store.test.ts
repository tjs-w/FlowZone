import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

describe("DynaStore lifecycle", () => {
  test("passes Node-native claim lease and schedule freshness checks", () => {
    const fixture = resolve(import.meta.dir, "store-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      claim: "needs_reconciliation",
      freshness: "stale",
    });
  });

  test("isolates dashboard preferences and publisher identities with retry-safe mutations", () => {
    const fixture = resolve(import.meta.dir, "integrity-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      isolated: true,
      idempotent: true,
      aggregate: true,
      search: true,
    });
  });

  test("migrates legacy completed tasks and excludes completed work from focus counts", () => {
    const fixture = resolve(import.meta.dir, "migration-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ migrated: true, completedIsNotFocus: true });
  });

  test("serializes publication against publisher revocation and credential rotation", () => {
    const fixture = resolve(import.meta.dir, "publisher-race-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ revokeRace: true, rotateRace: true });
  });
});

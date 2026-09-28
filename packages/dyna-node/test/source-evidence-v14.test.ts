import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("correlates only proven source records and retains work through outages", () => {
  const fixture = resolve(import.meta.dir, "source-evidence-v14-node-fixture.mjs");
  const result = spawnSync("node", [fixture], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    correlated: true,
    jiraFirstCorrelated: true,
    stable: true,
    staleRetained: true,
    noCurrentRetained: true,
    titleNotMerged: true,
    lateMergeAlias: true,
    correctionRestored: true,
    exactSourceAction: true,
    conflictingKeysWarned: true,
  });
});

test("migrates v13 cards without changing identity, history, or legacy sharing", () => {
  const fixture = resolve(import.meta.dir, "source-evidence-v14-migration-node-fixture.mjs");
  const result = spawnSync("node", [fixture], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ migrated: true, legacyShared: true });
});

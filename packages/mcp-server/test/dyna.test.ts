import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

describe("Dyna publisher source manifest actions", () => {
  test("bulk-moves active queue items through one bounded app-private operation", () => {
    const fixture = resolve(import.meta.dir, "dyna-bulk-organize-node-fixture.mjs");
    const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-bulk-organize-"));
    const bundledFixture = join(directory, "fixture.mjs");
    try {
      const build = spawnSync(
        process.execPath,
        ["build", fixture, "--target=node", "--outfile", bundledFixture],
        { encoding: "utf8" },
      );
      expect(build.status, build.stderr).toBe(0);
      const result = spawnSync("node", [bundledFixture], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        boundedSchema: true,
        atomicHandler: true,
        legacyShape: true,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);

  test("keeps direct taskless workflow changes capability-bound and app-private", () => {
    const fixture = resolve(import.meta.dir, "dyna-item-status-node-fixture.mjs");
    const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-item-status-"));
    const bundledFixture = join(directory, "fixture.mjs");
    try {
      const build = spawnSync(
        process.execPath,
        ["build", fixture, "--target=node", "--outfile", bundledFixture],
        { encoding: "utf8" },
      );
      expect(build.status, build.stderr).toBe(0);
      const result = spawnSync("node", [bundledFixture], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        appPrivate: true,
        strictCompletion: true,
        exactReplay: true,
        capabilityBound: true,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);

  test("keeps the Codex session picker capability-bound and app-private", () => {
    const fixture = resolve(import.meta.dir, "dyna-session-picker-node-fixture.mjs");
    const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-session-picker-"));
    const bundledFixture = join(directory, "fixture.mjs");
    try {
      const build = spawnSync(
        process.execPath,
        ["build", fixture, "--target=node", "--outfile", bundledFixture],
        { encoding: "utf8" },
      );
      expect(build.status, build.stderr).toBe(0);
      const result = spawnSync("node", [bundledFixture], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        prepareSchema: true,
        privateMetadata: true,
        transcriptRejected: true,
        exactAttachment: true,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);

  test("creates, binds, lists, and idempotently reconciles an immutable manifest", () => {
    const fixture = resolve(import.meta.dir, "dyna-node-fixture.mjs");
    const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-mcp-action-"));
    const bundledFixture = join(directory, "fixture.mjs");
    try {
      const build = spawnSync(
        process.execPath,
        ["build", fixture, "--target=node", "--outfile", bundledFixture],
        { encoding: "utf8" },
      );
      expect(build.status, build.stderr).toBe(0);
      const result = spawnSync("node", [bundledFixture], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        createSchema: true,
        disabledByDefault: true,
        disabledEnforced: true,
        disabledUpgraded: true,
        localPreviewOperational: true,
        localCliRegistered: true,
        localCliSecretFree: true,
        localCliMcpPublishSeparated: true,
        scheduledManualRejected: true,
        latestSlicesExposed: true,
        manifestRequired: true,
        bindSchema: true,
        updateSchema: true,
        inventory: true,
        immutable: true,
        mutationAnnotations: true,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);
});

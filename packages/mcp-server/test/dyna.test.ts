import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../../..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

function actorProfile(source: string, name: string): string {
  const match = new RegExp(
    `const ${name} = \\{[\\s\\S]*?\\} as const satisfies DynaApplicationActor;`,
    "u",
  ).exec(source);
  if (!match) throw new Error(`Missing ${name} actor profile`);
  return match[0];
}

describe("Dyna architecture boundaries", () => {
  test("keeps SQLite and repository access behind protocol-neutral boundaries", () => {
    const productionFiles = [
      ...sourceFiles(resolve(repositoryRoot, "packages/dyna-node/src")),
      ...sourceFiles(resolve(repositoryRoot, "packages/mcp-server/src")),
      ...sourceFiles(resolve(repositoryRoot, "server/src")),
    ];
    const sqliteImporters = productionFiles
      .filter((path) => /from\s+["']node:sqlite["']/u.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(repositoryRoot.length + 1))
      .sort();
    expect(sqliteImporters).toEqual(["packages/dyna-node/src/repository.ts"]);

    const packageEntry = readFileSync(
      resolve(repositoryRoot, "packages/dyna-node/src/index.ts"),
      "utf8",
    );
    expect(packageEntry).not.toMatch(/(?:repository|store)\.js/u);

    const adapters = [
      "packages/mcp-server/src/plugins/dyna.ts",
      "server/src/dyna.ts",
      "server/src/publish.ts",
    ];
    for (const adapter of adapters) {
      const source = readFileSync(resolve(repositoryRoot, adapter), "utf8");
      expect(source, `${adapter} must use DynaApplicationService`).toContain(
        "DynaApplicationService",
      );
      expect(source, `${adapter} must not depend on DynaStore`).not.toMatch(/\bDynaStore\b/u);
      expect(source, `${adapter} must not depend on DynaRepository`).not.toMatch(
        /\bDynaRepository\b/u,
      );
      expect(source, `${adapter} must not import persistence modules`).not.toMatch(
        /(?:@flowzone\/dyna-node|\.\.?(?:\/[^/"']+)*)\/(?:repository|store)(?:\.js)?["']/u,
      );
      expect(source, `${adapter} must not bypass the application service`).not.toMatch(
        /\bservice\.(?:store|repository)\b/u,
      );
      expect(source, `${adapter} must select an explicit actor`).not.toMatch(
        /new DynaApplicationService\(\s*\)/u,
      );
    }

    const cliActor = actorProfile(
      readFileSync(resolve(repositoryRoot, "server/src/dyna.ts"), "utf8"),
      "DYNA_CLI_ACTOR",
    );
    expect(cliActor).toContain('kind: "codex_task"');
    expect(cliActor).toContain('"dashboard:read"');
    expect(cliActor).toContain('"item:read"');
    expect(cliActor).toContain('"item:write"');
    expect(cliActor).not.toMatch(
      /publisher:|dashboard:manage|view:interact|action:execute|backup/u,
    );

    const publisherActor = actorProfile(
      readFileSync(resolve(repositoryRoot, "server/src/publish.ts"), "utf8"),
      "DYNA_PUBLISHER_ACTOR",
    );
    expect(publisherActor).toContain('kind: "publisher"');
    expect(publisherActor).toContain('capabilities: ["publisher:publish"]');

    const mcpActor = actorProfile(
      readFileSync(resolve(repositoryRoot, "packages/mcp-server/src/plugins/dyna.ts"), "utf8"),
      "DYNA_MCP_ACTOR",
    );
    for (const capability of [
      "dashboard:read",
      "dashboard:manage",
      "item:read",
      "item:write",
      "publisher:publish",
      "publisher:manage",
      "view:interact",
      "action:execute",
    ]) {
      expect(mcpActor).toContain(`"${capability}"`);
    }
    expect(mcpActor).not.toContain('"maintenance:backup"');

    const applicationService = readFileSync(
      resolve(repositoryRoot, "packages/dyna-node/src/service.ts"),
      "utf8",
    );
    for (const forbidden of [
      /from\s+["']node:sqlite["']/u,
      /from\s+["']node:https?["']/u,
      /from\s+["']@modelcontextprotocol\//u,
      /\bDatabaseSync\b/u,
      /\bprocess\s*\./u,
      /\bfetch\s*\(/u,
      /\.prepare\s*\(/u,
      /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|PRAGMA|BEGIN|COMMIT|ROLLBACK|VACUUM)\b/u,
    ]) {
      expect(applicationService, `application service contains ${String(forbidden)}`).not.toMatch(
        forbidden,
      );
    }
  });
});

describe("Dyna publisher source manifest actions", () => {
  test("bridges linked-task pull synchronization through private app tools and bounded controller actions", () => {
    const fixture = resolve(import.meta.dir, "dyna-task-sync-node-fixture.mjs");
    const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-task-sync-"));
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
        exactScope: true,
        boundedControllerActions: true,
        privateCapabilities: true,
        cancellationBoundary: true,
        transcriptRejected: true,
        rawErrorsRejected: true,
        missingOutcomeIsPublicCountOnly: true,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);

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
        ownershipPreflight: true,
        directReservationRequired: true,
        reservationReplay: true,
        claimReservationRace: true,
        sameItemRefreshIdempotent: true,
        canonicalTitleRequired: true,
        attachmentReconciliation: true,
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
        enrichmentContractPreserved: true,
        enrichmentDelegatedToApplication: true,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);
});

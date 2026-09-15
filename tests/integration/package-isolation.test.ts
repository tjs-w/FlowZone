import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const sourceRoot = resolve(import.meta.dir, "../..");
const temporaryDirectories: string[] = [];

async function installShippingArtifacts(pluginRoot: string): Promise<void> {
  await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
  await mkdir(join(pluginRoot, "bin"), { recursive: true });
  await mkdir(join(pluginRoot, "server", "dist"), { recursive: true });
  await mkdir(join(pluginRoot, "web", "dist"), { recursive: true });
  await mkdir(join(pluginRoot, "licenses"), { recursive: true });
  await Promise.all([
    copyFile(
      join(sourceRoot, ".codex-plugin", "plugin.json"),
      join(pluginRoot, ".codex-plugin", "plugin.json"),
    ),
    copyFile(join(sourceRoot, ".mcp.json"), join(pluginRoot, ".mcp.json")),
    cp(join(sourceRoot, "skills"), join(pluginRoot, "skills"), { recursive: true }),
    copyFile(join(sourceRoot, "bin", "flowzone-mcp"), join(pluginRoot, "bin", "flowzone-mcp")),
    copyFile(
      join(sourceRoot, "bin", "flowzone-publish"),
      join(pluginRoot, "bin", "flowzone-publish"),
    ),
    copyFile(join(sourceRoot, "bin", "dyna"), join(pluginRoot, "bin", "dyna")),
    copyFile(join(sourceRoot, "bin", "callflow"), join(pluginRoot, "bin", "callflow")),
    copyFile(join(sourceRoot, "bin", "callflow.cmd"), join(pluginRoot, "bin", "callflow.cmd")),
    copyFile(
      join(sourceRoot, "server", "dist", "server.cjs"),
      join(pluginRoot, "server", "dist", "server.cjs"),
    ),
    copyFile(
      join(sourceRoot, "server", "dist", "flowzone-publish.cjs"),
      join(pluginRoot, "server", "dist", "flowzone-publish.cjs"),
    ),
    copyFile(
      join(sourceRoot, "server", "dist", "dyna.cjs"),
      join(pluginRoot, "server", "dist", "dyna.cjs"),
    ),
    copyFile(
      join(sourceRoot, "server", "dist", "callflow.cjs"),
      join(pluginRoot, "server", "dist", "callflow.cjs"),
    ),
    copyFile(
      join(sourceRoot, "server", "dist", "callflow-layout-worker.cjs"),
      join(pluginRoot, "server", "dist", "callflow-layout-worker.cjs"),
    ),
    copyFile(join(sourceRoot, "web", "flowzone.html"), join(pluginRoot, "web", "flowzone.html")),
    copyFile(
      join(sourceRoot, "web", "dist", "flowzone.js"),
      join(pluginRoot, "web", "dist", "flowzone.js"),
    ),
    copyFile(join(sourceRoot, "web", "dyna.html"), join(pluginRoot, "web", "dyna.html")),
    copyFile(
      join(sourceRoot, "web", "dist", "dyna.js"),
      join(pluginRoot, "web", "dist", "dyna.js"),
    ),
    copyFile(
      join(sourceRoot, "web", "dist", "dyna.css"),
      join(pluginRoot, "web", "dist", "dyna.css"),
    ),
    copyFile(join(sourceRoot, "web", "callflow.html"), join(pluginRoot, "web", "callflow.html")),
    copyFile(
      join(sourceRoot, "web", "dist", "callflow.js"),
      join(pluginRoot, "web", "dist", "callflow.js"),
    ),
    copyFile(
      join(sourceRoot, "web", "dist", "callflow.css"),
      join(pluginRoot, "web", "dist", "callflow.css"),
    ),
    cp(join(sourceRoot, "licenses", "callflow"), join(pluginRoot, "licenses", "callflow"), {
      recursive: true,
    }),
  ]);
  const [sourceLicenseFiles, installedLicenseFiles] = await Promise.all([
    readdir(join(sourceRoot, "licenses", "callflow")),
    readdir(join(pluginRoot, "licenses", "callflow")),
  ]);
  expect(installedLicenseFiles.sort()).toEqual(sourceLicenseFiles.sort());
  for (const licenseFile of sourceLicenseFiles) {
    const [sourceLicense, installedLicense] = await Promise.all([
      readFile(join(sourceRoot, "licenses", "callflow", licenseFile)),
      readFile(join(pluginRoot, "licenses", "callflow", licenseFile)),
    ]);
    expect(installedLicense).toEqual(sourceLicense);
  }
  await chmod(join(pluginRoot, "bin", "flowzone-mcp"), 0o755);
  await chmod(join(pluginRoot, "bin", "flowzone-publish"), 0o755);
  await chmod(join(pluginRoot, "bin", "dyna"), 0o755);
  await chmod(join(pluginRoot, "bin", "callflow"), 0o755);
  await chmod(join(pluginRoot, "skills", "dyna", "scripts", "reconcile-cli-rule.sh"), 0o755);
}

async function validateInstalledSkillReferences(pluginRoot: string): Promise<void> {
  const manifest = JSON.parse(
    await readFile(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
  ) as { readonly skills?: unknown; readonly mcpServers?: unknown };
  expect(manifest.skills).toBe("./skills/");
  expect(manifest.mcpServers).toBe("./.mcp.json");

  const pending = [
    join(pluginRoot, "skills", "dyna", "SKILL.md"),
    join(pluginRoot, "skills", "markdown-review", "SKILL.md"),
    join(pluginRoot, "skills", "callflow", "SKILL.md"),
  ];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.shift();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const markdown = await readFile(file, "utf8");
    for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+\.md)(?:#[^)]+)?\)/gu)) {
      const reference = match[1];
      if (!reference || reference.includes(":")) continue;
      const target = resolve(file, "..", reference);
      expect(target.startsWith(join(pluginRoot, "skills"))).toBe(true);
      await access(target);
      pending.push(target);
    }
  }
  const taskUpdatesPath = join(pluginRoot, "skills", "dyna", "references", "task-updates.md");
  expect(visited).toContain(taskUpdatesPath);
  const taskPullSyncPath = join(pluginRoot, "skills", "dyna", "references", "task-pull-sync.md");
  expect(visited).toContain(taskPullSyncPath);
  expect(visited).toContain(
    join(pluginRoot, "skills", "callflow", "references", "evidence-policy.md"),
  );
  expect(visited).toContain(
    join(pluginRoot, "skills", "callflow", "references", "workflow-authoring.md"),
  );
  expect(visited).toContain(
    join(pluginRoot, "skills", "callflow", "references", "cli-reference.md"),
  );
  const callFlowSkill = await readFile(join(pluginRoot, "skills", "callflow", "SKILL.md"), "utf8");
  expect(callFlowSkill).toContain("$flowzone:callflow");
  expect(callFlowSkill).toContain('{"plugin":"callflow","action":"discover","input":{...}}');
  expect(callFlowSkill).not.toContain("$callflow:callflow");
  const dynaSkill = await readFile(join(pluginRoot, "skills", "dyna", "SKILL.md"), "utf8");
  for (const contractMarker of [
    "Before any task-originated mutation",
    "Do not attach a collector or administration task",
    "`expectedTitle` is advisory stored state, neither evidence nor the full desired title",
    "canonicalize its controller-observed current suffix",
    "never enforce or copy the stored expected suffix",
    "submit that target as unavailable",
  ]) {
    expect(dynaSkill.toLocaleLowerCase()).toContain(contractMarker.toLocaleLowerCase());
  }
  const taskUpdates = await readFile(taskUpdatesPath, "utf8");
  for (const contractMarker of [
    "reconcile-cli-rule.sh --check",
    "Do not set `FLOWZONE_DATA_DIR`",
    "## Strict mutation inputs",
    "dyna dashboard list",
    "dyna dashboard show",
    "dyna item search",
    "dyna item show",
    "dyna item history",
    "dyna item activity",
    "dyna work update",
    "dyna work enrich",
    "dyna organize place",
    "dyna organize place-many",
    "dyna lifecycle archive",
    "dyna lifecycle restore",
    "dyna todo create",
    "dyna follow-up create",
    "returns at most 100 dashboards",
    "returns at most 20 operational briefs",
    "accepts at most 50 records",
    "accepts at most 25 updates",
    '"targetPriority"',
    '"reasonDetail"',
    "`lifecycle restore` accepts exactly",
    "`follow-up create` accepts",
    "old `item update`",
    "omitted overlay fields are cleared",
    "## Mandatory receiving-task preflight",
    "Before any task-originated mutation of the referenced item",
    "Notes and decisions are not exceptions",
    "every bundled-CLI work update from the receiving task must include",
    "exact code-point equality",
    "Only after `attach-codex-task` succeeds",
    "stop without running the mutation",
    "new to-do created to represent the current task",
    "Do not attach a collector or administration task",
    "rejects an unattributed update before consuming its request ID",
  ]) {
    expect(taskUpdates.toLocaleLowerCase()).toContain(contractMarker.toLocaleLowerCase());
  }
  const taskPullSync = await readFile(taskPullSyncPath, "utf8");
  for (const contractMarker of [
    "`expectedTitle` is an advisory, potentially stale baseline",
    "Never enforce or copy `expectedTitle` into an observation",
    "For every target, call `read_thread`",
    "using the target's `itemNumber`",
    "preserve the remaining current suffix",
    "not to `expectedTitle`",
    "exact code-point equality",
    "submit the target as unavailable",
    "must come from the exact native read-back",
    "never a locally copied expectation or the compact snapshot",
  ]) {
    expect(taskPullSync.toLocaleLowerCase()).toContain(contractMarker.toLocaleLowerCase());
  }
}

async function createShippingTransport(
  pluginRoot: string,
  dataDirectory: string,
): Promise<StdioClientTransport> {
  const manifest = JSON.parse(await readFile(join(pluginRoot, ".mcp.json"), "utf8")) as {
    mcpServers: {
      flowzone: { command: string; args?: string[]; cwd?: string };
    };
  };
  const definition = manifest.mcpServers.flowzone;
  const command = definition.command.startsWith("./")
    ? resolve(pluginRoot, definition.command)
    : definition.command;
  const cwd = definition.cwd ? resolve(pluginRoot, definition.cwd) : pluginRoot;
  return new StdioClientTransport({
    command,
    args: definition.args ?? [],
    cwd,
    env: {
      FLOWZONE_DATA_DIR: dataDirectory,
      // Match the desktop host's restricted PATH. The launcher must not depend on Homebrew
      // being inherited by the Codex process.
      PATH: "/usr/bin:/bin",
    },
    stderr: "pipe",
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("isolated shipping package", () => {
  test("reconciles an exact installed Dyna rule for the shared default store", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "flowzone-dyna-rule-"));
    temporaryDirectories.push(temporaryRoot);
    const codexHome = join(temporaryRoot, "Codex home ü");
    const userHome = join(temporaryRoot, "User home Δ");
    const pluginRoot = join(
      codexHome,
      "plugins",
      "cache",
      "flowzone",
      "flowzone",
      "0.1.0+codex.first",
    );
    await Promise.all([
      mkdir(codexHome, { recursive: true }),
      mkdir(userHome, { recursive: true }),
    ]);
    await installShippingArtifacts(pluginRoot);
    const canonicalPluginRoot = await realpath(pluginRoot);

    const reconciler = join(pluginRoot, "skills", "dyna", "scripts", "reconcile-cli-rule.sh");
    const reconcileEnvironment = {
      CODEX_HOME: codexHome,
      HOME: userHome,
      PATH: "/usr/bin:/bin",
    };
    const sourceCheckoutAttempt = spawnSync(
      join(sourceRoot, "skills", "dyna", "scripts", "reconcile-cli-rule.sh"),
      ["--install"],
      {
        cwd: userHome,
        encoding: "utf8",
        env: reconcileEnvironment,
      },
    );
    expect(sourceCheckoutAttempt.status).toBe(1);
    expect(JSON.parse(sourceCheckoutAttempt.stderr)).toMatchObject({
      schema: "dyna/cli-rule-status-v1",
      status: "error",
      code: "not_installed",
    });
    const initial = spawnSync(reconciler, ["--check"], {
      cwd: userHome,
      encoding: "utf8",
      env: reconcileEnvironment,
    });
    expect(initial.status).toBe(0);
    expect(JSON.parse(initial.stdout)).toEqual({
      schema: "dyna/cli-rule-status-v1",
      status: "missing",
      restartRequired: true,
    });

    const installed = spawnSync(reconciler, ["--install"], {
      cwd: userHome,
      encoding: "utf8",
      env: reconcileEnvironment,
    });
    expect(installed.status).toBe(0);
    expect(JSON.parse(installed.stdout)).toEqual({
      schema: "dyna/cli-rule-status-v1",
      status: "ready",
      restartRequired: true,
    });

    const rulePath = join(codexHome, "rules", "flowzone-dyna-worker.rules");
    const rule = await readFile(rulePath, "utf8");
    expect(rule).toContain(`"${join(canonicalPluginRoot, "bin", "dyna")}"`);
    expect(rule).toContain('["list", "show"]');
    expect(rule).toContain('["search", "show", "history", "activity"]');
    expect(rule).toContain('["update", "enrich"]');
    expect(rule).toContain('["place", "place-many"]');
    expect(rule).toContain('["archive", "restore"]');
    expect(rule).toContain('"todo"');
    expect(rule).toContain('"follow-up"');
    expect(rule).toContain('"create"');
    expect(rule).toContain('"setup"');
    expect(rule).not.toContain('["show", "update", "enrich", "place", "archive", "restore"]');
    expect(rule).not.toContain(sourceRoot);
    expect(rule).not.toContain("FLOWZONE_DATA_DIR");
    expect(rule).not.toContain('pattern = ["sh"');
    expect(rule).not.toContain('pattern = ["node"');
    expect((await stat(rulePath)).mode & 0o777).toBe(0o600);

    const ready = spawnSync(reconciler, ["--check"], {
      cwd: userHome,
      encoding: "utf8",
      env: reconcileEnvironment,
    });
    expect(ready.status).toBe(0);
    expect(JSON.parse(ready.stdout)).toEqual({
      schema: "dyna/cli-rule-status-v1",
      status: "ready",
      restartRequired: false,
    });

    const version = spawnSync(join(pluginRoot, "bin", "dyna"), ["--version"], {
      cwd: userHome,
      encoding: "utf8",
      env: {
        CODEX_HOME: codexHome,
        HOME: userHome,
        FLOWZONE_DATA_DIR: join(temporaryRoot, "caller-selected-data"),
        PATH: "/usr/bin:/bin",
      },
    });
    expect(version.status).toBe(0);
    expect(JSON.parse(version.stdout)).toMatchObject({ schema: "dyna/version-v1" });
    expect(version.stderr).toBe("");

    const codex = spawnSync("codex", ["--version"], { encoding: "utf8" });
    if (codex.status === 0) {
      const decision = (command: readonly string[]): string | undefined => {
        const checked = spawnSync(
          "codex",
          ["execpolicy", "check", "--rules", rulePath, "--", ...command],
          { encoding: "utf8" },
        );
        expect(checked.status).toBe(0);
        return (JSON.parse(checked.stdout) as { readonly decision?: string }).decision;
      };
      const launcher = join(canonicalPluginRoot, "bin", "dyna");
      expect(decision([launcher, "item", "show", "--dashboard-id", randomUUID()])).toBe("allow");
      expect(decision([launcher, "follow-up", "create", "--dashboard-id", randomUUID()])).toBe(
        "allow",
      );
      expect(decision([launcher, "setup"])).toBe("allow");
      expect(decision([launcher, "item", "delete"])).toBeUndefined();
      expect(decision(["sh", "-lc", `${launcher} setup`])).toBeUndefined();
      expect(decision([join(sourceRoot, "bin", "dyna"), "setup"])).toBeUndefined();
    }

    const upgradedPluginRoot = join(
      codexHome,
      "plugins",
      "cache",
      "flowzone",
      "flowzone",
      "0.1.0+codex.second",
    );
    await installShippingArtifacts(upgradedPluginRoot);
    const canonicalUpgradedPluginRoot = await realpath(upgradedPluginRoot);
    const upgradedReconciler = join(
      upgradedPluginRoot,
      "skills",
      "dyna",
      "scripts",
      "reconcile-cli-rule.sh",
    );
    const stale = spawnSync(upgradedReconciler, ["--check"], {
      cwd: userHome,
      encoding: "utf8",
      env: reconcileEnvironment,
    });
    expect(JSON.parse(stale.stdout)).toMatchObject({ status: "stale", restartRequired: true });
    const upgraded = spawnSync(upgradedReconciler, ["--install"], {
      cwd: userHome,
      encoding: "utf8",
      env: reconcileEnvironment,
    });
    expect(upgraded.status).toBe(0);
    expect(JSON.parse(upgraded.stdout)).toMatchObject({ status: "ready", restartRequired: true });
    const upgradedRule = await readFile(rulePath, "utf8");
    expect(upgradedRule).toContain(join(canonicalUpgradedPluginRoot, "bin", "dyna"));
    expect(upgradedRule).not.toContain(join(canonicalPluginRoot, "bin", "dyna"));
  }, 20_000);

  test("launches with only checked-in artifacts from a path containing spaces and Unicode", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "markdown-review-package-"));
    temporaryDirectories.push(temporaryRoot);
    const pluginRoot = join(temporaryRoot, "Plugin ü with spaces");
    await installShippingArtifacts(pluginRoot);
    await validateInstalledSkillReferences(pluginRoot);
    const markdownPath = join(temporaryRoot, "review.md");
    await writeFile(markdownPath, "# Isolated package\n");
    const nodePath = spawnSync("node", ["-p", "process.execPath"], {
      encoding: "utf8",
    }).stdout.trim();

    const dynaHelp = spawnSync(join(pluginRoot, "bin", "dyna"), ["--help"], {
      cwd: temporaryRoot,
      encoding: "utf8",
      env: {
        FLOWZONE_DATA_DIR: join(temporaryRoot, "caller-selected-data"),
        PATH: "/usr/bin:/bin",
      },
    });
    expect(dynaHelp.status).toBe(0);
    const dynaHelpResult = JSON.parse(dynaHelp.stdout) as {
      readonly schema: string;
      readonly commands: readonly { readonly command: string }[];
    };
    expect(dynaHelpResult.schema).toBe("dyna/help-v1");
    expect(
      dynaHelpResult.commands.map((entry) => entry.command.split(" ").slice(1, 3).join(" ")),
    ).toEqual([
      "dashboard list",
      "dashboard show",
      "item search",
      "item show",
      "item history",
      "item activity",
      "work update",
      "work enrich",
      "organize place",
      "organize place-many",
      "lifecycle archive",
      "lifecycle restore",
      "todo create",
      "follow-up create",
      "setup",
      "--help",
      "--version",
    ]);
    for (const legacyCommand of [
      "dyna item update",
      "dyna item enrich",
      "dyna item place",
      "dyna item archive",
      "dyna item restore",
    ]) {
      expect(dynaHelpResult.commands.some((entry) => entry.command.startsWith(legacyCommand))).toBe(
        false,
      );
    }

    const publish = spawnSync(
      join(pluginRoot, "bin", "flowzone-publish"),
      ["--publisher", randomUUID()],
      {
        encoding: "utf8",
        env: {
          FLOWZONE_DATA_DIR: temporaryRoot,
          FLOWZONE_NODE_PATH: nodePath,
          PATH: "/usr/bin:/bin",
        },
        input: "{}",
      },
    );
    expect(publish.status).toBe(1);
    expect(publish.stderr).toContain("schema-valid JSON run");

    const dyna = spawnSync(join(pluginRoot, "bin", "dyna"), ["item", "sql"], {
      cwd: temporaryRoot,
      encoding: "utf8",
      env: {
        FLOWZONE_DATA_DIR: join(temporaryRoot, "caller-selected-data"),
        PATH: "/usr/bin:/bin",
      },
    });
    expect(dyna.status).toBe(1);
    expect(JSON.parse(dyna.stderr)).toMatchObject({
      schema: "dyna/error-v1",
      code: "invalid_input",
    });
    expect(dyna.stderr).not.toContain(temporaryRoot);

    const client = new Client({ name: "isolated-package-test", version: "0.1.0" });
    const transport = await createShippingTransport(pluginRoot, temporaryRoot);
    await client.connect(transport);
    try {
      expect(client.getServerVersion()?.name).toBe("flowzone");
      const tools = (await client.listTools()).tools;
      expect(tools.filter((tool) => tool.name === "flowzone")).toHaveLength(1);
      expect(tools.map((tool) => tool.name)).not.toContain("callflow_discover");
      expect(tools.map((tool) => tool.name)).not.toContain("render_callflow");
      for (const helperName of [
        "callflow_expand",
        "callflow_get_source",
        "callflow_search",
        "callflow_find_path",
        "callflow_relayout",
        "callflow_describe_visible",
      ]) {
        const helper = tools.find((tool) => tool.name === helperName);
        expect(helper?._meta?.["ui"]).toEqual({ visibility: ["app"] });
      }
      const resource = await client.readResource({ uri: "ui://flowzone/v5.html" });
      const content = resource.contents[0];
      expect(content && "text" in content ? content.text : "").toContain(">Submit<");
      expect(
        (
          await client.callTool({
            name: "render_markdown_review",
            arguments: { path: markdownPath },
          })
        ).isError,
      ).toBeUndefined();
    } finally {
      await client.close();
    }
  }, 20_000);

  test("replaces stale checked-in artifacts during an in-place upgrade", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "markdown-review-upgrade-"));
    temporaryDirectories.push(temporaryRoot);
    const pluginRoot = join(temporaryRoot, "Existing Plugin ü");
    await mkdir(join(pluginRoot, "server", "dist"), { recursive: true });
    await mkdir(join(pluginRoot, "web", "dist"), { recursive: true });
    await Promise.all([
      writeFile(join(pluginRoot, "server", "dist", "server.cjs"), "throw new Error('old');\n"),
      writeFile(
        join(pluginRoot, "server", "dist", "flowzone-publish.cjs"),
        "throw new Error('old');\n",
      ),
      writeFile(join(pluginRoot, "server", "dist", "dyna.cjs"), "throw new Error('old');\n"),
      writeFile(join(pluginRoot, "web", "flowzone.html"), "<title>Old review</title>\n"),
      writeFile(join(pluginRoot, "web", "dist", "flowzone.js"), "old\n"),
      writeFile(join(pluginRoot, "web", "dyna.html"), "<title>Old Dyna</title>\n"),
      writeFile(join(pluginRoot, "web", "dist", "dyna.js"), "old\n"),
      writeFile(join(pluginRoot, "web", "dist", "dyna.css"), "old\n"),
    ]);

    await installShippingArtifacts(pluginRoot);
    await validateInstalledSkillReferences(pluginRoot);
    expect(
      await readFile(join(pluginRoot, "server", "dist", "flowzone-publish.cjs"), "utf8"),
    ).toContain("flowzone-publish failed");
    expect(await readFile(join(pluginRoot, "server", "dist", "dyna.cjs"), "utf8")).toContain(
      "dyna/error-v1",
    );

    const client = new Client({ name: "upgrade-package-test", version: "0.1.0" });
    const transport = await createShippingTransport(pluginRoot, temporaryRoot);
    await client.connect(transport);
    try {
      const resource = await client.readResource({ uri: "ui://flowzone/v5.html" });
      const content = resource.contents[0];
      const html = content && "text" in content ? content.text : "";
      expect(html).toContain("<title>FlowZone</title>");
      expect(html).toContain(">Submit<");
      expect(html).not.toContain("Old review");
    } finally {
      await client.close();
    }
  }, 20_000);
});

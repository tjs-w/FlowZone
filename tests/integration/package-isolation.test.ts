import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const sourceRoot = resolve(import.meta.dir, "../..");
const temporaryDirectories: string[] = [];

async function installShippingArtifacts(pluginRoot: string): Promise<void> {
  await mkdir(join(pluginRoot, "bin"), { recursive: true });
  await mkdir(join(pluginRoot, "server", "dist"), { recursive: true });
  await mkdir(join(pluginRoot, "web", "dist"), { recursive: true });
  await Promise.all([
    copyFile(join(sourceRoot, ".mcp.json"), join(pluginRoot, ".mcp.json")),
    copyFile(join(sourceRoot, "bin", "flowzone-mcp"), join(pluginRoot, "bin", "flowzone-mcp")),
    copyFile(
      join(sourceRoot, "bin", "flowzone-publish"),
      join(pluginRoot, "bin", "flowzone-publish"),
    ),
    copyFile(
      join(sourceRoot, "server", "dist", "server.cjs"),
      join(pluginRoot, "server", "dist", "server.cjs"),
    ),
    copyFile(
      join(sourceRoot, "server", "dist", "flowzone-publish.cjs"),
      join(pluginRoot, "server", "dist", "flowzone-publish.cjs"),
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
  ]);
  await chmod(join(pluginRoot, "bin", "flowzone-mcp"), 0o755);
  await chmod(join(pluginRoot, "bin", "flowzone-publish"), 0o755);
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
  test("launches with only checked-in artifacts from a path containing spaces and Unicode", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "markdown-review-package-"));
    temporaryDirectories.push(temporaryRoot);
    const pluginRoot = join(temporaryRoot, "Plugin ü with spaces");
    await installShippingArtifacts(pluginRoot);
    const markdownPath = join(temporaryRoot, "review.md");
    await writeFile(markdownPath, "# Isolated package\n");
    const nodePath = spawnSync("node", ["-p", "process.execPath"], {
      encoding: "utf8",
    }).stdout.trim();

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

    const client = new Client({ name: "isolated-package-test", version: "0.1.0" });
    const transport = await createShippingTransport(pluginRoot, temporaryRoot);
    await client.connect(transport);
    try {
      expect(client.getServerVersion()?.name).toBe("flowzone");
      expect((await client.listTools()).tools).toHaveLength(16);
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
      writeFile(join(pluginRoot, "web", "flowzone.html"), "<title>Old review</title>\n"),
      writeFile(join(pluginRoot, "web", "dist", "flowzone.js"), "old\n"),
      writeFile(join(pluginRoot, "web", "dyna.html"), "<title>Old Dyna</title>\n"),
      writeFile(join(pluginRoot, "web", "dist", "dyna.js"), "old\n"),
      writeFile(join(pluginRoot, "web", "dist", "dyna.css"), "old\n"),
    ]);

    await installShippingArtifacts(pluginRoot);
    expect(
      await readFile(join(pluginRoot, "server", "dist", "flowzone-publish.cjs"), "utf8"),
    ).toContain("flowzone-publish failed");

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

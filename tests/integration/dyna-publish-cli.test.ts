import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

describe("flowzone-publish", () => {
  test("publishes valid stdin and rejects malformed input without echoing it", () => {
    const fixture = resolve(import.meta.dir, "dyna-publish-cli-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      malformedInputRedacted: true,
      published: true,
      secretFree: true,
    });
  });

  test("does not echo source records when Codex publishes through a PTY", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "flowzone-publish-pty-"));
    const databasePath = join(dataDirectory, "dyna.sqlite3");
    const publisherLauncher = resolve(import.meta.dir, "../../bin/flowzone-publish");
    const fixture = resolve(import.meta.dir, "dyna-publish-cli-pty-node-fixture.mjs");
    const privateMarker = "DO_NOT_ECHO_PTY_SOURCE_DATA";
    const sourceSlices = [{ source: "codex" as const, sourceScope: "codex:local" }];

    try {
      const setup = spawnSync("node", [fixture, "setup", databasePath], {
        encoding: "utf8",
      });
      expect(setup.status, setup.stderr).toBe(0);
      const { dashboardId, publisherId } = JSON.parse(setup.stdout) as {
        dashboardId: string;
        publisherId: string;
      };
      const nodePath = spawnSync("node", ["-p", "process.execPath"], {
        encoding: "utf8",
      }).stdout.trim();

      const output: Uint8Array[] = [];
      const processHandle = Bun.spawn([publisherLauncher, "--publisher", publisherId], {
        env: {
          ...process.env,
          FLOWZONE_DATA_DIR: dataDirectory,
          FLOWZONE_NODE_PATH: nodePath,
        },
        terminal: {
          cols: 120,
          rows: 24,
          data(_terminal, data) {
            output.push(typeof data === "string" ? Buffer.from(data) : Buffer.from(data));
          },
        },
      });
      await Bun.sleep(50);
      const sourceCompletedAt = new Date().toISOString();
      processHandle.terminal?.write(
        `${JSON.stringify({
          runId: "pty-run-1",
          sourceCompletedAt,
          sourceSlices: [{ ...sourceSlices[0], status: "succeeded" }],
          items: [
            {
              externalId: "codex:pty-task",
              sourceRef: { source: "codex", taskId: "pty-task" },
              sourceScope: "codex:local",
              title: "Review the PTY publication",
              summary: privateMarker,
              priority: "high",
              priorityReason: "Direct request.",
              sourceUpdatedAt: sourceCompletedAt,
            },
          ],
        })}\n\u0004`,
      );

      const exitCode = await processHandle.exited;
      processHandle.terminal?.close();
      const terminalOutput = Buffer.concat(output).toString("utf8");
      expect(exitCode, terminalOutput).toBe(0);
      expect(terminalOutput).not.toContain(privateMarker);
      expect(terminalOutput).toContain('"accepted":1');

      const snapshot = spawnSync("node", [fixture, "snapshot", databasePath, dashboardId], {
        encoding: "utf8",
      });
      expect(snapshot.status, snapshot.stderr).toBe(0);
      expect(JSON.parse(snapshot.stdout)).toEqual({ summary: privateMarker });
    } finally {
      rmSync(dataDirectory, { force: true, recursive: true });
    }
  });
});

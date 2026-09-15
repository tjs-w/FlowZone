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

  test("accepts large PTY snapshots without echoing source records", async () => {
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
      const processHandle = Bun.spawn(
        [
          "/bin/sh",
          "-c",
          '"$1" --publisher "$2"\nstatus=$?\nflags=$(/bin/stty -a) || exit 125\ncase " $flags " in *" -echo "*|*" -icanon "*) printf "\\nTTY_CHANGED\\n";; *) printf "\\nTTY_RESTORED\\n";; esac\nexit "$status"',
          "flowzone-publish-pty-test",
          publisherLauncher,
          publisherId,
        ],
        {
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
        },
      );
      await Bun.sleep(50);
      const sourceCompletedAt = new Date().toISOString();
      const longSummary = `${privateMarker} ${"x".repeat(850)}`;
      const items = Array.from({ length: 12 }, (_, index) => ({
        externalId: `codex:pty-task-${String(index)}`,
        sourceRef: { source: "codex" as const, taskId: `pty-task-${String(index)}` },
        sourceScope: "codex:local",
        title: `Review PTY publication ${String(index)}`,
        summary: longSummary,
        priority: "high" as const,
        priorityReason: "Direct request.",
        sourceUpdatedAt: sourceCompletedAt,
      }));
      expect(
        Buffer.byteLength(
          JSON.stringify({
            runId: "pty-run-1",
            sourceCompletedAt,
            sourceSlices: [{ ...sourceSlices[0], status: "succeeded" }],
            items,
          }),
        ),
      ).toBeGreaterThan(8 * 1024);
      processHandle.terminal?.write(
        `${JSON.stringify({
          runId: "pty-run-1",
          sourceCompletedAt,
          sourceSlices: [{ ...sourceSlices[0], status: "succeeded" }],
          items,
        })}\n`,
      );
      await Bun.sleep(10);
      processHandle.terminal?.write("\u0004");

      const exitCode = await processHandle.exited;
      processHandle.terminal?.close();
      const terminalOutput = Buffer.concat(output).toString("utf8");
      expect(exitCode, terminalOutput).toBe(0);
      expect(terminalOutput).not.toContain(privateMarker);
      expect(terminalOutput).not.toContain("\u0007");
      expect(terminalOutput).toContain('"accepted":12');
      expect(terminalOutput).toContain("TTY_RESTORED");
      expect(terminalOutput).not.toContain("TTY_CHANGED");

      const snapshot = spawnSync("node", [fixture, "snapshot", databasePath, dashboardId], {
        encoding: "utf8",
      });
      expect(snapshot.status, snapshot.stderr).toBe(0);
      expect(JSON.parse(snapshot.stdout)).toEqual({ summary: longSummary });
    } finally {
      rmSync(dataDirectory, { force: true, recursive: true });
    }
  });

  test("rejects oversized PTY input without echo, BEL, or terminal-state leakage", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "flowzone-publish-pty-limit-"));
    const publisherLauncher = resolve(import.meta.dir, "../../bin/flowzone-publish");
    const privateMarker = "DO_NOT_ECHO_OVERSIZED_SOURCE_DATA";
    const nodePath = spawnSync("node", ["-p", "process.execPath"], {
      encoding: "utf8",
    }).stdout.trim();
    const output: Uint8Array[] = [];

    try {
      const processHandle = Bun.spawn(
        [
          "/bin/sh",
          "-c",
          '"$1" --publisher "$2"\nstatus=$?\nflags=$(/bin/stty -a) || exit 125\ncase " $flags " in *" -echo "*|*" -icanon "*) printf "\\nTTY_CHANGED\\n";; *) printf "\\nTTY_RESTORED\\n";; esac\nexit "$status"',
          "flowzone-publish-pty-limit-test",
          publisherLauncher,
          "00000000-0000-4000-8000-000000000001",
        ],
        {
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
        },
      );
      await Bun.sleep(50);
      processHandle.terminal?.write(`${privateMarker}${"x".repeat(256 * 1024)}\u0004`);

      const exitCode = await processHandle.exited;
      processHandle.terminal?.close();
      const terminalOutput = Buffer.concat(output).toString("utf8");
      expect(exitCode, terminalOutput).toBe(1);
      expect(terminalOutput).toContain(
        "flowzone-publish failed: provide a valid publisher ID and a schema-valid JSON run on stdin.",
      );
      expect(terminalOutput).not.toContain(privateMarker);
      expect(terminalOutput).not.toContain("\u0007");
      expect(terminalOutput).toContain("TTY_RESTORED");
      expect(terminalOutput).not.toContain("TTY_CHANGED");
    } finally {
      rmSync(dataDirectory, { force: true, recursive: true });
    }
  });
});

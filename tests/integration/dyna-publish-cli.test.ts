import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

function terminalState(output: string): {
  readonly before: string;
  readonly after: string;
  readonly usable: boolean;
  readonly status: number;
  readonly interrupted: boolean;
} {
  const before = /^__DYNA_TTY_BEFORE__(?<value>[^\r\n]+)$/mu.exec(output)?.groups?.["value"];
  const after = /^__DYNA_TTY_AFTER__(?<value>[^\r\n]+)$/mu.exec(output)?.groups?.["value"];
  const status = /^__DYNA_TTY_STATUS__(?<value>\d+)$/mu.exec(output)?.groups?.["value"];
  const usable = /^__DYNA_TTY_USABLE__(?<value>[01])$/mu.exec(output)?.groups?.["value"];
  const interrupted = /^__DYNA_TTY_INTERRUPTED__(?<value>[01])$/mu.exec(output)?.groups?.["value"];
  if (
    !before ||
    !after ||
    usable === undefined ||
    status === undefined ||
    interrupted === undefined
  ) {
    throw new Error(`Missing terminal state markers: ${output}`);
  }
  return {
    before,
    after,
    usable: usable === "1",
    status: Number(status),
    interrupted: interrupted === "1",
  };
}

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

  test("restores the PTY and terminates predictably for forwarded signals", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "flowzone-publish-pty-signals-"));
    const publisherLauncher = resolve(import.meta.dir, "../../bin/flowzone-publish");
    const terminalWrapper = resolve(import.meta.dir, "dyna-cli-tty-wrapper.sh");
    const signalFixture = resolve(import.meta.dir, "dyna-cli-signal-node-fixture.mjs");
    const nodePath = spawnSync("node", ["-p", "process.execPath"], {
      encoding: "utf8",
    }).stdout.trim();

    const testSignal = async (signal: NodeJS.Signals, expectedExitCode: number) => {
      const output: Uint8Array[] = [];
      let launcherPid: number | undefined;
      let launcherReady: (() => void) | undefined;
      const launcherStarted = new Promise<void>((resolveStarted) => {
        launcherReady = resolveStarted;
      });
      const processHandle = Bun.spawn(
        [
          "/bin/sh",
          terminalWrapper,
          nodePath,
          signalFixture,
          publisherLauncher,
          "--publisher",
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
              const match = /__DYNA_SIGNAL_CHILD__(?<pid>\d+)/u.exec(
                Buffer.concat(output).toString("utf8"),
              );
              if (launcherPid === undefined && match?.groups?.["pid"]) {
                launcherPid = Number(match.groups["pid"]);
                launcherReady?.();
              }
            },
          },
        },
      );

      await Promise.race([
        launcherStarted,
        Bun.sleep(5_000).then(() => {
          throw new Error("Timed out waiting for the publisher signal-test process.");
        }),
      ]);
      if (launcherPid === undefined) throw new Error("Missing publisher signal-test process ID.");
      // The supervisor reports the PID immediately after spawn. Give the
      // launcher time to capture the PTY state and install its signal traps.
      await Bun.sleep(100);
      if (signal === "SIGTSTP") {
        processHandle.terminal?.write("\u001a");
      } else {
        process.kill(launcherPid, signal);
      }

      const exitCode = await Promise.race([
        processHandle.exited,
        Bun.sleep(5_000).then(() => {
          if (launcherPid !== undefined) process.kill(launcherPid, "SIGKILL");
          processHandle.kill("SIGKILL");
          throw new Error(`Publisher did not terminate after ${signal}.`);
        }),
      ]);
      processHandle.terminal?.close();
      const terminalOutput = Buffer.concat(output).toString("utf8");
      expect(exitCode, terminalOutput).toBe(expectedExitCode);
      expect(terminalOutput).not.toContain("\u0007");
      const state = terminalState(terminalOutput);
      // Bun's PTY may toggle the macOS-only EXTPROC bit while delivering a
      // signal. The user-facing invariant is that echo and canonical input are
      // restored; ordinary success/error paths still assert the exact state.
      expect(state.usable).toBe(true);
      expect(state.status).toBe(expectedExitCode);
      expect(state.interrupted).toBe(false);
    };

    try {
      await testSignal("SIGHUP", 129);
      await testSignal("SIGINT", 130);
      await testSignal("SIGQUIT", 131);
      await testSignal("SIGTERM", 143);
      await testSignal("SIGTSTP", 148);
    } finally {
      rmSync(dataDirectory, { force: true, recursive: true });
    }
  }, 30_000);
});

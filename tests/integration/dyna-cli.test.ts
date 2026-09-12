import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

function terminalState(output: string): {
  readonly before: string;
  readonly after: string;
  readonly status: number;
  readonly interrupted: boolean;
} {
  const before = /^__DYNA_TTY_BEFORE__(?<value>[^\r\n]+)$/mu.exec(output)?.groups?.["value"];
  const after = /^__DYNA_TTY_AFTER__(?<value>[^\r\n]+)$/mu.exec(output)?.groups?.["value"];
  const status = /^__DYNA_TTY_STATUS__(?<value>\d+)$/mu.exec(output)?.groups?.["value"];
  const interrupted = /^__DYNA_TTY_INTERRUPTED__(?<value>[01])$/mu.exec(output)?.groups?.["value"];
  if (!before || !after || status === undefined || interrupted === undefined) {
    throw new Error(`Missing terminal state markers: ${output}`);
  }
  return {
    before,
    after,
    status: Number(status),
    interrupted: interrupted === "1",
  };
}

describe("bundled dyna CLI", () => {
  test("supports the bounded item lifecycle without leaking rejected input", () => {
    const fixture = resolve(import.meta.dir, "dyna-cli-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      show: true,
      update: true,
      retry: true,
      enrich: true,
      place: true,
      archive: true,
      followUp: true,
      restore: true,
      redactedErrors: true,
      strictInput: true,
      boundedInput: true,
      commandAllowlist: true,
      portableLaunch: true,
      help: true,
      version: true,
      setup: true,
      notFound: true,
    });
  });

  test("returns redacted JSON for launcher runtime preflight failures", () => {
    const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-runtime ü-"));
    const launcher = resolve(import.meta.dir, "../../bin/dyna");
    const unsupportedNode = join(directory, "old node");
    try {
      writeFileSync(unsupportedNode, "#!/bin/sh\nexit 1\n");
      chmodSync(unsupportedNode, 0o755);
      const unsupported = spawnSync(launcher, ["--version"], {
        encoding: "utf8",
        cwd: directory,
        env: {
          ...process.env,
          FLOWZONE_NODE_PATH: unsupportedNode,
          PATH: "/usr/bin:/bin",
        },
      });
      expect(unsupported.status).toBe(126);
      expect(JSON.parse(unsupported.stderr)).toEqual({
        schema: "dyna/error-v1",
        code: "unsupported_runtime",
        message: "Dyna requires Node.js 22.13.0 or newer.",
      });
      expect(unsupported.stderr).not.toContain(directory);

      const unavailablePath = join(directory, "missing node");
      const unavailable = spawnSync(launcher, ["--version"], {
        encoding: "utf8",
        cwd: directory,
        env: {
          ...process.env,
          FLOWZONE_NODE_PATH: unavailablePath,
          PATH: "/usr/bin:/bin",
        },
      });
      expect(unavailable.status).toBe(127);
      expect(JSON.parse(unavailable.stderr)).toMatchObject({
        schema: "dyna/error-v1",
        code: "unavailable",
      });
      expect(unavailable.stderr).not.toContain(unavailablePath);

      const isolatedBin = join(directory, "isolated plugin", "bin");
      mkdirSync(isolatedBin, { recursive: true });
      const missingBundleLauncher = join(isolatedBin, "dyna");
      copyFileSync(launcher, missingBundleLauncher);
      chmodSync(missingBundleLauncher, 0o755);
      const missingBundle = spawnSync(missingBundleLauncher, ["--help"], {
        encoding: "utf8",
        cwd: directory,
        env: { ...process.env, FLOWZONE_NODE_PATH: process.execPath, PATH: "/usr/bin:/bin" },
      });
      expect(missingBundle.status).toBe(127);
      expect(JSON.parse(missingBundle.stderr)).toEqual({
        schema: "dyna/error-v1",
        code: "unavailable",
        message: "Dyna's bundled CLI is unavailable.",
      });
      expect(missingBundle.stderr).not.toContain(directory);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("does not echo private work context when Codex updates through a PTY", async () => {
    const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-update-pty-"));
    const databasePath = join(directory, "dyna.sqlite3");
    const launcher = resolve(import.meta.dir, "../../bin/dyna");
    const fixture = resolve(import.meta.dir, "dyna-cli-pty-node-fixture.mjs");
    const terminalWrapper = resolve(import.meta.dir, "dyna-cli-tty-wrapper.sh");
    const signalFixture = resolve(import.meta.dir, "dyna-cli-signal-node-fixture.mjs");
    const marker = "DO_NOT_ECHO_DYNA_WORK_CONTEXT";
    try {
      const setup = spawnSync("node", [fixture, "setup", databasePath], { encoding: "utf8" });
      expect(setup.status, setup.stderr).toBe(0);
      const { dashboardId, itemId, fingerprint } = JSON.parse(setup.stdout) as {
        dashboardId: string;
        itemId: string;
        fingerprint: string;
      };
      const nodePath = spawnSync("node", ["-p", "process.execPath"], {
        encoding: "utf8",
      }).stdout.trim();

      const output: Uint8Array[] = [];
      const processHandle = Bun.spawn(
        [
          "/bin/sh",
          terminalWrapper,
          launcher,
          "item",
          "update",
          "--dashboard-id",
          dashboardId,
          "--item-id",
          itemId,
          "--expected-fingerprint",
          fingerprint,
        ],
        {
          env: {
            ...process.env,
            FLOWZONE_DATA_DIR: directory,
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
      processHandle.terminal?.write(
        `${JSON.stringify({
          requestId: randomUUID(),
          workAttemptId: randomUUID(),
          kind: "note",
          body: marker,
          artifacts: [],
        })}\n\u0004`,
      );
      const exitCode = await processHandle.exited;
      processHandle.terminal?.close();
      const terminalOutput = Buffer.concat(output).toString("utf8");
      expect(exitCode, terminalOutput).toBe(0);
      expect(terminalOutput).not.toContain(marker);
      expect(terminalOutput).toContain('"schema":"dyna/item-update-result-v1"');
      const normalState = terminalState(terminalOutput);
      expect(normalState.after).toBe(normalState.before);
      expect(normalState.status).toBe(0);
      expect(normalState.interrupted).toBe(false);

      const verify = spawnSync("node", [fixture, "snapshot", databasePath, dashboardId, itemId], {
        encoding: "utf8",
      });
      expect(verify.status, verify.stderr).toBe(0);
      expect(JSON.parse(verify.stdout)).toEqual({ body: marker });

      const invalidOutput: Uint8Array[] = [];
      const invalidHandle = Bun.spawn(["/bin/sh", terminalWrapper, launcher, "item", "sql"], {
        env: {
          ...process.env,
          FLOWZONE_DATA_DIR: directory,
          FLOWZONE_NODE_PATH: nodePath,
        },
        terminal: {
          cols: 120,
          rows: 24,
          data(_terminal, data) {
            invalidOutput.push(typeof data === "string" ? Buffer.from(data) : Buffer.from(data));
          },
        },
      });
      const invalidExitCode = await invalidHandle.exited;
      invalidHandle.terminal?.close();
      const invalidTerminalOutput = Buffer.concat(invalidOutput).toString("utf8");
      expect(invalidExitCode, invalidTerminalOutput).toBe(1);
      expect(invalidTerminalOutput).toContain('"schema":"dyna/error-v1"');
      const invalidState = terminalState(invalidTerminalOutput);
      expect(invalidState.after).toBe(invalidState.before);
      expect(invalidState.status).toBe(1);
      expect(invalidState.interrupted).toBe(false);

      const testSignal = async (signal: NodeJS.Signals, expectedExitCode: number) => {
        const interruptedOutput: Uint8Array[] = [];
        let signalChildPid: number | undefined;
        let signalChildReady: (() => void) | undefined;
        const signalChildStarted = new Promise<void>((resolveStarted) => {
          signalChildReady = resolveStarted;
        });
        const interruptedHandle = Bun.spawn(
          [
            "/bin/sh",
            terminalWrapper,
            nodePath,
            signalFixture,
            launcher,
            "item",
            "update",
            "--dashboard-id",
            dashboardId,
            "--item-id",
            itemId,
            "--expected-fingerprint",
            fingerprint,
          ],
          {
            env: {
              ...process.env,
              FLOWZONE_DATA_DIR: directory,
              FLOWZONE_NODE_PATH: nodePath,
            },
            terminal: {
              cols: 120,
              rows: 24,
              data(_terminal, data) {
                interruptedOutput.push(
                  typeof data === "string" ? Buffer.from(data) : Buffer.from(data),
                );
                const match = /__DYNA_SIGNAL_CHILD__(?<pid>\d+)/u.exec(
                  Buffer.concat(interruptedOutput).toString("utf8"),
                );
                if (signalChildPid === undefined && match?.groups?.["pid"]) {
                  signalChildPid = Number(match.groups["pid"]);
                  signalChildReady?.();
                }
              },
            },
          },
        );
        await Promise.race([
          signalChildStarted,
          Bun.sleep(5_000).then(() => {
            throw new Error("Timed out waiting for the Dyna signal-test process.");
          }),
        ]);
        if (signalChildPid === undefined) throw new Error("Missing Dyna signal-test process ID.");
        if (signal === "SIGTSTP") {
          await Bun.sleep(250);
          interruptedHandle.terminal?.write("\u001a");
        } else {
          process.kill(signalChildPid, signal);
        }
        const interruptedExitCode = await interruptedHandle.exited;
        interruptedHandle.terminal?.close();
        const interruptedTerminalOutput = Buffer.concat(interruptedOutput).toString("utf8");
        expect(interruptedExitCode, interruptedTerminalOutput).toBe(expectedExitCode);
        const interruptedState = terminalState(interruptedTerminalOutput);
        expect(interruptedState.after).toBe(interruptedState.before);
        expect(interruptedState.status).toBe(expectedExitCode);
        expect(interruptedState.interrupted).toBe(false);
      };

      await testSignal("SIGINT", 130);
      await testSignal("SIGTSTP", 148);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }, 20_000);

  test("maps a real held SQLite writer to a retry-safe busy result", async () => {
    const directory = mkdtempSync(join(tmpdir(), "flowzone-dyna-busy-"));
    const databasePath = join(directory, "dyna.sqlite3");
    const launcher = resolve(import.meta.dir, "../../bin/dyna");
    const setupFixture = resolve(import.meta.dir, "dyna-cli-pty-node-fixture.mjs");
    const busyFixture = resolve(import.meta.dir, "dyna-cli-busy-node-fixture.mjs");
    const nodePath = spawnSync("node", ["-p", "process.execPath"], {
      encoding: "utf8",
    }).stdout.trim();
    const setup = spawnSync(nodePath, [setupFixture, "setup", databasePath], {
      encoding: "utf8",
    });
    expect(setup.status, setup.stderr).toBe(0);
    const { dashboardId, itemId, fingerprint } = JSON.parse(setup.stdout) as {
      dashboardId: string;
      itemId: string;
      fingerprint: string;
    };
    const writer = spawn(nodePath, [busyFixture, databasePath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        const timeout = setTimeout(() => {
          rejectReady(new Error("Timed out waiting for SQLite writer."));
        }, 5_000);
        writer.once("error", rejectReady);
        writer.stdout.once("data", (data: Buffer) => {
          clearTimeout(timeout);
          if (!data.toString("utf8").includes("ready")) {
            rejectReady(new Error("SQLite writer did not become ready."));
            return;
          }
          resolveReady();
        });
      });
      const marker = "BUSY_INPUT_MUST_STAY_REDACTED";
      const result = spawnSync(
        launcher,
        [
          "item",
          "update",
          "--dashboard-id",
          dashboardId,
          "--item-id",
          itemId,
          "--expected-fingerprint",
          fingerprint,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            FLOWZONE_DATA_DIR: directory,
            FLOWZONE_NODE_PATH: nodePath,
          },
          input: `${JSON.stringify({
            requestId: randomUUID(),
            workAttemptId: randomUUID(),
            kind: "progress",
            body: marker,
            task: { taskId: "busy-task", hostId: "local" },
            artifacts: [],
          })}\n`,
          timeout: 15_000,
        },
      );
      expect(result.status, result.stderr).toBe(1);
      expect(JSON.parse(result.stderr)).toEqual({
        schema: "dyna/error-v1",
        code: "busy",
        message: "Dyna is busy; retry with the same request ID.",
      });
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain(marker);
      expect(result.stderr).not.toContain(databasePath);
    } finally {
      if (writer.exitCode === null) {
        writer.kill();
        await new Promise<void>((resolveExit) =>
          writer.once("exit", () => {
            resolveExit();
          }),
        );
      }
      rmSync(directory, { force: true, recursive: true });
    }
  }, 20_000);
});

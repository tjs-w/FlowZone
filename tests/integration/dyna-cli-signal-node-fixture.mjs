import { spawn } from "node:child_process";

const [command, ...arguments_] = globalThis.process.argv.slice(2);
if (!command) throw new Error("Expected a command to supervise.");

// The real launcher is the foreground process. Keep this test-only supervisor
// alive when the PTY broadcasts Ctrl-Z so it can report the launcher's exit.
globalThis.process.on("SIGTSTP", () => undefined);

const child = spawn(command, arguments_, { stdio: "inherit" });
globalThis.process.stdout.write(`__DYNA_SIGNAL_CHILD__${String(child.pid)}\n`);
child.once("error", () => {
  globalThis.process.exit(1);
});
child.once("exit", (code, signal) => {
  globalThis.process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
});

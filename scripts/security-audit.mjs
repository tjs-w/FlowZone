import console from "node:console";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { URL } from "node:url";

const publicRegistry = "https://registry.npmjs.org";
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const packageManager = String(packageJson.packageManager ?? "");
const version = /^bun@([^\s]+)$/.exec(packageManager)?.[1];

if (!version) {
  throw new Error(
    'package.json must pin an exact Bun runtime as "packageManager": "bun@<version>".',
  );
}

const installed = spawnSync("bun", ["--version"], { encoding: "utf8" });
const useInstalled = installed.status === 0 && installed.stdout.trim() === version;
const command = useInstalled ? "bun" : process.platform === "win32" ? "npx.cmd" : "npx";
const args = useInstalled
  ? ["audit", "--audit-level=high"]
  : ["--yes", `--registry=${publicRegistry}`, `bun@${version}`, "audit", "--audit-level=high"];

if (!useInstalled) {
  console.log(`Using the repository-pinned Bun ${version} audit runtime.`);
}

const audit = spawnSync(command, args, {
  env: {
    ...process.env,
    npm_config_registry: publicRegistry,
  },
  stdio: "inherit",
});

if (audit.error) throw audit.error;
if (audit.signal) throw new Error(`Security audit terminated by ${audit.signal}.`);
process.exitCode = audit.status ?? 1;

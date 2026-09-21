import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ProcessRunner } from "../src/process.js";
import { RepositoryPolicy, readCanonicalSourceFile } from "../src/repository.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function git(args: readonly string[]): Promise<void> {
  await execFileAsync("/usr/bin/git", [...args], {
    env: { PATH: process.env["PATH"] ?? "" },
    timeout: 10_000,
  });
}

describe("RepositoryPolicy read-only Git boundary", () => {
  test("disables repository fsmonitor execution and optional index locks", async () => {
    const repository = await mkdtemp(join(tmpdir(), "callflow-git-policy-"));
    temporaryDirectories.push(repository);
    await git(["init", "--quiet", repository]);
    await git(["-C", repository, "config", "user.email", "callflow@example.invalid"]);
    await git(["-C", repository, "config", "user.name", "CallFlow Test"]);
    await writeFile(join(repository, "main.ts"), "export const ready = true;\n");
    await git(["-C", repository, "add", "main.ts"]);
    await git(["-C", repository, "commit", "--quiet", "-m", "fixture"]);

    const marker = join(repository, "fsmonitor-executed");
    const maliciousMonitor = join(repository, "malicious-fsmonitor.sh");
    await writeFile(
      maliciousMonitor,
      `#!/bin/sh\nprintf 'executed\\n' > ${JSON.stringify(marker)}\nexit 0\n`,
    );
    await chmod(maliciousMonitor, 0o700);
    await git(["-C", repository, "config", "core.fsmonitor", maliciousMonitor]);

    const indexPath = join(repository, ".git", "index");
    const beforeBytes = await readFile(indexPath);
    const beforeStat = await stat(indexPath);
    const policy = new RepositoryPolicy({ gitExecutable: "/usr/bin/git" });

    const resolved = await policy.resolveRepository(repository);

    const afterBytes = await readFile(indexPath);
    const afterStat = await stat(indexPath);
    expect(resolved.root).toBe(await realpath(repository));
    expect(await readFile(marker).catch(() => undefined)).toBeUndefined();
    expect(afterBytes).toEqual(beforeBytes);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  test("never executes repository clean or process filters while hashing the worktree", async () => {
    const repository = await mkdtemp(join(tmpdir(), "callflow-git-filter-policy-"));
    temporaryDirectories.push(repository);
    await git(["init", "--quiet", repository]);
    await git(["-C", repository, "config", "user.email", "callflow@example.invalid"]);
    await git(["-C", repository, "config", "user.name", "CallFlow Test"]);
    const trackedPath = join(repository, "tracked.txt");
    await writeFile(trackedPath, "original\n");
    await writeFile(join(repository, ".gitattributes"), "*.txt filter=evil\n");
    await git(["-C", repository, "add", "tracked.txt", ".gitattributes"]);
    await git(["-C", repository, "commit", "--quiet", "-m", "fixture"]);

    const cleanMarker = join(repository, "clean-filter-executed");
    const processMarker = join(repository, "process-filter-executed");
    await git(["-C", repository, "config", "filter.evil.clean", `/usr/bin/tee ${cleanMarker}`]);
    await git(["-C", repository, "config", "filter.evil.process", `/usr/bin/tee ${processMarker}`]);
    await git(["-C", repository, "config", "filter.evil.required", "true"]);
    await writeFile(trackedPath, "changed but never filtered\n");

    const indexPath = join(repository, ".git", "index");
    const beforeBytes = await readFile(indexPath);
    const beforeStat = await stat(indexPath);
    const policy = new RepositoryPolicy({ gitExecutable: "/usr/bin/git" });
    await policy.resolveRepository(repository);

    expect(await readFile(cleanMarker).catch(() => undefined)).toBeUndefined();
    expect(await readFile(processMarker).catch(() => undefined)).toBeUndefined();
    expect(await readFile(indexPath)).toEqual(beforeBytes);
    expect((await stat(indexPath)).mtimeMs).toBe(beforeStat.mtimeMs);
  });

  test("rejects a source path swapped to an escaping symlink before open", async () => {
    if (process.platform === "win32") return;
    const repository = await mkdtemp(join(tmpdir(), "callflow-source-repository-"));
    const outside = await mkdtemp(join(tmpdir(), "callflow-source-outside-"));
    temporaryDirectories.push(repository, outside);
    const sourcePath = join(repository, "source.ts");
    const outsidePath = join(outside, "outside.ts");
    await writeFile(sourcePath, "expected source\n");
    await writeFile(outsidePath, "outside secret\n");
    const before = await lstat(sourcePath);

    await unlink(sourcePath);
    await symlink(outsidePath, sourcePath);

    let failure: unknown;
    try {
      await readCanonicalSourceFile(sourcePath, { device: before.dev, inode: before.ino });
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "path_denied" });
  });

  test("content-addresses repeated changes with the same Git status", async () => {
    const repository = await mkdtemp(join(tmpdir(), "callflow-dirty-revision-"));
    temporaryDirectories.push(repository);
    await git(["init", "--quiet", repository]);
    await git(["-C", repository, "config", "user.email", "callflow@example.invalid"]);
    await git(["-C", repository, "config", "user.name", "CallFlow Test"]);
    const trackedPath = join(repository, "tracked.ts");
    const untrackedPath = join(repository, "untracked.ts");
    await writeFile(trackedPath, "export const value = 0;\n");
    await git(["-C", repository, "add", "tracked.ts"]);
    await git(["-C", repository, "commit", "--quiet", "-m", "fixture"]);
    const policy = new RepositoryPolicy({ gitExecutable: "/usr/bin/git" });

    await writeFile(trackedPath, "export const value = 1;\n");
    await writeFile(untrackedPath, "one\n");
    const first = await policy.resolveRepository(repository);
    await writeFile(trackedPath, "export const value = 2;\n");
    await writeFile(untrackedPath, "two\n");
    const second = await policy.resolveRepository(repository);
    await writeFile(join(repository, "workflow.callflow.json"), '{"manifest":true}\n');
    const generatedPath = join(repository, "workflow.callflow.generated.json");
    await writeFile(generatedPath, '{"graph":"first"}\n');
    const beforeGeneratedWrite = await policy.resolveRepository(repository);
    await writeFile(generatedPath, '{"graph":"second"}\n');
    const afterGeneratedWrite = await policy.resolveRepository(repository);

    expect(first.revision.commit).toBe(second.revision.commit);
    expect(first.revision.dirtyDigest).not.toBe(second.revision.dirtyDigest);
    expect(afterGeneratedWrite.revision.dirtyDigest).toBe(
      beforeGeneratedWrite.revision.dirtyDigest,
    );
  });

  test("propagates cancellation during direct worktree hashing", async () => {
    const repository = await mkdtemp(join(tmpdir(), "callflow-hash-cancellation-"));
    temporaryDirectories.push(repository);
    await writeFile(join(repository, "large.bin"), Buffer.alloc(16 * 1024 * 1024, 0x61));
    const controller = new AbortController();
    let cancellationScheduled = false;
    const runner: ProcessRunner = (request) => {
      if (request.args.includes("--show-toplevel")) {
        return Promise.resolve({ exitCode: 0, stdout: `${repository}\n`, stderr: "" });
      }
      if (request.args.includes("--verify")) {
        return Promise.resolve({ exitCode: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" });
      }
      if (request.args.includes("--cached")) {
        if (!cancellationScheduled) {
          cancellationScheduled = true;
          setTimeout(() => {
            controller.abort();
          }, 0);
        }
        return Promise.resolve({
          exitCode: 0,
          stdout: `100644 ${"b".repeat(40)} 0\tlarge.bin\0`,
          stderr: "",
        });
      }
      if (request.args.includes("--others")) {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      }
      throw new Error("Unexpected Git request");
    };
    const policy = new RepositoryPolicy({ gitExecutable: "/usr/bin/git", runner });

    let failure: unknown;
    try {
      await policy.resolveRepository(repository, controller.signal);
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "aborted", retryable: true });
  });
});

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, readlink, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";

import type { RepositoryRevision } from "@callflow/contracts";

import { CallFlowError } from "./errors.js";
import { resolveExecutable, runBoundedProcess, type ProcessRunner } from "./process.js";

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_WORKTREE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_WORKTREE_BYTES = 512 * 1024 * 1024;
const MAX_WORKTREE_PATHS = 100_000;
const MAX_GIT_PATH_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface RepositoryContext {
  readonly root: string;
  readonly revision: RepositoryRevision;
}

export interface RepositoryPolicyOptions {
  readonly gitExecutable?: string;
  readonly runner?: ProcessRunner;
}

export interface SourceFileIdentity {
  readonly device: number;
  readonly inode: number;
}

interface ResolvedSourceFile extends SourceFileIdentity {
  readonly path: string;
}

const GIT_CANDIDATES = [
  "/usr/bin/git",
  "/opt/homebrew/bin/git",
  "/usr/local/bin/git",
  "C:\\Program Files\\Git\\cmd\\git.exe",
] as const;

export function sha256(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

async function readCanonicalRegularFile(
  canonicalPath: string,
  expected: SourceFileIdentity,
  maximumBytes: number,
  rejectBinary: boolean,
  signal?: AbortSignal,
): Promise<Buffer> {
  throwIfAborted(signal);
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(canonicalPath, constants.O_RDONLY | noFollow).catch(() => {
    throw new CallFlowError("path_denied", "The selected source file could not be opened safely.");
  });
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size > maximumBytes ||
      before.dev !== expected.device ||
      before.ino !== expected.inode
    ) {
      throw new CallFlowError(
        "source_changed",
        "The selected source file changed before it opened.",
      );
    }
    const bytes = await handle.readFile();
    throwIfAborted(signal);
    const after = await handle.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new CallFlowError(
        "source_changed",
        "The selected source file changed while it was read.",
      );
    }
    if (bytes.byteLength > maximumBytes || (rejectBinary && bytes.includes(0))) {
      throw new CallFlowError("path_denied", "The selected file exceeds its safe read boundary.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function hashCanonicalRegularFile(
  canonicalPath: string,
  expected: SourceFileIdentity,
  signal?: AbortSignal,
): Promise<{ readonly digest: `sha256:${string}`; readonly bytes: number }> {
  throwIfAborted(signal);
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(canonicalPath, constants.O_RDONLY | noFollow).catch(() => {
    throw new CallFlowError("path_denied", "A worktree file could not be opened safely.");
  });
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size > MAX_WORKTREE_FILE_BYTES ||
      before.dev !== expected.device ||
      before.ino !== expected.inode
    ) {
      throw new CallFlowError("source_changed", "The worktree changed before it was hashed.");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < before.size) {
      throwIfAborted(signal);
      const length = Math.min(buffer.byteLength, before.size - position);
      const result = await handle.read(buffer, 0, length, position);
      throwIfAborted(signal);
      if (result.bytesRead < 1) {
        throw new CallFlowError("source_changed", "The worktree changed while it was hashed.");
      }
      digest.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      position !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new CallFlowError("source_changed", "The worktree changed while it was hashed.");
    }
    return { digest: `sha256:${digest.digest("hex")}`, bytes: position };
  } finally {
    await handle.close();
  }
}

function validateGitPath(repositoryPath: string): string {
  if (
    !repositoryPath ||
    repositoryPath.length > 2_048 ||
    repositoryPath.includes("\0") ||
    repositoryPath.includes("\\") ||
    repositoryPath.includes("\uFFFD") ||
    /[\r\n]/.test(repositoryPath) ||
    isAbsolute(repositoryPath) ||
    repositoryPath.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new CallFlowError("invalid_output", "Git returned an unsafe repository path.");
  }
  return repositoryPath;
}

function isGeneratedCallFlowArtifact(
  repositoryPath: string,
  repositoryPaths: ReadonlySet<string>,
): boolean {
  if (!repositoryPath.endsWith(".generated.json")) return false;
  const stem = repositoryPath.slice(0, -".generated.json".length);
  return repositoryPaths.has(stem) || repositoryPaths.has(`${stem}.json`);
}

interface IndexEntry {
  readonly record: string;
  readonly path: string;
}

function parseIndexEntries(output: string): readonly IndexEntry[] {
  const entries = output
    .split("\0")
    .filter((record) => record.length > 0)
    .map((record) => {
      const match = /^([0-7]{6}) ([0-9a-fA-F]{40,64}) ([0-3])\t(.+)$/.exec(record);
      if (!match?.[4]) {
        throw new CallFlowError("invalid_output", "Git returned an invalid index entry.");
      }
      return { record, path: validateGitPath(match[4]) };
    })
    .sort((left, right) => (left.record < right.record ? -1 : left.record > right.record ? 1 : 0));
  if (entries.length > MAX_WORKTREE_PATHS) {
    throw new CallFlowError("output_too_large", "The worktree contains too many tracked paths.");
  }
  return entries;
}

export async function readCanonicalSourceFile(
  canonicalPath: string,
  expected: SourceFileIdentity,
  signal?: AbortSignal,
): Promise<Buffer> {
  return await readCanonicalRegularFile(canonicalPath, expected, MAX_SOURCE_BYTES, true, signal);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new CallFlowError("aborted", "The CallFlow operation was cancelled.", true);
  }
}

function cleanLine(value: string, field: string): string {
  const line = value.trim();
  if (!line || line.includes("\0") || /[\r\n]/.test(line)) {
    throw new CallFlowError("invalid_output", `Git returned an invalid ${field}.`);
  }
  return line;
}

export class RepositoryPolicy {
  readonly #gitExecutable: string | undefined;
  readonly #runner: ProcessRunner;

  constructor(options: RepositoryPolicyOptions = {}) {
    this.#gitExecutable = options.gitExecutable;
    this.#runner = options.runner ?? runBoundedProcess;
  }

  async resolveRepository(pathInput: string, signal?: AbortSignal): Promise<RepositoryContext> {
    if (
      !isAbsolute(pathInput) ||
      pathInput.includes("\0") ||
      pathInput.length > 4_096 ||
      /[\r\n]/.test(pathInput)
    ) {
      throw new CallFlowError("path_denied", "Pass a bounded absolute repository path.");
    }
    const requested = await realpath(resolve(pathInput)).catch(() => {
      throw new CallFlowError("not_found", "The repository path does not exist.");
    });
    if (!(await stat(requested)).isDirectory()) {
      throw new CallFlowError("path_denied", "The repository path must be a directory.");
    }
    const git = this.#gitExecutable ?? (await resolveExecutable(GIT_CANDIDATES));
    const topLevel = await this.#runGit(git, requested, ["rev-parse", "--show-toplevel"], signal);
    const root = await realpath(cleanLine(topLevel, "repository root"));
    if (!isWithinRoot(root, requested)) {
      throw new CallFlowError("path_denied", "The requested path is outside its Git worktree.");
    }
    const filesystemRoot = parse(root).root;
    const userHome = await realpath(homedir()).catch(() => homedir());
    if (root === filesystemRoot || root === userHome) {
      throw new CallFlowError(
        "path_denied",
        "Broad filesystem and home roots are not repositories.",
      );
    }
    if (Buffer.byteLength(root, "utf8") > 500) {
      throw new CallFlowError("path_denied", "The canonical repository path is too long.");
    }

    const commit = cleanLine(
      await this.#runGit(git, root, ["rev-parse", "--verify", "HEAD"], signal),
      "commit revision",
    );
    const dirtyDigest = await this.#dirtyDigest(git, root, signal);
    return {
      root,
      revision: {
        identity: `local:${root}`,
        commit,
        dirtyDigest,
      },
    };
  }

  async resolveSourcePath(root: string, repositoryPath: string): Promise<string> {
    return (await this.#resolveSourceFile(root, repositoryPath)).path;
  }

  async #resolveSourceFile(root: string, repositoryPath: string): Promise<ResolvedSourceFile> {
    if (
      !repositoryPath ||
      repositoryPath.length > 2_048 ||
      repositoryPath.includes("\0") ||
      repositoryPath.includes("\\") ||
      isAbsolute(repositoryPath) ||
      repositoryPath.split("/").some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new CallFlowError("path_denied", "The source path is not repository-relative.");
    }
    const candidate = resolve(root, repositoryPath);
    const canonical = await realpath(candidate).catch(() => {
      throw new CallFlowError("not_found", "The selected source file is unavailable.");
    });
    if (!isWithinRoot(root, canonical)) {
      throw new CallFlowError("path_denied", "The selected source path escapes the repository.");
    }
    const sourceStat = await lstat(canonical);
    if (!sourceStat.isFile() || sourceStat.size > MAX_SOURCE_BYTES) {
      throw new CallFlowError(
        "path_denied",
        "The selected source file is not a bounded regular file.",
      );
    }
    await access(canonical, constants.R_OK);
    return { path: canonical, device: sourceStat.dev, inode: sourceStat.ino };
  }

  async readSource(root: string, repositoryPath: string, signal?: AbortSignal): Promise<Buffer> {
    throwIfAborted(signal);
    const source = await this.#resolveSourceFile(root, repositoryPath);
    throwIfAborted(signal);
    return await readCanonicalSourceFile(source.path, source, signal);
  }

  async readFileAtRevision(
    root: string,
    revision: string,
    repositoryPath: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._/@{}~-]{0,255}$/.test(revision) ||
      revision.includes("..") ||
      revision.startsWith("-")
    ) {
      throw new CallFlowError("invalid_input", "The comparison revision is invalid.");
    }
    if (
      !repositoryPath ||
      repositoryPath.includes("\0") ||
      repositoryPath.includes("\\") ||
      isAbsolute(repositoryPath) ||
      repositoryPath.split("/").some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new CallFlowError("path_denied", "The comparison path is invalid.");
    }
    const git = this.#gitExecutable ?? (await resolveExecutable(GIT_CANDIDATES));
    return await this.#runGit(
      git,
      root,
      ["show", "--no-textconv", `${revision}:${repositoryPath}`],
      signal,
    );
  }

  async #runGit(
    executable: string,
    cwd: string,
    args: readonly string[],
    signal?: AbortSignal,
    maximumOutputBytes = 2 * 1024 * 1024,
  ): Promise<string> {
    const result = await this.#runner({
      executable,
      args: [
        "--no-pager",
        "-c",
        "core.fsmonitor=false",
        "-c",
        `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        "-c",
        "diff.external=",
        "-c",
        "core.pager=cat",
        "-C",
        cwd,
        ...args,
      ],
      cwd,
      ...(signal ? { signal } : {}),
      maximumOutputBytes,
      environment: {
        GIT_ATTR_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    if (result.exitCode !== 0) {
      throw new CallFlowError("path_denied", "The selected path is not a readable Git worktree.");
    }
    return result.stdout;
  }

  async #dirtyDigest(
    executable: string,
    root: string,
    signal?: AbortSignal,
  ): Promise<`sha256:${string}`> {
    // Never use `git status` or `git diff` here. Both may execute a
    // repository-configured clean/process filter while inspecting worktree
    // content. `ls-files` reads only index/path metadata; CallFlow opens and
    // hashes every selected path itself through an O_NOFOLLOW file descriptor.
    const [indexOutput, untrackedOutput] = await Promise.all([
      this.#runGit(
        executable,
        root,
        ["ls-files", "--cached", "--stage", "-z"],
        signal,
        MAX_GIT_PATH_OUTPUT_BYTES,
      ),
      this.#runGit(
        executable,
        root,
        ["ls-files", "--others", "--exclude-standard", "-z"],
        signal,
        MAX_GIT_PATH_OUTPUT_BYTES,
      ),
    ]);
    const allIndexEntries = parseIndexEntries(indexOutput);
    const allUntrackedPaths = untrackedOutput
      .split("\0")
      .filter((path) => path.length > 0)
      .map(validateGitPath);
    const repositoryPaths = new Set([
      ...allIndexEntries.map((entry) => entry.path),
      ...allUntrackedPaths,
    ]);
    const indexEntries = allIndexEntries.filter(
      (entry) => !isGeneratedCallFlowArtifact(entry.path, repositoryPaths),
    );
    const trackedPaths = [...new Set(indexEntries.map((entry) => entry.path))].sort(
      (left, right) => (left < right ? -1 : left > right ? 1 : 0),
    );
    const untrackedPaths = allUntrackedPaths
      .filter((path) => !isGeneratedCallFlowArtifact(path, repositoryPaths))
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    if (trackedPaths.length + untrackedPaths.length > MAX_WORKTREE_PATHS) {
      throw new CallFlowError("output_too_large", "The worktree contains too many files.");
    }
    const parts = ["callflow-worktree-v3", ...indexEntries.map((entry) => entry.record)];
    let totalBytes = 0;
    const hashPath = async (repositoryPath: string, tracked: boolean): Promise<void> => {
      throwIfAborted(signal);
      const candidate = resolve(root, repositoryPath);
      if (!isWithinRoot(root, candidate)) {
        throw new CallFlowError("path_denied", "A worktree path escapes the repository.");
      }
      const before = await lstat(candidate).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && tracked) return undefined;
        throw new CallFlowError("source_changed", "The worktree changed while it was hashed.");
      });
      if (!before) {
        parts.push(`missing\0${repositoryPath}`);
        return;
      }
      let kind: "file" | "symlink";
      let contentDigest: `sha256:${string}`;
      let contentBytes: number;
      if (before.isSymbolicLink()) {
        const target = await readlink(candidate);
        throwIfAborted(signal);
        const after = await lstat(candidate);
        if (
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs
        ) {
          throw new CallFlowError("source_changed", "The dirty tree changed while it was hashed.");
        }
        kind = "symlink";
        contentBytes = Buffer.byteLength(target, "utf8");
        contentDigest = sha256(target);
      } else if (before.isFile()) {
        if (before.size > MAX_WORKTREE_FILE_BYTES) {
          throw new CallFlowError("output_too_large", "A worktree file exceeds the hashing limit.");
        }
        const canonical = await realpath(candidate);
        if (!isWithinRoot(root, canonical)) {
          throw new CallFlowError("path_denied", "A worktree path escapes the repository.");
        }
        const hashed = await hashCanonicalRegularFile(
          canonical,
          {
            device: before.dev,
            inode: before.ino,
          },
          signal,
        );
        kind = "file";
        contentBytes = hashed.bytes;
        contentDigest = hashed.digest;
      } else {
        throw new CallFlowError("path_denied", "The worktree contains an unsupported file type.");
      }
      totalBytes += Buffer.byteLength(repositoryPath, "utf8") + contentBytes;
      if (totalBytes > MAX_WORKTREE_BYTES) {
        throw new CallFlowError("output_too_large", "The worktree exceeds its hashing limit.");
      }
      parts.push(
        `${tracked ? "tracked" : "untracked"}\0${kind}\0${repositoryPath}\0${String(before.mode & 0o777)}\0${contentDigest}`,
      );
    };
    for (const repositoryPath of trackedPaths) {
      throwIfAborted(signal);
      await hashPath(repositoryPath, true);
    }
    for (const repositoryPath of untrackedPaths) {
      throwIfAborted(signal);
      await hashPath(repositoryPath, false);
    }
    return sha256(parts.join("\0"));
  }
}

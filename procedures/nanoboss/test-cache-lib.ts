import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { formatErrorMessage } from "../../src/core/error-format.ts";

export const PRE_COMMIT_CHECKS_COMMAND = "bun run scripts/compact-test.ts";
const PRE_COMMIT_CHECKS_CMD = ["bun", "run", "scripts/compact-test.ts"];
const PRE_COMMIT_CHECKS_CACHE_RELATIVE_PATH = ".nanoboss/pre-commit-checks.json";
const EXCLUDED_PATH_SEGMENTS = new Set([".git", "node_modules", ".nanoboss", "dist", "coverage"]);
const TEMP_FILE_PATTERNS = [
  /~$/,
  /^\.#/,
  /^#.*#$/,
  /\.(?:swp|swo|tmp|temp)$/i,
  /^\.DS_Store$/,
];
const textDecoder = new TextDecoder();
type FileStats = NonNullable<ReturnType<typeof lstatSync>>;

export interface CachedPreCommitChecksResult {
  version: 1;
  command: string;
  workspaceStateFingerprint: string;
  runtimeFingerprint: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  combinedOutput: string;
  summary: string;
  createdAt: string;
  durationMs: number;
}

export interface PreCommitChecksResult {
  command: string;
  cacheHit: boolean;
  exitCode: number;
  passed: boolean;
  workspaceStateFingerprint: string;
  runtimeFingerprint: string;
  createdAt: string;
}

export interface ResolvedPreCommitChecksResult extends PreCommitChecksResult {
  stdout: string;
  stderr: string;
  combinedOutput: string;
  summary: string;
  durationMs: number;
}

export interface RuntimeFingerprintInput {
  bunVersion: string;
  platform: NodeJS.Platform;
  arch: string;
}

export interface CommandExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  combinedOutput: string;
  summary: string;
  createdAt: string;
  durationMs: number;
}

export interface ResolvePreCommitChecksOptions {
  cwd: string;
  refresh?: boolean;
  resolveRuntimeFingerprint?: () => string;
  runValidationCommand?: (cwd: string) => CommandExecutionResult;
}

export function resolveGitRepoRoot(cwd: string): string {
  return runGit(cwd, ["rev-parse", "--show-toplevel"]).trim();
}

export function getPreCommitChecksCachePath(cwd: string): string {
  return join(resolveGitRepoRoot(cwd), PRE_COMMIT_CHECKS_CACHE_RELATIVE_PATH);
}

export function computeWorkspaceStateFingerprint(cwd: string): string {
  const repoRoot = resolveGitRepoRoot(cwd);
  const headCommit = runGit(repoRoot, ["rev-parse", "HEAD"]).trim();
  const stagedDiffHash = sha256(runGit(repoRoot, ["diff", "--cached", "--binary", "HEAD"]));
  const unstagedDiffHash = sha256(runGit(repoRoot, ["diff", "--binary"]));
  const untrackedRelevantFilesHash = computeUntrackedRelevantFilesHash(repoRoot);

  return sha256([
    headCommit,
    stagedDiffHash,
    unstagedDiffHash,
    untrackedRelevantFilesHash,
  ].join("\u0000"));
}

export function computeRuntimeFingerprint(
  input: RuntimeFingerprintInput = {
    bunVersion: Bun.version,
    platform: process.platform,
    arch: process.arch,
  },
): string {
  return sha256([
    input.bunVersion,
    input.platform,
    input.arch,
  ].join("\u0000"));
}

export function loadCachedPreCommitChecksResult(cachePath: string): CachedPreCommitChecksResult | undefined {
  if (!existsSync(cachePath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
    return isCachedPreCommitChecksResult(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writeCachedPreCommitChecksResult(
  cachePath: string,
  record: CachedPreCommitChecksResult,
): void {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export function resolvePreCommitChecks(
  options: ResolvePreCommitChecksOptions,
): ResolvedPreCommitChecksResult {
  const cachePath = getPreCommitChecksCachePath(options.cwd);
  const workspaceStateFingerprint = computeWorkspaceStateFingerprint(options.cwd);
  const runtimeFingerprint = (options.resolveRuntimeFingerprint ?? computeRuntimeFingerprint)();
  const cached = loadCachedPreCommitChecksResult(cachePath);

  if (
    !options.refresh
    && cached
    && cached.command === PRE_COMMIT_CHECKS_COMMAND
    && cached.workspaceStateFingerprint === workspaceStateFingerprint
    && cached.runtimeFingerprint === runtimeFingerprint
  ) {
    return {
      command: cached.command,
      cacheHit: true,
      exitCode: cached.exitCode,
      passed: cached.exitCode === 0,
      workspaceStateFingerprint,
      runtimeFingerprint,
      createdAt: cached.createdAt,
      stdout: cached.stdout,
      stderr: cached.stderr,
      combinedOutput: cached.combinedOutput,
      summary: cached.summary,
      durationMs: cached.durationMs,
    };
  }

  const fresh = (options.runValidationCommand ?? runPreCommitValidationCommand)(resolveGitRepoRoot(options.cwd));
  const record: CachedPreCommitChecksResult = {
    version: 1,
    command: PRE_COMMIT_CHECKS_COMMAND,
    workspaceStateFingerprint,
    runtimeFingerprint,
    exitCode: fresh.exitCode,
    stdout: fresh.stdout,
    stderr: fresh.stderr,
    combinedOutput: fresh.combinedOutput,
    summary: fresh.summary,
    createdAt: fresh.createdAt,
    durationMs: fresh.durationMs,
  };
  writeCachedPreCommitChecksResult(cachePath, record);

  return {
    command: record.command,
    cacheHit: false,
    exitCode: record.exitCode,
    passed: record.exitCode === 0,
    workspaceStateFingerprint,
    runtimeFingerprint,
    createdAt: record.createdAt,
    stdout: record.stdout,
    stderr: record.stderr,
    combinedOutput: record.combinedOutput,
    summary: record.summary,
    durationMs: record.durationMs,
  };
}

export function ensureTrailingNewline(text: string): string {
  if (text.length === 0 || text.endsWith("\n")) {
    return text;
  }
  return `${text}\n`;
}

function runPreCommitValidationCommand(cwd: string): CommandExecutionResult {
  const startedAt = Date.now();
  let result: Bun.SyncSubprocess;

  try {
    result = Bun.spawnSync({
      cmd: PRE_COMMIT_CHECKS_CMD,
      cwd,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new Error(
      `Failed to start pre-commit validation command \`${PRE_COMMIT_CHECKS_COMMAND}\`: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }

  const stdout = textDecoder.decode(result.stdout);
  const stderr = textDecoder.decode(result.stderr);
  const combinedOutput = `${stdout}${stderr}`;
  const exitCode = result.exitCode;

  return {
    exitCode,
    stdout,
    stderr,
    combinedOutput,
    summary: exitCode === 0
      ? "Pre-commit checks passed."
      : `Pre-commit checks failed with exit code ${exitCode}.`,
    createdAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
  };
}

function computeUntrackedRelevantFilesHash(repoRoot: string): string {
  const untrackedFiles = runGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\u0000")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .filter((relativePath) => !isExcludedUntrackedPath(relativePath))
    .sort();

  const hash = createHash("sha256");

  for (const relativePath of untrackedFiles) {
    const absolutePath = resolve(repoRoot, relativePath);
    if (!existsSync(absolutePath)) {
      continue;
    }

    const stat = lstatSync(absolutePath);
    if (stat.isDirectory()) {
      continue;
    }

    hash.update(relativePath);
    hash.update("\u0000");
    hash.update(hashUntrackedFile(absolutePath, stat));
    hash.update("\u0000");
  }

  return hash.digest("hex");
}

function hashUntrackedFile(absolutePath: string, stat: FileStats): string {
  if (stat.isSymbolicLink()) {
    return sha256(`symlink:${readlinkSync(absolutePath)}`);
  }

  if (stat.isFile()) {
    return sha256(readFileSync(absolutePath));
  }

  return sha256(`unsupported:${stat.mode}`);
}

function isExcludedUntrackedPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => EXCLUDED_PATH_SEGMENTS.has(segment))) {
    return true;
  }

  const baseName = segments.at(-1) ?? normalized;
  return TEMP_FILE_PATTERNS.some((pattern) => pattern.test(baseName));
}

function isCachedPreCommitChecksResult(value: unknown): value is CachedPreCommitChecksResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return candidate.version === 1
    && typeof candidate.command === "string"
    && typeof candidate.workspaceStateFingerprint === "string"
    && typeof candidate.runtimeFingerprint === "string"
    && typeof candidate.exitCode === "number"
    && typeof candidate.stdout === "string"
    && typeof candidate.stderr === "string"
    && typeof candidate.combinedOutput === "string"
    && typeof candidate.summary === "string"
    && typeof candidate.createdAt === "string"
    && typeof candidate.durationMs === "number";
}

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    throw new Error(`git ${args.join(" ")} failed: ${formatErrorMessage(error)}`, { cause: error });
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

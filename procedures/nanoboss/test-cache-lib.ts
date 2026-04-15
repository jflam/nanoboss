import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { formatErrorMessage } from "@nanoboss/procedure-sdk";

export const PRE_COMMIT_CHECKS_COMMAND = "bun run check:precommit";
const PRE_COMMIT_CHECKS_CMD = ["bun", "run", "check:precommit"];
const PRE_COMMIT_PROGRESS_ENV = "NANOBOSS_STREAM_TEST_PROGRESS";
export const PRE_COMMIT_SKIP_CACHE_WRITE_ENV = "NANOBOSS_PRECOMMIT_SKIP_CACHE_WRITE";
const PRE_COMMIT_CHECKS_CACHE_RELATIVE_PATH = ".nanoboss/pre-commit-checks.json";
const EXCLUDED_PATH_SEGMENTS = new Set([".git", "node_modules", ".nanoboss", "dist", "coverage"]);
const TEMP_FILE_PATTERNS = [
  /~$/,
  /^\.#/,
  /^#.*#$/,
  /\.(?:swp|swo|tmp|temp)$/i,
  /^\.DS_Store$/,
];
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
  runReason: PreCommitChecksRunReason;
  stdout: string;
  stderr: string;
  combinedOutput: string;
  summary: string;
  durationMs: number;
}

export type PreCommitChecksFreshRunReason =
  | "refresh"
  | "cold_cache"
  | "workspace_changed"
  | "runtime_changed"
  | "command_changed";

export type PreCommitChecksRunReason = "cache_hit" | PreCommitChecksFreshRunReason;

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
  onFreshRun?: (event: {
    reason: PreCommitChecksFreshRunReason;
    command: string;
  }) => void;
  onOutputChunk?: (chunk: string) => void;
  runValidationCommand?: (cwd: string, options?: {
    onOutputChunk?: (chunk: string) => void;
  }) => Promise<CommandExecutionResult>;
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
    const parsed: unknown = JSON.parse(readFileSync(cachePath, "utf8"));
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

export function persistPreCommitChecksRun(
  cwd: string,
  result: CommandExecutionResult,
  options: {
    resolveRuntimeFingerprint?: () => string;
  } = {},
): CachedPreCommitChecksResult {
  const record: CachedPreCommitChecksResult = {
    version: 1,
    command: PRE_COMMIT_CHECKS_COMMAND,
    workspaceStateFingerprint: computeWorkspaceStateFingerprint(cwd),
    runtimeFingerprint: (options.resolveRuntimeFingerprint ?? computeRuntimeFingerprint)(),
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    combinedOutput: result.combinedOutput,
    summary: result.summary,
    createdAt: result.createdAt,
    durationMs: result.durationMs,
  };
  writeCachedPreCommitChecksResult(getPreCommitChecksCachePath(cwd), record);
  return record;
}

export async function resolvePreCommitChecks(
  options: ResolvePreCommitChecksOptions,
): Promise<ResolvedPreCommitChecksResult> {
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
      runReason: "cache_hit",
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

  const runReason = resolveFreshRunReason({
    refresh: options.refresh === true,
    cached,
    workspaceStateFingerprint,
    runtimeFingerprint,
  });
  options.onFreshRun?.({
    reason: runReason,
    command: PRE_COMMIT_CHECKS_COMMAND,
  });
  const fresh = await (options.runValidationCommand ?? runPreCommitValidationCommand)(
    resolveGitRepoRoot(options.cwd),
    { onOutputChunk: options.onOutputChunk },
  );
  const record = persistPreCommitChecksRun(options.cwd, fresh, {
    resolveRuntimeFingerprint: () => runtimeFingerprint,
  });

  return {
    command: record.command,
    cacheHit: false,
    runReason,
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

async function runPreCommitValidationCommand(
  cwd: string,
  options: {
    onOutputChunk?: (chunk: string) => void;
  } = {},
): Promise<CommandExecutionResult> {
  const startedAt = Date.now();
  let child: ReturnType<typeof spawn>;
  const [command, ...args] = PRE_COMMIT_CHECKS_CMD;

  if (!command) {
    throw new Error("Missing pre-commit validation command");
  }

  try {
    child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        [PRE_COMMIT_PROGRESS_ENV]: "1",
        [PRE_COMMIT_SKIP_CACHE_WRITE_ENV]: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(
      `Failed to start pre-commit validation command \`${PRE_COMMIT_CHECKS_COMMAND}\`: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }

  let stdout = "";
  let stderr = "";

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
    options.onOutputChunk?.(chunk);
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
    options.onOutputChunk?.(chunk);
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      resolve(code ?? 1);
    });
  });

  const combinedOutput = `${stdout}${stderr}`;

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

function resolveFreshRunReason(params: {
  refresh: boolean;
  cached?: CachedPreCommitChecksResult;
  workspaceStateFingerprint: string;
  runtimeFingerprint: string;
}): PreCommitChecksFreshRunReason {
  if (params.refresh) {
    return "refresh";
  }

  if (!params.cached) {
    return "cold_cache";
  }

  if (params.cached.command !== PRE_COMMIT_CHECKS_COMMAND) {
    return "command_changed";
  }

  if (params.cached.workspaceStateFingerprint !== params.workspaceStateFingerprint) {
    return "workspace_changed";
  }

  if (params.cached.runtimeFingerprint !== params.runtimeFingerprint) {
    return "runtime_changed";
  }

  return "cold_cache";
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

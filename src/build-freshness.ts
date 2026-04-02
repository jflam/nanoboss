import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { getBuildCommit, getBuildLabel } from "./build-info.ts";

interface RepoBuildState {
  commit: string;
  dirtyPaths: string[];
  newestDirtyMtimeMs?: number;
}

interface ExecutableBuildState {
  commit: string;
  dirty: boolean;
  mtimeMs?: number;
}

export interface BuildFreshnessStatus {
  outOfDate: boolean;
  reason?: string;
}

export function getBuildFreshnessNotice(cwd = process.cwd()): string | undefined {
  if (isRunningFromSource()) {
    return undefined;
  }

  const repoRoot = findNanobossRepoRoot(cwd);
  if (!repoRoot) {
    return undefined;
  }

  const repoState = readRepoBuildState(repoRoot);
  if (!repoState) {
    return undefined;
  }

  const executableState = readExecutableBuildState(process.execPath);
  const status = evaluateBuildFreshness(repoState, executableState);
  if (!status.outOfDate || !status.reason) {
    return undefined;
  }

  return `[build] ${status.reason} Run bun run build.ts.`;
}

export function evaluateBuildFreshness(
  repo: RepoBuildState,
  executable: ExecutableBuildState,
): BuildFreshnessStatus {
  if (normalizeCommit(repo.commit) !== normalizeCommit(executable.commit)) {
    return {
      outOfDate: true,
      reason: `working tree is at ${repo.commit}, but this CLI is ${getBuildLabel()}`,
    };
  }

  if (repo.dirtyPaths.length === 0) {
    return { outOfDate: false };
  }

  if (!executable.dirty) {
    return {
      outOfDate: true,
      reason: `working tree has unbuilt changes in ${formatDirtyPaths(repo.dirtyPaths)}`,
    };
  }

  if (
    executable.mtimeMs !== undefined &&
    repo.newestDirtyMtimeMs !== undefined &&
    repo.newestDirtyMtimeMs > executable.mtimeMs + 1_000
  ) {
    return {
      outOfDate: true,
      reason: `working tree has newer changes in ${formatDirtyPaths(repo.dirtyPaths)} than the installed binary`,
    };
  }

  return { outOfDate: false };
}

export function parseGitStatusPaths(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const raw = line.slice(3).trim();
      const renameSeparator = raw.indexOf(" -> ");
      return renameSeparator >= 0 ? raw.slice(renameSeparator + 4).trim() : raw;
    })
    .filter(Boolean);
}

export function isBuildRelevantRepoPath(path: string): boolean {
  const normalized = path.replace(/^\.\//, "");
  return (
    normalized === "nanoboss.ts" ||
    normalized === "cli.ts" ||
    normalized === "build.ts" ||
    normalized === "package.json" ||
    normalized === "bunfig.toml" ||
    normalized === "tsconfig.json" ||
    normalized.startsWith("src/") ||
    normalized.startsWith("commands/")
  );
}

function isRunningFromSource(): boolean {
  const scriptPath = process.argv[1];
  return Boolean(scriptPath && /\.[cm]?[jt]sx?$/i.test(scriptPath) && !scriptPath.startsWith("/$bunfs/"));
}

function findNanobossRepoRoot(cwd: string): string | undefined {
  const root = runGit(["rev-parse", "--show-toplevel"], cwd);
  if (!root) {
    return undefined;
  }

  if (!existsSync(join(root, "nanoboss.ts"))) {
    return undefined;
  }

  const packageJsonPath = join(root, "package.json");
  if (!existsSync(packageJsonPath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
    return parsed.name === "nanoboss" ? root : undefined;
  } catch {
    return undefined;
  }
}

function readRepoBuildState(repoRoot: string): RepoBuildState | undefined {
  const commit = runGit(["rev-parse", "--short", "HEAD"], repoRoot);
  if (!commit) {
    return undefined;
  }

  const statusText = runGit(["status", "--porcelain", "--untracked-files=all"], repoRoot) ?? "";
  const dirtyPaths = parseGitStatusPaths(statusText).filter(isBuildRelevantRepoPath);

  let newestDirtyMtimeMs: number | undefined;
  for (const path of dirtyPaths) {
    const absolutePath = isAbsolute(path) ? path : join(repoRoot, path);
    if (!existsSync(absolutePath)) {
      continue;
    }

    const mtimeMs = statSync(absolutePath).mtimeMs;
    newestDirtyMtimeMs = newestDirtyMtimeMs === undefined
      ? mtimeMs
      : Math.max(newestDirtyMtimeMs, mtimeMs);
  }

  return {
    commit,
    dirtyPaths,
    newestDirtyMtimeMs,
  };
}

function readExecutableBuildState(executablePath: string): ExecutableBuildState {
  const commit = getBuildCommit();
  return {
    commit,
    dirty: commit.endsWith("-dirty"),
    mtimeMs: existsSync(executablePath) ? statSync(executablePath).mtimeMs : undefined,
  };
}

function runGit(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function normalizeCommit(commit: string): string {
  return commit.replace(/-dirty$/, "");
}

function formatDirtyPaths(paths: string[]): string {
  if (paths.length === 1) {
    return paths[0] ?? "the working tree";
  }

  const preview = paths.slice(0, 3).join(", ");
  return paths.length > 3 ? `${preview}, ...` : preview;
}

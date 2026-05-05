import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { getBuildCommit } from "@nanoboss/app-support";
import {
  evaluateBuildFreshness,
  isBuildRelevantRepoPath,
  parseGitStatusPaths,
  type ExecutableBuildState,
  type RepoBuildState,
} from "./build-freshness-rules.ts";

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

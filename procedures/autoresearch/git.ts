import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

import { formatErrorMessage } from "../../src/core/error-format.ts";

import type { AutoresearchChangedFiles } from "./types.ts";

const COPILOT_TRAILER = "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>";

export function resolveGitRepoRoot(cwd: string): string {
  return runGit(cwd, ["rev-parse", "--show-toplevel"]).trim();
}

export function getCurrentBranch(cwd: string): string {
  return runGit(cwd, ["branch", "--show-current"]).trim();
}

export function getHeadCommit(cwd: string): string {
  return runGit(cwd, ["rev-parse", "HEAD"]).trim();
}

export function ensureGitLocalExclude(cwd: string, pattern: string): void {
  const excludePath = resolve(cwd, runGit(cwd, ["rev-parse", "--git-path", "info/exclude"]).trim());
  const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  if (current.split("\n").some((line) => line.trim() === pattern)) {
    return;
  }

  mkdirSync(dirname(excludePath), { recursive: true });
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  writeFileSync(excludePath, `${current}${prefix}${pattern}\n`, "utf8");
}

export function branchExists(cwd: string, branchName: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`], {
      cwd,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

export function switchToBranch(cwd: string, branchName: string): void {
  runGit(cwd, ["switch", branchName]);
}

export function createAndSwitchBranch(cwd: string, branchName: string, startPoint: string): void {
  if (branchExists(cwd, branchName)) {
    switchToBranch(cwd, branchName);
    return;
  }

  runGit(cwd, ["switch", "-c", branchName, startPoint]);
}

export function getMergeBase(cwd: string, leftRef: string, rightRef: string): string {
  return runGit(cwd, ["merge-base", leftRef, rightRef]).trim();
}

export function getWorktreeStatus(cwd: string): string {
  return runGit(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]).trim();
}

export function ensureCleanWorktree(cwd: string, reason: string): void {
  const status = getWorktreeStatus(cwd);
  if (status.length > 0) {
    throw new Error(`Cannot ${reason}: git worktree is dirty.\n${status}`);
  }
}

export function getChangedFiles(cwd: string): AutoresearchChangedFiles {
  const tracked = parseLines(runGit(cwd, ["diff", "--name-only", "--relative", "HEAD", "--"]));
  const untracked = parseLines(runGit(cwd, ["ls-files", "--others", "--exclude-standard", "--"]));
  const all = [...new Set([...tracked, ...untracked])].sort();
  return { tracked, untracked, all };
}

export function revertWorkingTreeChanges(cwd: string, changed: AutoresearchChangedFiles): void {
  if (changed.tracked.length > 0) {
    runGit(cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...changed.tracked]);
  }

  for (const relativePath of changed.untracked) {
    const absolutePath = resolve(cwd, relativePath);
    if (!isPathInsideRepo(cwd, absolutePath) || !existsSync(absolutePath)) {
      continue;
    }
    rmSync(absolutePath, { recursive: true, force: true });
  }
}

export function commitPaths(cwd: string, filePaths: string[], message: string): string {
  const uniquePaths = [...new Set(filePaths)].sort();
  if (uniquePaths.length === 0) {
    throw new Error("Cannot commit an empty autoresearch change set");
  }

  runGit(cwd, ["add", "--", ...uniquePaths]);
  const trimmedMessage = normalizeCommitSubject(message);
  runGit(cwd, ["commit", "-m", trimmedMessage, "-m", COPILOT_TRAILER]);
  return getHeadCommit(cwd);
}

export function cherryPickCommit(cwd: string, commitSha: string): string {
  try {
    runGit(cwd, ["cherry-pick", "-x", commitSha]);
  } catch (error) {
    try {
      runGit(cwd, ["cherry-pick", "--abort"]);
    } catch {
      // Keep the original cherry-pick error.
    }
    throw error;
  }

  return getHeadCommit(cwd);
}

export function makeUniqueBranchName(cwd: string, branchName: string): string {
  if (!branchExists(cwd, branchName)) {
    return branchName;
  }

  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${branchName}-${index}`;
    if (!branchExists(cwd, candidate)) {
      return candidate;
    }
  }

  throw new Error(`Could not find an unused branch name for ${branchName}`);
}

function normalizeCommitSubject(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length > 0 ? compact : "autoresearch: keep improvement";
}

function parseLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isPathInsideRepo(repoRoot: string, absolutePath: string): boolean {
  const normalizedRepoRoot = resolve(repoRoot);
  const normalizedPath = resolve(absolutePath);
  return normalizedPath === normalizedRepoRoot || normalizedPath.startsWith(`${normalizedRepoRoot}${sep}`);
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

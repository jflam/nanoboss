import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { getNanobossHome } from "./config.ts";

export function detectRepoRoot(cwd: string): string | undefined {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return root ? resolve(root) : undefined;
  } catch {
    return undefined;
  }
}

export function resolveRepoProcedureRoot(cwd: string): string | undefined {
  const repoRoot = detectRepoRoot(resolve(cwd));
  return repoRoot ? join(repoRoot, ".nanoboss", "procedures") : undefined;
}

export function resolveWorkspaceProcedureRoot(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  const cwdProcedureRoot = join(resolvedCwd, ".nanoboss", "procedures");
  if (existsSync(cwdProcedureRoot)) {
    return cwdProcedureRoot;
  }

  return join(detectRepoRoot(resolvedCwd) ?? resolvedCwd, ".nanoboss", "procedures");
}

export function resolveProfileProcedureRoot(): string {
  return join(getNanobossHome(), "procedures");
}

export function resolveWorkspaceProcedureRoots(cwd: string): string[] {
  return uniquePaths([
    resolveWorkspaceProcedureRoot(cwd),
    resolveProfileProcedureRoot(),
  ]);
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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

export function resolveProfileProcedureRoot(): string {
  return join(getNanobossHome(), "procedures");
}

export function resolveWorkspaceProcedureRoots(
  cwd: string,
  profileProcedureRoot = resolveProfileProcedureRoot(),
): string[] {
  return uniquePaths([
    resolveLocalProcedureRoot(cwd),
    profileProcedureRoot,
  ]);
}

export function resolvePersistProcedureRoot(
  cwd: string,
  profileProcedureRoot = resolveProfileProcedureRoot(),
): string {
  return resolve(resolveRepoProcedureRoot(cwd) ?? profileProcedureRoot);
}

function resolveLocalProcedureRoot(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  const cwdProcedureRoot = join(resolvedCwd, ".nanoboss", "procedures");
  if (existsSync(cwdProcedureRoot)) {
    return cwdProcedureRoot;
  }

  return join(detectRepoRoot(resolvedCwd) ?? resolvedCwd, ".nanoboss", "procedures");
}

function getNanobossHome(): string {
  return join(process.env.HOME?.trim() || homedir(), ".nanoboss");
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}

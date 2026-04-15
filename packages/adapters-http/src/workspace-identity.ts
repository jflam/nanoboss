import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface WorkspaceIdentity {
  cwd: string;
  repoRoot?: string;
  workspaceKey: string;
  procedureRoots: string[];
  proceduresFingerprint: string;
}

export function getWorkspaceIdentity(cwd: string): WorkspaceIdentity {
  const resolvedCwd = resolve(cwd);
  const repoRoot = detectRepoRoot(resolvedCwd);
  const procedureRoots = resolveWorkspaceProcedureRoots(resolvedCwd);
  return {
    cwd: resolvedCwd,
    repoRoot,
    workspaceKey: repoRoot ?? resolvedCwd,
    procedureRoots,
    proceduresFingerprint: computeProceduresFingerprint(procedureRoots),
  };
}

export function computeProceduresFingerprint(procedureRoots: string[]): string {
  const hash = createHash("sha256");

  for (const procedureRoot of uniquePaths(procedureRoots)) {
    hash.update(`${procedureRoot}\n`);
    if (!existsSync(procedureRoot)) {
      hash.update("<missing>\n");
      continue;
    }

    const files = listTypeScriptFiles(procedureRoot);
    for (const file of files) {
      const path = join(procedureRoot, file);
      hash.update(`${file}\n`);
      hash.update(readFileSync(path));
      hash.update("\n");
    }
  }

  return hash.digest("hex").slice(0, 12);
}

function detectRepoRoot(cwd: string): string | undefined {
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

function resolveWorkspaceProcedureRoots(cwd: string): string[] {
  return uniquePaths([
    resolveLocalProcedureRoot(cwd),
    join(process.env.HOME?.trim() || homedir(), ".nanoboss", "procedures"),
  ]);
}

function resolveLocalProcedureRoot(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  const cwdProcedureRoot = join(resolvedCwd, ".nanoboss", "procedures");
  if (existsSync(cwdProcedureRoot)) {
    return cwdProcedureRoot;
  }

  return join(detectRepoRoot(resolvedCwd) ?? resolvedCwd, ".nanoboss", "procedures");
}

function listTypeScriptFiles(rootDir: string, prefix = ""): string[] {
  const files: string[] = [];
  const entries = readdirSync(join(rootDir, prefix), { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }

    const relativePath = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(rootDir, relativePath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(relativePath);
    }
  }

  return files;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}

import { getBuildLabel } from "@nanoboss/app-support";

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

interface BuildFreshnessStatus {
  outOfDate: boolean;
  reason?: string;
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
    normalized.startsWith("procedures/")
  );
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

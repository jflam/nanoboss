import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const DEFAULT_EXCLUDED_NAMES = new Set([
  ".git",
  ".nanoboss",
  "coverage",
  "dist",
  "node_modules",
]);
const DEFAULT_EXCLUDED_FILE_PATTERNS = [
  /~$/,
  /^\.#/,
  /^#.*#$/,
  /\.(?:swp|swo|tmp|temp)$/i,
  /^\.DS_Store$/,
] as const;

export interface RepoFingerprintOptions {
  cwd: string;
  include?: string[];
  exclude?: string[];
}

export interface RepoFingerprintResult {
  repoRoot: string;
  fingerprint: string;
  fileCount: number;
}

export function computeRepoFingerprint(options: RepoFingerprintOptions): RepoFingerprintResult {
  const repoRoot = resolve(detectRepoRoot(options.cwd) ?? options.cwd);
  const includeSet = new Set(normalizePaths(options.include ?? []));
  const excludeSet = new Set(normalizePaths(options.exclude ?? []));
  const files = listRelevantFiles(repoRoot, repoRoot, includeSet, excludeSet);
  const hash = createHash("sha256");

  for (const file of files) {
    hash.update(`${file}\n`);
    hash.update(readFileSync(join(repoRoot, file)));
    hash.update("\n");
  }

  return {
    repoRoot,
    fingerprint: hash.digest("hex").slice(0, 12),
    fileCount: files.length,
  };
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

function listRelevantFiles(
  root: string,
  currentDir: string,
  includeSet: Set<string>,
  excludeSet: Set<string>,
): string[] {
  if (!existsSync(currentDir)) {
    return [];
  }

  const files: string[] = [];
  const entries = readdirSync(currentDir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const absolutePath = join(currentDir, entry.name);
    const relativePath = normalizePath(relative(root, absolutePath));
    if (!relativePath || shouldExclude(relativePath, entry.name, includeSet, excludeSet)) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...listRelevantFiles(root, absolutePath, includeSet, excludeSet));
      continue;
    }

    if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files;
}

function shouldExclude(
  relativePath: string,
  entryName: string,
  includeSet: Set<string>,
  excludeSet: Set<string>,
): boolean {
  if (matchesPrefix(excludeSet, relativePath)) {
    return true;
  }

  if (DEFAULT_EXCLUDED_NAMES.has(entryName) || DEFAULT_EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(entryName))) {
    return !matchesPrefix(includeSet, relativePath);
  }

  if (includeSet.size === 0) {
    return false;
  }

  return !matchesPrefix(includeSet, relativePath);
}

function matchesPrefix(prefixes: Set<string>, relativePath: string): boolean {
  for (const prefix of prefixes) {
    if (relativePath === prefix || relativePath.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

function normalizePaths(values: string[]): string[] {
  return [...new Set(values.map((value) => normalizePath(value)).filter((value) => value.length > 0))];
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
}

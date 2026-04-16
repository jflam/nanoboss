import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CANONICAL_HELPERS = [
  "procedures/lib/repo-artifacts.ts",
  "procedures/lib/repo-fingerprint.ts",
] as const;

const BANNED_ROOT_HELPERS = [
  "src/util/repo-artifacts.ts",
  "src/core/repo-fingerprint.ts",
] as const;

const CANONICAL_IMPORTERS = [
  ["procedures/autoresearch/state.ts", 'from "../lib/repo-artifacts.ts"'],
  ["procedures/kb/lib/repository.ts", 'from "../../lib/repo-artifacts.ts"'],
  ["procedures/nanoboss/compact-test-cache.ts", 'from "../lib/repo-fingerprint.ts"'],
  ["procedures/simplify2.ts", 'from "./lib/repo-artifacts.ts"'],
  ["procedures/simplify2.ts", 'from "./lib/repo-fingerprint.ts"'],
  ["tests/unit/repo-artifacts.test.ts", 'from "../../procedures/lib/repo-artifacts.ts"'],
  ["tests/unit/repo-fingerprint.test.ts", 'from "../../procedures/lib/repo-fingerprint.ts"'],
] as const;

const bannedImportPattern = /^\s*(?:import|export)\b[^;]*?\bfrom\s*["'][^"']*src\/(?:util\/repo-artifacts|core\/repo-fingerprint)(?:\.ts)?["'];?/gm;
const bannedSideEffectImportPattern = /^\s*import\s*["'][^"']*src\/(?:util\/repo-artifacts|core\/repo-fingerprint)(?:\.ts)?["'];?/gm;

test("keeps repo helper ownership converged on procedures/lib", () => {
  for (const path of CANONICAL_HELPERS) {
    expect(existsSync(join(process.cwd(), path))).toBe(true);
  }

  for (const path of BANNED_ROOT_HELPERS) {
    expect(existsSync(join(process.cwd(), path))).toBe(false);
  }

  for (const [path, expectedImport] of CANONICAL_IMPORTERS) {
    const source = readFileSync(join(process.cwd(), path), "utf8");
    expect(source).toContain(expectedImport);
  }

  for (const path of listRepositoryTypeScriptFiles()) {
    const source = readFileSync(path, "utf8");
    expect(source).not.toMatch(bannedImportPattern);
    expect(source).not.toMatch(bannedSideEffectImportPattern);
  }
});

function listRepositoryTypeScriptFiles(): string[] {
  return [
    ...listTypeScriptFilesIn(join(process.cwd(), "src")),
    ...listTypeScriptFilesIn(join(process.cwd(), "packages")),
    ...listTypeScriptFilesIn(join(process.cwd(), "procedures")),
    ...listTypeScriptFilesIn(join(process.cwd(), "tests")),
    ...["build.ts", "cli.ts", "nanoboss.ts", "preload.ts", "resume.ts"]
      .map((path) => join(process.cwd(), path))
      .filter((path) => existsSync(path)),
  ];
}

function listTypeScriptFilesIn(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "node_modules") {
        continue;
      }
      files.push(...listTypeScriptFilesIn(path));
      continue;
    }

    if (entry.isFile() && path.endsWith(".ts")) {
      files.push(path);
    }
  }

  return files;
}

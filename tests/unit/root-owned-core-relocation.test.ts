import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const CANONICAL_ROOT_FILES = [
  "src/commands/doctor.ts",
  "src/dev/build-size-report.ts",
  "src/app-support/build-freshness.ts",
  "src/commands/http-options.ts",
] as const;

const BANNED_CORE_FILES = [
  "src/core/doctor.ts",
  "src/core/build-size-report.ts",
  "src/core/build-freshness.ts",
  "src/core/defaults.ts",
] as const;

const CANONICAL_IMPORT_EXPECTATIONS = [
  {
    path: "build.ts",
    snippet: 'from "./src/dev/build-size-report.ts"',
  },
  {
    path: "nanoboss.ts",
    snippet: 'from "./src/commands/http-options.ts"',
  },
  {
    path: "nanoboss.ts",
    snippet: 'import("./src/commands/doctor.ts")',
  },
  {
    path: "tests/unit/build-freshness.test.ts",
    snippet: 'from "../../src/app-support/build-freshness.ts"',
  },
  {
    path: "tests/unit/build-size-report.test.ts",
    snippet: 'from "../../src/dev/build-size-report.ts"',
  },
  {
    path: "tests/unit/doctor.test.ts",
    snippet: 'from "../../src/commands/doctor.ts"',
  },
] as const;

const bannedCoreImportPattern = /^\s*(?:import|export)\b[^;]*?\bfrom\s*["'][^"']*src\/core\/(?:doctor|build-size-report|build-freshness|defaults)(?:\.ts)?["'];?/gm;
const bannedCoreSideEffectImportPattern = /^\s*import\s*["'][^"']*src\/core\/(?:doctor|build-size-report|build-freshness|defaults)(?:\.ts)?["'];?/gm;
const bannedCoreDynamicImportPattern = /import\(\s*["'][^"']*src\/core\/(?:doctor|build-size-report|build-freshness|defaults)(?:\.ts)?["']\s*\)/g;

test("keeps root-owned command and support files out of src/core", () => {
  for (const path of CANONICAL_ROOT_FILES) {
    expect(existsSync(join(process.cwd(), path))).toBe(true);
  }

  for (const path of BANNED_CORE_FILES) {
    expect(existsSync(join(process.cwd(), path))).toBe(false);
  }

  for (const { path, snippet } of CANONICAL_IMPORT_EXPECTATIONS) {
    const source = readFileSync(join(process.cwd(), path), "utf8");
    expect(source).toContain(snippet);
  }

  for (const path of listRepositoryTypeScriptFiles()) {
    const source = readFileSync(path, "utf8");
    expect(source).not.toMatch(bannedCoreImportPattern);
    expect(source).not.toMatch(bannedCoreSideEffectImportPattern);
    expect(source).not.toMatch(bannedCoreDynamicImportPattern);
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

  return files.sort((left, right) => relative(process.cwd(), left).localeCompare(relative(process.cwd(), right)));
}

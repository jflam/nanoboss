import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const CANONICAL_IMPORT_EXPECTATIONS = [
  ["build.ts", 'from "@nanoboss/procedure-catalog"'],
  ["scripts/probe-acp-usage.ts", 'from "@nanoboss/procedure-engine"'],
  ["packages/procedure-engine/tests/config.test.ts", 'from "@nanoboss/procedure-engine"'],
  ["packages/app-runtime/tests/default-memory-bridge.test.ts", 'from "@nanoboss/app-runtime"'],
  ["packages/procedure-sdk/tests/runtime-banner.test.ts", 'from "@nanoboss/procedure-sdk"'],
  ["tests/unit/test-home-isolation.test.ts", 'from "@nanoboss/store"'],
  ["tests/unit/ui-cli.test.ts", 'from "@nanoboss/procedure-engine"'],
] as const;

test("keeps src/core deleted and out of repository TypeScript imports", () => {
  expect(existsSync(join(process.cwd(), "src/core"))).toBe(false);

  for (const [path, snippet] of CANONICAL_IMPORT_EXPECTATIONS) {
    const source = readFileSync(join(process.cwd(), path), "utf8");
    expect(source).toContain(snippet);
  }

  for (const path of listRepositoryTypeScriptFiles()) {
    const source = readFileSync(path, "utf8");
    expect(findRootCoreImportSpecifiers(path, source)).toEqual([]);
  }
});

function findRootCoreImportSpecifiers(path: string, source: string): string[] {
  const violations: string[] = [];
  const importPattern = /(?:from\s*|import\s*\(\s*|import\s+)["']([^"']+)["']/g;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier) {
      continue;
    }

    const resolved = specifier.startsWith(".")
      ? relative(process.cwd(), resolve(dirname(path), specifier)).replaceAll("\\", "/")
      : specifier;
    if (resolved === "src/core" || resolved.startsWith("src/core/")) {
      violations.push(specifier);
    }
  }
  return violations;
}

function listRepositoryTypeScriptFiles(): string[] {
  return [
    ...listTypeScriptFilesIn(join(process.cwd(), "src")),
    ...listTypeScriptFilesIn(join(process.cwd(), "packages")),
    ...listTypeScriptFilesIn(join(process.cwd(), "procedures")),
    ...listTypeScriptFilesIn(join(process.cwd(), "scripts")),
    ...listTypeScriptFilesIn(join(process.cwd(), "tests")),
    ...["build.ts", "cli.ts", "nanoboss.ts", "preload.ts", "resume.ts"]
      .map((path) => join(process.cwd(), path))
      .filter((path) => existsSync(path)),
  ].sort((left, right) => relative(process.cwd(), left).localeCompare(relative(process.cwd(), right)));
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

import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

const CANONICAL_HELPERS = [
  "packages/store/src/agent-selection.ts",
  "packages/store/src/settings.ts",
  "packages/store/src/stored-values.ts",
] as const;

const BANNED_HELPER_FILES = [
  "src/core/downstream-agent-selection.ts",
  "src/core/settings.ts",
  "packages/adapters-tui/src/settings.ts",
  "packages/procedure-engine/src/stored-kernel.ts",
] as const;

const HELPER_FILE_NAMES = new Set([
  "agent-selection.ts",
  "settings.ts",
  "stored-values.ts",
  "stored-kernel.ts",
]);

const CANONICAL_IMPORTERS = [
  ["tests/unit/autoresearch-command.test.ts", 'from "@nanoboss/store"'],
  ["packages/adapters-mcp/src/server.ts", 'from "@nanoboss/store"'],
  ["packages/adapters-tui/src/app.ts", 'from "@nanoboss/store"'],
  ["packages/procedure-engine/src/context/agent-api.ts", 'from "@nanoboss/store"'],
  ["packages/procedure-engine/src/context/state-api.ts", 'from "@nanoboss/store"'],
  ["packages/procedure-engine/tests/config.test.ts", 'from "@nanoboss/store"'],
  ["packages/store/tests/settings.test.ts", 'from "@nanoboss/store"'],
] as const;

const bannedRootImportPattern = /^\s*(?:import|export)\b[^;]*?\bfrom\s*["'][^"']*src\/core\/(?:settings|downstream-agent-selection)(?:\.ts)?["'];?/gm;
const bannedRootSideEffectImportPattern = /^\s*import\s*["'][^"']*src\/core\/(?:settings|downstream-agent-selection)(?:\.ts)?["'];?/gm;
const bannedDuplicateHelperPathPattern = /^\s*(?:import|export)\b[^;]*?\bfrom\s*["'](?!@nanoboss\/store["'])[^"']*(?:settings|stored-values|stored-kernel|agent-selection)(?:\.ts)?["'];?/gm;
const bannedDuplicateHelperFunctionPattern = /\b(?:export\s+)?function\s+(?:readNanobossSettings|readPersistedDefaultAgentSelection|writePersistedDefaultAgentSelection|parseRequiredDownstreamAgentSelection|publicKernelValueFromStored|publicContinuationFromStored)\s*\(/g;

test("keeps storage helper ownership converged on @nanoboss/store", () => {
  for (const path of CANONICAL_HELPERS) {
    expect(existsSync(join(process.cwd(), path))).toBe(true);
  }

  for (const path of BANNED_HELPER_FILES) {
    expect(existsSync(join(process.cwd(), path))).toBe(false);
  }

  expect(listHelperFiles()).toEqual([...CANONICAL_HELPERS]);

  for (const [path, expectedImport] of CANONICAL_IMPORTERS) {
    const source = readFileSync(join(process.cwd(), path), "utf8");
    expect(source).toContain(expectedImport);
  }

  for (const path of listRepositoryTypeScriptFiles()) {
    const relativePath = relative(process.cwd(), path);
    const source = readFileSync(path, "utf8");
    expect(source).not.toMatch(bannedRootImportPattern);
    expect(source).not.toMatch(bannedRootSideEffectImportPattern);

    if (!relativePath.startsWith("packages/store/src/")) {
      expect(source).not.toMatch(bannedDuplicateHelperPathPattern);
      expect(source).not.toMatch(bannedDuplicateHelperFunctionPattern);
    }
  }
});

function listHelperFiles(): string[] {
  return listRepositoryTypeScriptFiles()
    .map((path) => relative(process.cwd(), path))
    .filter((path) => HELPER_FILE_NAMES.has(basename(path)))
    .sort();
}

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

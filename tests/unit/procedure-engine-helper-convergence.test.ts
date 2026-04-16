import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const BANNED_CORE_HELPERS = [
  "cancellation",
  "error-format",
  "timing-trace",
  "logger",
  "self-command",
  "data-shape",
  "run-result",
] as const;

const BANNED_CORE_BARRIER_FILES = [
  ...BANNED_CORE_HELPERS.map((name) => `src/core/${name}.ts`),
  "src/core/types.ts",
  "src/core/contracts.ts",
] as const;

const CANONICAL_IMPORTERS = [
  "packages/app-runtime/src/default-agent-policy.ts",
  "packages/app-runtime/src/runtime-service.ts",
  "packages/app-runtime/src/service.ts",
  "packages/procedure-engine/tests/error-format.test.ts",
  "packages/procedure-engine/tests/logger.test.ts",
  "packages/procedure-engine/tests/self-command.test.ts",
] as const;

const ROOT_TS_FILES = [
  "build.ts",
  "cli.ts",
  "nanoboss.ts",
  "preload.ts",
  "resume.ts",
] as const;

const bannedImportPattern = new RegExp(
  String.raw`^\s*(?:import|export)\b[^;]*?\bfrom\s*["'][^"']*src\/core\/(?:${BANNED_CORE_HELPERS.join("|")}|types|contracts)(?:\.ts)?["'];?`,
  "gm",
);

const bannedSideEffectImportPattern = new RegExp(
  String.raw`^\s*import\s*["'][^"']*src\/core\/(?:${BANNED_CORE_HELPERS.join("|")}|types|contracts)(?:\.ts)?["'];?`,
  "gm",
);

test("keeps procedure-engine execution helpers converged on the package owner", () => {
  for (const path of BANNED_CORE_BARRIER_FILES) {
    expect(existsSync(join(process.cwd(), path))).toBe(false);
  }

  for (const path of CANONICAL_IMPORTERS) {
    const source = readFileSync(join(process.cwd(), path), "utf8");
    expect(source).toContain('from "@nanoboss/procedure-engine"');
  }

  for (const path of listRepositoryTypeScriptFiles()) {
    const source = readFileSync(path, "utf8");
    expect(source).not.toMatch(bannedImportPattern);
    expect(source).not.toMatch(bannedSideEffectImportPattern);
  }
});

function listRepositoryTypeScriptFiles(): string[] {
  return [
    ...ROOT_TS_FILES.map((path) => join(process.cwd(), path)).filter((path) => existsSync(path)),
    ...listTypeScriptFilesIn(join(process.cwd(), "src")),
    ...listTypeScriptFilesIn(join(process.cwd(), "packages")),
    ...listTypeScriptFilesIn(join(process.cwd(), "procedures")),
    ...listTypeScriptFilesIn(join(process.cwd(), "tests")),
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

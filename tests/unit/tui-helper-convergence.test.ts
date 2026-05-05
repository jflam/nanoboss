import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = process.cwd();

const CANONICAL_TUI_HELPER_OWNERS = [
  "packages/adapters-tui/src/app/app-continuation-composer.ts",
  "packages/adapters-tui/src/app/app-model-selection.ts",
  "packages/adapters-tui/src/core/core-system-panels.ts",
] as const;

const BANNED_TUI_GLUE_FILES = [
  "packages/adapters-tui/src/app-inline-select.ts",
  "packages/adapters-tui/src/app-model-prompts.ts",
  "packages/adapters-tui/src/core-panel-fallbacks.ts",
] as const;

const bannedGlueImportPattern = /^\s*(?:import|export)\b[^;]*?\bfrom\s*["'][^"']*\/(?:app-inline-select|app-model-prompts|core-panel-fallbacks)(?:\.ts)?["'];?/gm;
const bannedGlueClassPattern = /\bclass\s+(?:AppInlineSelect|AppModelPromptsAdapter)\b/g;

test("keeps TUI app helper ownership converged on durable owners", () => {
  for (const path of CANONICAL_TUI_HELPER_OWNERS) {
    expect(existsSync(join(REPO_ROOT, path))).toBe(true);
  }

  for (const path of BANNED_TUI_GLUE_FILES) {
    expect(existsSync(join(REPO_ROOT, path))).toBe(false);
  }

  for (const path of listTuiSourceFiles()) {
    const source = readFileSync(path, "utf8");
    expect(source).not.toMatch(bannedGlueImportPattern);
    expect(source).not.toMatch(bannedGlueClassPattern);
  }
});

function listTuiSourceFiles(): string[] {
  return listTypeScriptFilesIn(join(REPO_ROOT, "packages", "adapters-tui", "src"));
}

function listTypeScriptFilesIn(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFilesIn(path));
      continue;
    }

    if (entry.isFile() && path.endsWith(".ts")) {
      files.push(path);
    }
  }

  return files.sort((left, right) => relative(REPO_ROOT, left).localeCompare(relative(REPO_ROOT, right)));
}

import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

const CANONICAL_HELPERS = [
  "packages/app-support/src/build-info.ts",
  "packages/app-support/src/install-path.ts",
  "packages/app-support/src/procedure-paths.ts",
  "packages/app-support/src/repo-artifacts.ts",
  "packages/app-support/src/repo-fingerprint.ts",
  "packages/app-support/src/workspace-identity.ts",
] as const;

const BANNED_ROOT_HELPERS = [
  "src/core/build-info.ts",
  "src/core/install-path.ts",
  "src/core/procedure-paths.ts",
  "src/core/workspace-identity.ts",
] as const;

const HELPER_FILE_NAMES = new Set([
  "build-info.ts",
  "install-path.ts",
  "procedure-paths.ts",
  "repo-artifacts.ts",
  "repo-fingerprint.ts",
  "workspace-identity.ts",
]);

const CANONICAL_IMPORTERS = [
  "build.ts",
  "packages/adapters-acp-server/src/server.ts",
  "packages/adapters-http/src/private-server.ts",
  "packages/adapters-http/src/server.ts",
  "packages/adapters-http/src/server-supervisor.ts",
  "packages/adapters-mcp/src/server.ts",
  "packages/adapters-tui/src/build-freshness.ts",
  "packages/adapters-tui/src/controller-initial-state.ts",
  "packages/app-runtime/src/session-runtime.ts",
  "packages/procedure-catalog/src/registry.ts",
  "packages/store/src/session-repository.ts",
  "packages/app-support/tests/repo-artifacts.test.ts",
  "packages/app-support/tests/repo-fingerprint.test.ts",
  "procedures/create.ts",
  "procedures/autoresearch/state.ts",
  "procedures/kb/lib/repository.ts",
  "procedures/nanoboss/compact-test-cache.ts",
  "procedures/simplify2.ts",
  "src/app-support/build-freshness.ts",
  "packages/app-runtime/tests/current-session.test.ts",
  "packages/adapters-http/tests/http-server-supervisor.test.ts",
  "packages/app-support/tests/install-path.test.ts",
  "tests/unit/resume.test.ts",
] as const;

const bannedRootImportPattern = /^\s*(?:import|export)\b[^;]*?\bfrom\s*["'][^"']*src\/core\/(?:build-info|install-path|procedure-paths|repo-artifacts|repo-fingerprint|workspace-identity)(?:\.ts)?["'];?/gm;
const bannedRootSideEffectImportPattern = /^\s*import\s*["'][^"']*src\/core\/(?:build-info|install-path|procedure-paths|repo-artifacts|repo-fingerprint|workspace-identity)(?:\.ts)?["'];?/gm;
const bannedNonCanonicalHelperPathPattern = /^\s*(?:import|export)\b[^;]*?\bfrom\s*["'](?!@nanoboss\/app-support["'])[^"']*(?:build-info|install-path|procedure-paths|repo-artifacts|repo-fingerprint|workspace-identity)(?:\.ts)?["'];?/gm;
const bannedHelperFunctionPattern = /\bfunction\s+(?:getBuildCommit|getBuildLabel|resolveNanobossInstallDir|splitPath|detectRepoRoot|resolveRepoProcedureRoot|resolveProfileProcedureRoot|resolveWorkspaceProcedureRoots|resolvePersistProcedureRoot|resolveRepoArtifactDir|ensureDirectories|ensureFile|writeTextFileAtomicSync|writeJsonFileAtomicSync|writeJsonFileAtomic|computeRepoFingerprint|getWorkspaceIdentity|resolveWorkspaceKey|computeProceduresFingerprint)\s*\(/g;

test("keeps support helper ownership converged on @nanoboss/app-support", () => {
  for (const path of CANONICAL_HELPERS) {
    expect(existsSync(join(process.cwd(), path))).toBe(true);
  }

  for (const path of BANNED_ROOT_HELPERS) {
    expect(existsSync(join(process.cwd(), path))).toBe(false);
  }

  expect(listHelperFiles()).toEqual([...CANONICAL_HELPERS]);

  for (const path of CANONICAL_IMPORTERS) {
    const source = readFileSync(join(process.cwd(), path), "utf8");
    expect(source).toContain('from "@nanoboss/app-support"');
  }

  for (const path of listRepositoryTypeScriptFiles()) {
    const relativePath = relative(process.cwd(), path);
    const source = readFileSync(path, "utf8");
    expect(source).not.toMatch(bannedRootImportPattern);
    expect(source).not.toMatch(bannedRootSideEffectImportPattern);

    if (!relativePath.startsWith("packages/app-support/src/")) {
      expect(source).not.toMatch(bannedNonCanonicalHelperPathPattern);
      expect(source).not.toMatch(bannedHelperFunctionPattern);
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

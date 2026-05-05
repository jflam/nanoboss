import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const DELETED_ROOT_SHIM_PATHS = [
  "src/agent/token-metrics.ts",
  "src/core/service.ts",
  "src/http/client.ts",
  "src/http/server.ts",
  "src/mcp/jsonrpc.ts",
  "src/session/repository.ts",
  "src/tui/controller.ts",
] as const;

const DELETED_ROOT_HELPER_PATHS = [
  "src/procedure/tagged-json-line-stream.ts",
  "src/util/text.ts",
] as const;

const CANONICAL_IMPORT_EXPECTATIONS = [
  ["nanoboss.ts", 'import("@nanoboss/app-runtime")'],
  ["src/commands/http.ts", 'from "@nanoboss/adapters-http"'],
  ["packages/procedure-sdk/tests/tagged-json-line-stream.test.ts", 'from "@nanoboss/procedure-sdk"'],
  ["packages/procedure-sdk/tests/text.test.ts", 'from "@nanoboss/procedure-sdk"'],
  ["packages/adapters-tui/tests/tui-controller.test.ts", 'from "@nanoboss/adapters-tui"'],
  ["tests/unit/mcp-server.test.ts", 'from "@nanoboss/app-runtime"'],
] as const;

const PACKAGE_EXPORT_EXPECTATIONS = [
  ["packages/adapters-http/src/index.ts", "getServerHealth"],
  ["packages/adapters-http/src/index.ts", "startHttpServer"],
  ["packages/adapters-mcp/src/index.ts", "runMcpServer"],
  ["packages/adapters-mcp/src/index.ts", "registerSupportedAgentMcp"],
  ["packages/adapters-tui/src/index.ts", "NanobossTuiController"],
  ["packages/agent-acp/src/index.ts", 'from "./token-metrics.ts";'],
  ["packages/procedure-sdk/src/index.ts", 'from "./tagged-json-line-stream.ts";'],
  ["packages/procedure-sdk/src/index.ts", 'from "./text.ts";'],
  ["packages/store/src/index.ts", 'from "./session-repository.ts";'],
  [
    "packages/app-runtime/src/index.ts",
    "createCurrentSessionBackedNanobossRuntimeService",
  ],
  ["packages/app-runtime/src/index.ts", "createNanobossRuntimeService"],
] as const;

const bannedPackageInternalImportPattern = /^\s*(?:import|export)\b[^;]*?["'][^"']*packages\/[^"']*\/src\/[^"']*["'];?/gm;
const bannedPackageInternalDynamicImportPattern = /import\(\s*["'][^"']*packages\/[^"']*\/src\/[^"']*["']\s*\)/g;
const PHASE_2_COLLAPSED_HELPER_FILES = new Map<string, readonly string[]>([
  ["agent-selection.ts", ["packages/store/src/agent-selection.ts"]],
  ["build-info.ts", ["packages/app-support/src/build-info.ts"]],
  ["install-path.ts", ["packages/app-support/src/install-path.ts"]],
  ["model-catalog.ts", ["packages/agent-acp/src/model-catalog.ts"]],
  ["procedure-paths.ts", ["packages/app-support/src/procedure-paths.ts"]],
  ["prompt-input.ts", ["packages/procedure-sdk/src/prompt-input.ts"]],
  ["repo-artifacts.ts", ["packages/app-support/src/repo-artifacts.ts"]],
  ["repo-fingerprint.ts", ["packages/app-support/src/repo-fingerprint.ts"]],
  ["settings.ts", ["packages/store/src/settings.ts"]],
  ["stored-values.ts", ["packages/store/src/stored-values.ts"]],
  ["workspace-identity.ts", ["packages/app-support/src/workspace-identity.ts"]],
]);
const PHASE_2_HELPER_FUNCTION_OWNERS = new Map<string, string>([
  ["buildImageTokenLabel", "packages/procedure-sdk/src/prompt-input.ts"],
  ["computeProceduresFingerprint", "packages/app-support/src/workspace-identity.ts"],
  ["createTextPromptInput", "packages/procedure-sdk/src/prompt-input.ts"],
  ["detectRepoRoot", "packages/app-support/src/procedure-paths.ts"],
  ["getAgentCatalog", "packages/agent-acp/src/model-catalog.ts"],
  ["getBuildCommit", "packages/app-support/src/build-info.ts"],
  ["getBuildLabel", "packages/app-support/src/build-info.ts"],
  ["getWorkspaceIdentity", "packages/app-support/src/workspace-identity.ts"],
  ["hasPromptInputContent", "packages/procedure-sdk/src/prompt-input.ts"],
  ["hasPromptInputImages", "packages/procedure-sdk/src/prompt-input.ts"],
  ["isKnownAgentProvider", "packages/agent-acp/src/model-catalog.ts"],
  ["listKnownProviders", "packages/agent-acp/src/model-catalog.ts"],
  ["normalizePromptInput", "packages/procedure-sdk/src/prompt-input.ts"],
  ["parseReasoningModelSelection", "packages/agent-acp/src/model-catalog.ts"],
  ["parseRequiredDownstreamAgentSelection", "packages/store/src/agent-selection.ts"],
  ["parsePromptInputPayload", "packages/procedure-sdk/src/prompt-input.ts"],
  ["prependPromptInputText", "packages/app-runtime/src/runtime-prompt.ts"],
  ["publicContinuationFromStored", "packages/store/src/stored-values.ts"],
  ["publicKernelValueFromStored", "packages/store/src/stored-values.ts"],
  ["promptInputAttachmentSummaries", "packages/procedure-sdk/src/prompt-input.ts"],
  ["promptInputDisplayText", "packages/procedure-sdk/src/prompt-input.ts"],
  ["promptInputFromAcpBlocks", "packages/agent-acp/src/prompt.ts"],
  ["promptInputToAcpBlocks", "packages/agent-acp/src/prompt.ts"],
  ["readNanobossSettings", "packages/store/src/settings.ts"],
  ["readPersistedDefaultAgentSelection", "packages/store/src/settings.ts"],
  ["resolveRepoArtifactDir", "packages/app-support/src/repo-artifacts.ts"],
  ["resolveNanobossInstallDir", "packages/app-support/src/install-path.ts"],
  ["resolvePersistProcedureRoot", "packages/app-support/src/procedure-paths.ts"],
  ["resolveProfileProcedureRoot", "packages/app-support/src/procedure-paths.ts"],
  ["resolveRepoProcedureRoot", "packages/app-support/src/procedure-paths.ts"],
  ["resolveWorkspaceKey", "packages/app-support/src/workspace-identity.ts"],
  ["resolveWorkspaceProcedureRoots", "packages/app-support/src/procedure-paths.ts"],
  ["computeRepoFingerprint", "packages/app-support/src/repo-fingerprint.ts"],
  ["summarizePromptInputForAcpLog", "packages/agent-acp/src/prompt.ts"],
  ["writeJsonFileAtomic", "packages/app-support/src/repo-artifacts.ts"],
  ["writeJsonFileAtomicSync", "packages/app-support/src/repo-artifacts.ts"],
  ["writeTextFileAtomicSync", "packages/app-support/src/repo-artifacts.ts"],
  ["writePersistedDefaultAgentSelection", "packages/store/src/settings.ts"],
]);
const bannedDeletedRootImportPattern = createDeletedRootImportPattern(
  [...DELETED_ROOT_SHIM_PATHS, ...DELETED_ROOT_HELPER_PATHS],
  "^(?:\\s*(?:import|export)\\b[^;]*?from\\s*[\"'][^\"']*|\\s*import\\s*[\"'][^\"']*)",
  "[\"'];?",
  "gm",
);
const bannedDeletedRootDynamicImportPattern = createDeletedRootImportPattern(
  [...DELETED_ROOT_SHIM_PATHS, ...DELETED_ROOT_HELPER_PATHS],
  "import\\(\\s*[\"'][^\"']*",
  "[\"']\\s*\\)",
  "g",
);

test("deleted root shims stay removed and root entrypoints use canonical package APIs", () => {
  for (const path of [...DELETED_ROOT_SHIM_PATHS, ...DELETED_ROOT_HELPER_PATHS]) {
    expect(existsSync(join(process.cwd(), path))).toBe(false);
  }

  for (const [path, snippet] of CANONICAL_IMPORT_EXPECTATIONS) {
    const source = readFileSync(join(process.cwd(), path), "utf8");
    expect(source).toContain(snippet);
  }

  for (const [path, snippet] of PACKAGE_EXPORT_EXPECTATIONS) {
    const source = readFileSync(join(process.cwd(), path), "utf8");
    expect(source).toContain(snippet);
  }

  for (const path of listRootAppTypeScriptFiles()) {
    const source = readFileSync(path, "utf8");
    expect(source).not.toMatch(bannedPackageInternalImportPattern);
    expect(source).not.toMatch(bannedPackageInternalDynamicImportPattern);
  }

  expect(findPackageReverseImportViolations()).toEqual([]);
  expect(findRootPackageInternalImportViolations()).toEqual([]);

  for (const path of listRepositoryTypeScriptFiles()) {
    const source = readFileSync(path, "utf8");
    expect(source).not.toMatch(bannedDeletedRootImportPattern);
    expect(source).not.toMatch(bannedDeletedRootDynamicImportPattern);
  }

  for (const [fileName, expectedOwners] of PHASE_2_COLLAPSED_HELPER_FILES) {
    expect(listRepositoryFilesNamed(fileName)).toEqual([...expectedOwners]);
  }

  for (const [functionName, expectedOwner] of PHASE_2_HELPER_FUNCTION_OWNERS) {
    expect(findFunctionDeclarationPaths(functionName)).toEqual([expectedOwner]);
  }
});

test("packages keep baseline manifest and tsconfig parity", () => {
  for (const packageRoot of listPackageRoots()) {
    expect(existsSync(join(packageRoot, "tsconfig.json"))).toBe(true);

    const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      scripts?: { test?: unknown; typecheck?: unknown };
    };

    expect(typeof packageJson.scripts?.test).toBe("string");
    expect(typeof packageJson.scripts?.typecheck).toBe("string");
  }
});

test("package entrypoints stay explicit", () => {
  for (const packageRoot of listPackageRoots()) {
    const indexPath = join(packageRoot, "src", "index.ts");
    if (!existsSync(indexPath)) {
      continue;
    }

    const source = readFileSync(indexPath, "utf8");
    expect(source).not.toMatch(/^\s*export\s+\*\s+from\s+["'][^"']+["'];?\s*$/m);
  }
});

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

function listRootAppTypeScriptFiles(): string[] {
  return [
    ...["build.ts", "cli.ts", "nanoboss.ts", "preload.ts", "resume.ts"]
      .map((path) => join(process.cwd(), path))
      .filter((path) => existsSync(path)),
    ...listTypeScriptFilesIn(join(process.cwd(), "src")),
  ].sort((left, right) => relative(process.cwd(), left).localeCompare(relative(process.cwd(), right)));
}

function listPackageRoots(): string[] {
  return readdirSync(join(process.cwd(), "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(process.cwd(), "packages", entry.name))
    .sort((left, right) => relative(process.cwd(), left).localeCompare(relative(process.cwd(), right)));
}

function createDeletedRootImportPattern(
  paths: readonly string[],
  prefix: string,
  suffix: string,
  flags: string,
): RegExp {
  const alternatives = paths
    .map((path) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return new RegExp(`${prefix}(?:${alternatives})${suffix}`, flags);
}

function listRepositoryTypeScriptFiles(): string[] {
  return [
    ...listRootAppTypeScriptFiles(),
    ...listTypeScriptFilesIn(join(process.cwd(), "packages")),
    ...listTypeScriptFilesIn(join(process.cwd(), "procedures")),
    ...listTypeScriptFilesIn(join(process.cwd(), "scripts")),
    ...listTypeScriptFilesIn(join(process.cwd(), "tests")),
  ].sort((left, right) => relative(process.cwd(), left).localeCompare(relative(process.cwd(), right)));
}

function findPackageReverseImportViolations(): string[] {
  return findImportViolations(
    listTypeScriptFilesIn(join(process.cwd(), "packages")),
    (specifier, resolvedTarget) => resolvedTarget?.startsWith("src/") === true || specifier.startsWith("src/"),
  );
}

function findRootPackageInternalImportViolations(): string[] {
  return findImportViolations(
    listRootAppTypeScriptFiles(),
    (specifier, resolvedTarget) =>
      isPackageInternalPath(specifier) || (resolvedTarget !== null && isPackageInternalPath(resolvedTarget)),
  );
}

function findImportViolations(
  files: readonly string[],
  isViolation: (specifier: string, resolvedTarget: string | null) => boolean,
): string[] {
  const violations: string[] = [];
  for (const path of files) {
    const source = readFileSync(path, "utf8");
    for (const specifier of listImportSpecifiers(source)) {
      const resolvedTarget = resolveRepositoryImport(path, specifier);
      if (!isViolation(specifier, resolvedTarget)) {
        continue;
      }
      violations.push(`${relative(process.cwd(), path)} -> ${specifier}`);
    }
  }
  return violations.sort();
}

function listImportSpecifiers(source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map((entry) => entry.fileName);
}

function resolveRepositoryImport(importerPath: string, specifier: string): string | null {
  if (specifier.startsWith("src/") || specifier.startsWith("packages/")) {
    return normalizeRepositoryPath(join(process.cwd(), specifier));
  }

  if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
    return null;
  }

  return normalizeRepositoryPath(resolve(dirname(importerPath), specifier));
}

function normalizeRepositoryPath(path: string): string | null {
  const relativePath = relative(process.cwd(), path).replaceAll("\\", "/");
  if (relativePath.startsWith("../")) {
    return null;
  }
  return relativePath;
}

function isPackageInternalPath(path: string): boolean {
  return /^packages\/[^/]+\/src\//.test(path);
}

function listRepositoryFilesNamed(fileName: string): string[] {
  return listRepositoryTypeScriptFiles()
    .map((path) => relative(process.cwd(), path))
    .filter((path) => basename(path) === fileName)
    .sort();
}

function findFunctionDeclarationPaths(functionName: string): string[] {
  const declarationPattern = new RegExp(
    String.raw`\b(?:export\s+)?(?:async\s+)?function\s+${functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\s*\(`,
  );

  return listRepositoryTypeScriptFiles()
    .filter((path) => declarationPattern.test(readFileSync(path, "utf8")))
    .map((path) => relative(process.cwd(), path))
    .sort();
}

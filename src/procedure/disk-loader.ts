import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { getProcedureRuntimeDir } from "../core/config.ts";
import { resolveRepoProcedureRoot } from "../core/procedure-paths.ts";
import type {
  DeferredProcedureMetadata,
  Procedure,
  ProcedureExecutionMode,
} from "../core/types.ts";
import { resolveProcedureEntryRelativePath } from "./names.ts";
import { createTypiaBunPlugin } from "./typia-bun-plugin.ts";

export interface DiskProcedureDefinition extends DeferredProcedureMetadata {
  path: string;
  workspaceRoot: string;
}

interface ProcedureSourceFile {
  path: string;
  contents: string;
}

const PROCEDURE_BUILD_CACHE_VERSION = 1;
const LOCAL_IMPORT_PATTERNS = [
  /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["'`](\.[^"'`]+)["'`]/g,
  /\bimport\s*\(\s*["'`](\.[^"'`]+)["'`]\s*\)/g,
];

export function discoverDiskProcedures(procedureRoot: string): DiskProcedureDefinition[] {
  if (!existsSync(procedureRoot)) {
    return [];
  }

  const workspaceRoot = resolveDiskProcedureWorkspaceRoot(procedureRoot);
  return listProcedureSourcePaths(procedureRoot)
    .map((path) => {
      const metadata = readProcedureMetadata(path);
      return metadata ? { ...metadata, path, workspaceRoot } : undefined;
    })
    .filter((definition): definition is DiskProcedureDefinition => definition !== undefined);
}

export async function loadProcedureFromPath(path: string, workspaceRoot?: string): Promise<Procedure> {
  const moduleUrl = await buildProcedureModule(path, workspaceRoot);
  const loaded: unknown = await import(moduleUrl);
  const procedure = getDefaultExport(loaded);
  assertProcedure(procedure);
  return procedure;
}

export async function persistProcedureSource(params: {
  procedureName: string;
  source: string;
  cwd?: string;
  fallbackProcedureRoot?: string;
  profileProcedureRoot: string;
}): Promise<string> {
  const procedureRoot = resolvePersistProcedureRoot(params);
  const filePath = join(procedureRoot, resolveProcedureEntryRelativePath(params.procedureName));
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, params.source, "utf8");
  return filePath;
}

function assertProcedure(procedure: unknown): asserts procedure is Procedure {
  if (
    !procedure ||
    typeof procedure !== "object" ||
    typeof (procedure as Procedure).name !== "string" ||
    typeof (procedure as Procedure).description !== "string" ||
    typeof (procedure as Procedure).execute !== "function"
  ) {
    throw new Error("Procedure module does not export a valid default procedure");
  }
}

function getDefaultExport(module: unknown): unknown {
  if (!module || typeof module !== "object" || !("default" in module)) {
    return undefined;
  }

  return module.default;
}

async function buildProcedureModule(path: string, workspaceRoot?: string): Promise<string> {
  const resolvedWorkspaceRoot = resolveProcedureWorkspaceRoot(path, workspaceRoot);
  const cacheKey = buildProcedureCacheKey(path, resolvedWorkspaceRoot);
  const cacheDir = join(getProcedureBuildCacheDir(), cacheKey);
  const cacheModulePath = join(cacheDir, "module.js");
  if (!existsSync(cacheModulePath)) {
    const outdir = mkdtempSync(join(tmpdir(), "nanoboss-procedure-"));
    try {
      const result = await withProcedureBuildNodeModules(resolvedWorkspaceRoot, async () =>
        await Bun.build({
          entrypoints: [path],
          outdir,
          format: "esm",
          plugins: [createTypiaBunPlugin()],
          sourcemap: "inline",
          target: "bun",
        }));

      if (!result.success) {
        throw new Error([
          `Failed to compile procedure module: ${path}`,
          ...formatBuildLogs(result.logs),
        ].join("\n"));
      }

      const output = result.outputs[0];
      if (!output) {
        throw new Error(`Procedure build produced no output for ${path}`);
      }

      mkdirSync(cacheDir, { recursive: true });
      copyFileSync(output.path, cacheModulePath);
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  }

  return `${pathToFileURL(cacheModulePath).href}?v=${cacheKey}`;
}

function formatBuildLogs(logs: unknown[]): string[] {
  return logs.map((log) => {
    if (typeof log === "string") {
      return log;
    }

    if (!log || typeof log !== "object") {
      return String(log);
    }

    const message = "message" in log && typeof log.message === "string"
      ? log.message
      : JSON.stringify(log);
    const position = "position" in log && log.position && typeof log.position === "object"
      ? log.position
      : undefined;
    const location = position && "file" in position && typeof position.file === "string"
      ? position.file
      : undefined;

    return location ? `${location}: ${message}` : message;
  });
}

function getProcedureBuildCacheDir(): string {
  return join(getProcedureRuntimeDir(), "procedure-builds");
}

function buildProcedureCacheKey(path: string, workspaceRoot: string): string {
  const hash = createHash("sha256");
  hash.update(`procedure-cache-version:${String(PROCEDURE_BUILD_CACHE_VERSION)}\n`);
  hash.update(`bun-version:${Bun.version}\n`);

  for (const sourceFile of resolveProcedureSourceGraph(path)) {
    hash.update(relative(workspaceRoot, sourceFile.path));
    hash.update("\n");
    hash.update(sourceFile.contents);
    hash.update("\n");
  }

  return hash.digest("hex").slice(0, 24);
}

function resolveProcedureSourceGraph(path: string): ProcedureSourceFile[] {
  const pending = [resolve(path)];
  const visited = new Set<string>();
  const sourceFiles: ProcedureSourceFile[] = [];

  while (pending.length > 0) {
    const currentPath = pending.pop();
    if (!currentPath || visited.has(currentPath)) {
      continue;
    }
    visited.add(currentPath);

    const contents = readFileSync(currentPath, "utf8");
    sourceFiles.push({ path: currentPath, contents });

    for (const specifier of findLocalImportSpecifiers(contents)) {
      const resolvedImportPath = resolveLocalImportPath(dirname(currentPath), specifier);
      if (!visited.has(resolvedImportPath)) {
        pending.push(resolvedImportPath);
      }
    }
  }

  sourceFiles.sort((left, right) => left.path.localeCompare(right.path));
  return sourceFiles;
}

function findLocalImportSpecifiers(source: string): string[] {
  const matches = new Set<string>();
  for (const pattern of LOCAL_IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]?.trim();
      if (specifier?.startsWith(".")) {
        matches.add(specifier);
      }
    }
  }
  return [...matches];
}

function resolveLocalImportPath(baseDir: string, specifier: string): string {
  const cleanSpecifier = specifier.split("?")[0]?.split("#")[0];
  if (!cleanSpecifier) {
    throw new Error(`Procedure local import was empty: ${specifier}`);
  }

  if (!cleanSpecifier.endsWith(".ts")) {
    throw new Error(`Procedure local imports must use explicit .ts paths: ${specifier}`);
  }

  const absolutePath = resolve(baseDir, cleanSpecifier);
  if (!existsSync(absolutePath) || lstatSync(absolutePath).isDirectory()) {
    throw new Error(`Procedure local import not found: ${specifier}`);
  }

  return absolutePath;
}

function listProcedureSourcePaths(rootDir: string): string[] {
  const files: string[] = [];
  walkProcedureSourcePaths(resolve(rootDir), files);
  return files;
}

function walkProcedureSourcePaths(dir: string, files: string[]): void {
  const entries = readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }

    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkProcedureSourcePaths(entryPath, files);
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }
}

function readProcedureMetadata(path: string): DeferredProcedureMetadata | undefined {
  const source = readFileSync(path, "utf8");
  if (!looksLikeProcedureModule(source)) {
    return undefined;
  }

  return {
    name: readStaticStringProperty(source, "name") ?? basename(path, ".ts"),
    description: readStaticStringProperty(source, "description") ?? `Lazy-loaded procedure from ${basename(path)}`,
    inputHint: readStaticStringProperty(source, "inputHint"),
    executionMode: parseExecutionMode(readStaticStringProperty(source, "executionMode")),
    supportsResume: looksLikeResumableProcedureModule(source),
  };
}

function looksLikeProcedureModule(source: string): boolean {
  return /\bexport\s+default\b/u.test(source)
    && (/\b(?:async\s+)?execute\s*\(/u.test(source) || /\bexecute\s*:/u.test(source));
}

function looksLikeResumableProcedureModule(source: string): boolean {
  return /\b(?:async\s+)?resume\s*\(/u.test(source) || /\bresume\s*:/u.test(source);
}

function parseExecutionMode(value: string | undefined): ProcedureExecutionMode | undefined {
  if (value === "defaultConversation" || value === "harness") {
    return value;
  }

  return undefined;
}

function readStaticStringProperty(source: string, propertyName: string): string | undefined {
  const patterns = [
    new RegExp(`\\b${escapeRegExp(propertyName)}\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "u"),
    new RegExp(`\\b${escapeRegExp(propertyName)}\\s*:\\s*'((?:\\\\.|[^'\\\\])*)'`, "u"),
    new RegExp(`\\b${escapeRegExp(propertyName)}\\s*:\\s*` + "`((?:\\\\.|[^`\\\\])*)`", "u"),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (match?.[1] !== undefined) {
      return decodeStringLiteral(match[1]);
    }
  }

  return undefined;
}

function decodeStringLiteral(value: string): string {
  return value.replace(/\\([\\'"`nrt])/g, (_, escaped: string) => {
    switch (escaped) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return escaped;
    }
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function withProcedureBuildNodeModules<T>(workspaceRoot: string, run: () => Promise<T>): Promise<T> {
  const nodeModulesPath = join(workspaceRoot, "node_modules");
  const srcPath = join(workspaceRoot, "src");
  const runtimeSourcePath = resolveProcedureBuildSourcePath();
  if (existsSync(nodeModulesPath)) {
    if (!existsSync(srcPath) && runtimeSourcePath) {
      return await withTemporarySymlink(srcPath, runtimeSourcePath, run);
    }
    return await run();
  }

  const runtimeNodeModulesPath = resolveProcedureBuildNodeModulesPath();
  return await withTemporarySymlink(nodeModulesPath, runtimeNodeModulesPath, async () => {
    if (!runtimeSourcePath || existsSync(srcPath)) {
      return await run();
    }
    return await withTemporarySymlink(srcPath, runtimeSourcePath, run);
  });
}

function resolveProcedureWorkspaceRoot(path: string, workspaceRoot?: string): string {
  if (workspaceRoot) {
    return resolve(workspaceRoot);
  }

  const fileDir = dirname(resolve(path));
  for (let current = fileDir; ; current = dirname(current)) {
    if (basename(current) === "packages") {
      return dirname(current);
    }

    if (basename(current) === "procedures") {
      return dirname(current);
    }

    const parent = dirname(current);
    if (parent === current) {
      return fileDir;
    }
  }
}

function resolveProcedureBuildNodeModulesPath(): string {
  const sourceNodeModulesPath = resolve(import.meta.dir, "..", "..", "node_modules");
  if (existsSync(sourceNodeModulesPath)) {
    return sourceNodeModulesPath;
  }

  const installedRuntimeNodeModulesPath = join(getProcedureRuntimeDir(), "node_modules");
  if (existsSync(installedRuntimeNodeModulesPath)) {
    return installedRuntimeNodeModulesPath;
  }

  throw new Error(
    `Procedure build runtime packages are not available. Expected ${installedRuntimeNodeModulesPath} or ${sourceNodeModulesPath}. Rebuild nanoboss to install its typia runtime packages.`,
  );
}

function resolveProcedureBuildSourcePath(): string | undefined {
  const sourcePath = resolve(import.meta.dir, "..", "..", "src");
  if (existsSync(sourcePath)) {
    return sourcePath;
  }

  const installedRuntimeSourcePath = join(getProcedureRuntimeDir(), "src");
  return existsSync(installedRuntimeSourcePath) ? installedRuntimeSourcePath : undefined;
}

function isSymlinkPath(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

async function withTemporarySymlink<T>(targetPath: string, sourcePath: string, run: () => Promise<T>): Promise<T> {
  let createdSymlink = false;

  try {
    symlinkSync(sourcePath, targetPath, "dir");
    createdSymlink = true;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
      throw error;
    }
  }

  try {
    return await run();
  } finally {
    if (createdSymlink && isSymlinkPath(targetPath)) {
      rmSync(targetPath, { recursive: true, force: true });
    }
  }
}

function resolveDiskProcedureWorkspaceRoot(procedureRoot: string): string {
  const resolvedProcedureRoot = resolve(procedureRoot);
  return basename(resolvedProcedureRoot) === "procedures"
    ? dirname(resolvedProcedureRoot)
    : resolvedProcedureRoot;
}

function resolvePersistProcedureRoot(params: {
  cwd?: string;
  fallbackProcedureRoot?: string;
  profileProcedureRoot: string;
}): string {
  const workingDir = params.cwd ? resolve(params.cwd) : undefined;
  const repoProcedureRoot = workingDir ? resolveRepoProcedureRoot(workingDir) : undefined;
  const procedureRoot = repoProcedureRoot
    ?? (workingDir ? params.profileProcedureRoot : params.fallbackProcedureRoot ?? params.profileProcedureRoot);

  return resolve(procedureRoot);
}

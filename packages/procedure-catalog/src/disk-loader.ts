import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  Procedure,
  ProcedureExecutionMode,
  ProcedureMetadata,
} from "@nanoboss/procedure-sdk";
import { resolveProcedureEntryRelativePath } from "./names.ts";
import { getProcedureRuntimeDir } from "./paths.ts";
import { createTypiaBunPlugin } from "./typia-bun-plugin.ts";

interface DiskProcedureDefinition extends ProcedureMetadata {
  continuation?: {
    supportsResume: true;
  };
  path: string;
}

interface LoadableProcedureMetadata extends ProcedureMetadata {
  continuation?: {
    supportsResume: true;
  };
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

  return listProcedureSourcePaths(procedureRoot)
    .map((path) => {
      const metadata = readProcedureMetadata(path);
      return metadata ? { ...metadata, path } : undefined;
    })
    .filter((definition): definition is DiskProcedureDefinition => definition !== undefined);
}

export async function loadProcedureFromPath(path: string): Promise<Procedure> {
  const moduleUrl = await buildProcedureModule(path);
  const loaded: unknown = await import(moduleUrl);
  const procedure = getDefaultExport(loaded);
  assertProcedure(procedure);
  return procedure;
}

export function persistProcedureSource(params: {
  procedureName: string;
  source: string;
  procedureRoot: string;
}): string {
  const filePath = join(resolve(params.procedureRoot), resolveProcedureEntryRelativePath(params.procedureName));
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

async function buildProcedureModule(path: string): Promise<string> {
  const resolvedWorkspaceRoot = resolveProcedureBuildRoot(path);
  return await withProcedureBuildNodeModules(resolvedWorkspaceRoot, async () => {
    const cacheKey = buildProcedureCacheKey(path, resolvedWorkspaceRoot);
    const cacheDir = join(getProcedureBuildCacheDir(), cacheKey);
    const cacheModulePath = join(cacheDir, "module.js");
    if (!existsSync(cacheModulePath)) {
      const outdir = mkdtempSync(join(tmpdir(), "nanoboss-procedure-"));
      try {
        let result: Awaited<ReturnType<typeof Bun.build>>;
        try {
          result = await Bun.build({
            entrypoints: [path],
            outdir,
            format: "esm",
            plugins: [createTypiaBunPlugin()],
            sourcemap: "inline",
            target: "bun",
          });
        } catch (error) {
          throw new Error(formatProcedureBuildFailure(path, extractBuildLogs(error)), { cause: error });
        }

        if (!result.success) {
          throw new Error(formatProcedureBuildFailure(path, result.logs), { cause: result });
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
  });
}

function formatProcedureBuildFailure(path: string, logs: readonly unknown[]): string {
  const diagnostics = formatBuildLogs(logs);
  return [
    `Failed to compile procedure module: ${path}`,
    diagnostics.length > 0
      ? diagnostics.join("\n")
      : "Bundle failed without diagnostics from Bun.build().",
  ].join("\n");
}

function extractBuildLogs(error: unknown): readonly unknown[] {
  if (
    error instanceof AggregateError
    && Array.isArray(error.errors)
  ) {
    return error.errors;
  }

  if (
    typeof error === "object"
    && error !== null
    && "errors" in error
    && Array.isArray((error as { errors?: unknown[] }).errors)
  ) {
    return (error as { errors: unknown[] }).errors;
  }

  return [];
}

function formatBuildLogs(logs: readonly unknown[]): string[] {
  return logs.map((log, index) => {
    if (typeof log === "string") {
      return `Build diagnostic ${index + 1}: ${log}`;
    }

    if (!log || typeof log !== "object") {
      return `Build diagnostic ${index + 1}: ${String(log)}`;
    }

    const message = "message" in log && typeof log.message === "string"
      ? log.message
      : JSON.stringify(log);
    const level = "level" in log && typeof log.level === "string"
      ? log.level
      : undefined;
    const code = "code" in log && typeof log.code === "string"
      ? log.code
      : undefined;
    const specifier = "specifier" in log && typeof log.specifier === "string"
      ? log.specifier
      : undefined;
    const importKind = "importKind" in log && typeof log.importKind === "string"
      ? log.importKind
      : undefined;
    const referrer = "referrer" in log && typeof log.referrer === "string" && log.referrer.trim().length > 0
      ? log.referrer
      : undefined;
    const position = "position" in log && log.position && typeof log.position === "object"
      ? log.position
      : undefined;
    const location = position && "file" in position && typeof position.file === "string"
      ? formatBuildLogLocation(position)
      : undefined;
    const sourceLine = position && "lineText" in position && typeof position.lineText === "string"
      ? position.lineText.trim()
      : undefined;

    const header = [
      `Build diagnostic ${index + 1}:`,
      level ? level : undefined,
      code ? `[${code}]` : undefined,
      location ? `at ${location}` : referrer ? `from ${referrer}` : undefined,
    ].filter((value): value is string => Boolean(value)).join(" ");
    const details = [
      message,
      specifier ? `specifier: ${specifier}` : undefined,
      importKind ? `import kind: ${importKind}` : undefined,
      sourceLine ? `source: ${sourceLine}` : undefined,
    ].filter((value): value is string => Boolean(value));

    return [header, ...details.map((line) => `  ${line}`)].join("\n");
  });
}

function formatBuildLogLocation(position: { file?: unknown; line?: unknown; column?: unknown }): string {
  const file = typeof position.file === "string" ? position.file : undefined;
  const line = typeof position.line === "number" && Number.isFinite(position.line) ? position.line : undefined;
  const column = typeof position.column === "number" && Number.isFinite(position.column) ? position.column : undefined;

  if (!file) {
    return "unknown location";
  }

  if (line !== undefined && column !== undefined) {
    return `${file}:${line}:${column}`;
  }

  if (line !== undefined) {
    return `${file}:${line}`;
  }

  return file;
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

  return realpathSync(absolutePath);
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

function readProcedureMetadata(path: string): LoadableProcedureMetadata | undefined {
  const source = readFileSync(path, "utf8");
  if (!looksLikeProcedureModule(source)) {
    return undefined;
  }

  return {
    name: readStaticStringProperty(source, "name") ?? basename(path, ".ts"),
    description: readStaticStringProperty(source, "description") ?? `Lazy-loaded procedure from ${basename(path)}`,
    inputHint: readStaticStringProperty(source, "inputHint"),
    executionMode: parseExecutionMode(readStaticStringProperty(source, "executionMode")),
    continuation: looksLikeResumableProcedureModule(source)
      ? { supportsResume: true }
      : undefined,
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
  if (value === "agentSession" || value === "harness") {
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
  const packagesPath = join(workspaceRoot, "packages");
  const runtimeSourcePath = resolveProcedureBuildSourcePath();
  const runtimePackagesPath = resolveProcedureBuildPackagesPath();
  const runtimeNodeModulesPaths = resolveProcedureBuildNodeModulesPaths();
  const workspacePackageSourcePaths = [packagesPath, runtimePackagesPath]
    .filter((path, index, array): path is string => Boolean(path) && array.indexOf(path) === index);

  return await withTemporaryNodeModulesOverlays(nodeModulesPath, runtimeNodeModulesPaths, async () =>
    await withTemporaryWorkspacePackageOverlays(nodeModulesPath, workspacePackageSourcePaths, async () =>
      await withOptionalTemporarySymlink(srcPath, runtimeSourcePath, async () =>
        await withOptionalTemporarySymlink(packagesPath, runtimePackagesPath, run)
      )
    )
  );
}

function resolveProcedureBuildRoot(path: string): string {
  const fileDir = dirname(resolve(path));

  for (let current = fileDir; ; current = dirname(current)) {
    const currentBaseName = basename(current);
    if (currentBaseName === "packages") {
      return dirname(current);
    }

    if (currentBaseName === "procedures") {
      const parent = dirname(current);
      return basename(parent) === ".nanoboss" ? dirname(parent) : parent;
    }

    if (existsSync(join(current, "tsconfig.json")) || existsSync(join(current, "node_modules"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return fileDir;
    }
  }
}

function resolveProcedureBuildNodeModulesPaths(): string[] {
  const sourceNodeModulesPath = resolveSourceCheckoutPath("node_modules");
  const installedRuntimeNodeModulesPath = join(getProcedureRuntimeDir(), "node_modules");
  const paths = [sourceNodeModulesPath, installedRuntimeNodeModulesPath]
    .filter((path, index, array) => existsSync(path) && array.indexOf(path) === index);

  if (paths.length > 0) {
    return paths;
  }

  throw new Error(
    `Procedure build runtime packages are not available. Expected ${installedRuntimeNodeModulesPath} or ${sourceNodeModulesPath}. Rebuild nanoboss to install its typia runtime packages.`,
  );
}

function resolveProcedureBuildSourcePath(): string | undefined {
  const sourcePath = resolveSourceCheckoutPath("src");
  if (existsSync(sourcePath)) {
    return sourcePath;
  }

  const installedRuntimeSourcePath = join(getProcedureRuntimeDir(), "src");
  return existsSync(installedRuntimeSourcePath) ? installedRuntimeSourcePath : undefined;
}

function resolveProcedureBuildPackagesPath(): string | undefined {
  const sourcePackagesPath = resolveSourceCheckoutPath("packages");
  if (existsSync(sourcePackagesPath)) {
    return sourcePackagesPath;
  }

  const installedRuntimePackagesPath = join(getProcedureRuntimeDir(), "packages");
  return existsSync(installedRuntimePackagesPath) ? installedRuntimePackagesPath : undefined;
}

function resolveSourceCheckoutPath(...segments: string[]): string {
  return resolve(import.meta.dir, "..", "..", "..", ...segments);
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

async function withTemporaryNodeModulesOverlays<T>(
  targetNodeModulesPath: string,
  sourceNodeModulesPaths: string[],
  run: () => Promise<T>,
): Promise<T> {
  let createdNodeModulesDir = false;
  if (!existsSync(targetNodeModulesPath)) {
    mkdirSync(targetNodeModulesPath, { recursive: true });
    createdNodeModulesDir = true;
  }

  const createdPaths = sourceNodeModulesPaths.flatMap((sourceNodeModulesPath) =>
    linkMissingNodeModulesEntries(targetNodeModulesPath, sourceNodeModulesPath)
  );

  try {
    return await run();
  } finally {
    for (const createdPath of createdPaths.reverse()) {
      if (existsSync(createdPath) && isSymlinkPath(createdPath)) {
        rmSync(createdPath, { recursive: true, force: true });
      }
    }

    if (createdNodeModulesDir && existsSync(targetNodeModulesPath)) {
      try {
        if (readdirSync(targetNodeModulesPath).length === 0) {
          rmSync(targetNodeModulesPath, { recursive: true, force: true });
        }
      } catch {
        // Ignore cleanup errors in the temporary overlay path.
      }
    }
  }
}

async function withTemporaryWorkspacePackageOverlays<T>(
  targetNodeModulesPath: string,
  sourcePackagesPaths: string[],
  run: () => Promise<T>,
): Promise<T> {
  const createdPaths = sourcePackagesPaths.flatMap((sourcePackagesPath) =>
    linkMissingWorkspacePackages(targetNodeModulesPath, sourcePackagesPath)
  );

  try {
    return await run();
  } finally {
    for (const createdPath of createdPaths.reverse()) {
      if (existsSync(createdPath) && isSymlinkPath(createdPath)) {
        rmSync(createdPath, { recursive: true, force: true });
      }
    }

    removeEmptyAncestorDirectories(targetNodeModulesPath, createdPaths);
  }
}

function linkMissingNodeModulesEntries(targetDir: string, sourceDir: string): string[] {
  if (!existsSync(sourceDir)) {
    return [];
  }

  const createdPaths: string[] = [];
  const entries = readdirSync(sourceDir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);

    if (entry.isDirectory() && entry.name.startsWith("@")) {
      if (!existsSync(targetPath)) {
        symlinkSync(sourcePath, targetPath, "dir");
        createdPaths.push(targetPath);
        continue;
      }

      if (!lstatSync(targetPath).isDirectory()) {
        continue;
      }

      createdPaths.push(...linkMissingNodeModulesEntries(targetPath, sourcePath));
      continue;
    }

    if (existsSync(targetPath)) {
      continue;
    }

    symlinkSync(sourcePath, targetPath, entry.isDirectory() ? "dir" : "file");
    createdPaths.push(targetPath);
  }

  return createdPaths;
}

function linkMissingWorkspacePackages(targetNodeModulesDir: string, sourcePackagesDir: string): string[] {
  if (!existsSync(sourcePackagesDir)) {
    return [];
  }

  const createdPaths: string[] = [];
  const entries = readdirSync(sourcePackagesDir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const sourcePackageDir = join(sourcePackagesDir, entry.name);
    const packageName = readWorkspacePackageName(sourcePackageDir);
    if (!packageName) {
      continue;
    }

    const targetPackageDir = join(targetNodeModulesDir, ...packageName.split("/"));
    if (existsSync(targetPackageDir)) {
      continue;
    }

    mkdirSync(dirname(targetPackageDir), { recursive: true });
    symlinkSync(sourcePackageDir, targetPackageDir, "dir");
    createdPaths.push(targetPackageDir);
  }

  return createdPaths;
}

function readWorkspacePackageName(packageDir: string): string | undefined {
  try {
    const packageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { name?: unknown };
    return typeof packageJson.name === "string" && packageJson.name.trim().length > 0
      ? packageJson.name.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function removeEmptyAncestorDirectories(targetNodeModulesPath: string, createdPaths: string[]): void {
  const candidateDirs = [...new Set(
    createdPaths
      .map((createdPath) => dirname(createdPath))
      .filter((dir) => dir !== targetNodeModulesPath)
      .sort((left, right) => right.length - left.length),
  )];

  for (const candidateDir of candidateDirs) {
    if (!existsSync(candidateDir) || isSymlinkPath(candidateDir)) {
      continue;
    }

    try {
      if (readdirSync(candidateDir).length === 0) {
        rmSync(candidateDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors in temporary package alias directories.
    }
  }
}

async function withOptionalTemporarySymlink<T>(
  targetPath: string,
  sourcePath: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!sourcePath || existsSync(targetPath)) {
    return await run();
  }

  return await withTemporarySymlink(targetPath, sourcePath, run);
}

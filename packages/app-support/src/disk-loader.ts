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
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { getNanobossRuntimeDir } from "./nanoboss-home.ts";
import { createTypiaBunPlugin } from "./typia-bun-plugin.ts";

const DISK_MODULE_BUILD_CACHE_VERSION = 1;
const LOCAL_IMPORT_PATTERNS = [
  /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["'`](\.[^"'`]+)["'`]/g,
  /\bimport\s*\(\s*["'`](\.[^"'`]+)["'`]\s*\)/g,
];

export interface DiskModuleSourceFile {
  path: string;
  contents: string;
}

export interface DiscoverDiskModulesParams<M> {
  root: string;
  readMetadata(params: { path: string; source: string }): M | undefined;
}

export interface DiscoveredDiskModule<M> {
  path: string;
  metadata: M;
}

export function discoverDiskModules<M>(
  params: DiscoverDiskModulesParams<M>,
): DiscoveredDiskModule<M>[] {
  if (!existsSync(params.root)) {
    return [];
  }

  return listDiskSourcePaths(params.root)
    .map((path): DiscoveredDiskModule<M> | undefined => {
      const source = readFileSync(path, "utf8");
      const metadata = params.readMetadata({ path, source });
      return metadata === undefined ? undefined : { path, metadata };
    })
    .filter((entry): entry is DiscoveredDiskModule<M> => entry !== undefined);
}

export interface LoadDiskModuleParams {
  path: string;
  /**
   * Sub-directory name under the shared ~/.nanoboss/runtime/ cache to use for
   * compiled module outputs. Different callers (e.g., procedures vs.
   * extensions) use distinct namespaces so caches do not interfere.
   */
  cacheNamespace: string;
  /**
   * Directory basenames that indicate a disk-module entry when walking up the
   * filesystem to find the workspace root used to locate node_modules. For
   * example, procedures pass `"procedures"` so that entries under
   * `<repo>/.nanoboss/procedures/**` resolve to `<repo>`.
   */
  entryDirHints?: readonly string[];
}

export async function loadDiskModule(params: LoadDiskModuleParams): Promise<unknown> {
  const moduleUrl = await buildDiskModule(params);
  return await import(moduleUrl);
}

export function getDiskModuleDefaultExport(module: unknown): unknown {
  if (!module || typeof module !== "object" || !("default" in module)) {
    return undefined;
  }
  return (module as { default: unknown }).default;
}

async function buildDiskModule(params: LoadDiskModuleParams): Promise<string> {
  const resolvedWorkspaceRoot = resolveDiskBuildRoot(params.path, params.entryDirHints ?? []);
  return await withDiskBuildNodeModules(resolvedWorkspaceRoot, async () => {
    const cacheKey = buildDiskModuleCacheKey(params.path, resolvedWorkspaceRoot);
    const cacheDir = join(getDiskModuleBuildCacheDir(params.cacheNamespace), cacheKey);
    const cacheModulePath = join(cacheDir, "module.js");
    if (!existsSync(cacheModulePath)) {
      const outdir = mkdtempSync(join(tmpdir(), "nanoboss-disk-module-"));
      try {
        let result: Awaited<ReturnType<typeof Bun.build>>;
        try {
          result = await Bun.build({
            entrypoints: [params.path],
            outdir,
            format: "esm",
            plugins: [createTypiaBunPlugin()],
            sourcemap: "inline",
            target: "bun",
          });
        } catch (error) {
          throw new Error(formatDiskBuildFailure(params.path, extractBuildLogs(error)), { cause: error });
        }

        if (!result.success) {
          throw new Error(formatDiskBuildFailure(params.path, result.logs), { cause: result });
        }

        const output = result.outputs[0];
        if (!output) {
          throw new Error(`Disk module build produced no output for ${params.path}`);
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

function formatDiskBuildFailure(path: string, logs: readonly unknown[]): string {
  const diagnostics = formatBuildLogs(logs);
  return [
    `Failed to compile disk module: ${path}`,
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

function getDiskModuleBuildCacheDir(cacheNamespace: string): string {
  return join(getNanobossRuntimeDir(), cacheNamespace);
}

function buildDiskModuleCacheKey(path: string, workspaceRoot: string): string {
  const hash = createHash("sha256");
  hash.update(`disk-module-cache-version:${String(DISK_MODULE_BUILD_CACHE_VERSION)}\n`);
  hash.update(`bun-version:${Bun.version}\n`);

  for (const sourceFile of resolveDiskModuleSourceGraph(path)) {
    hash.update(relative(workspaceRoot, sourceFile.path));
    hash.update("\n");
    hash.update(sourceFile.contents);
    hash.update("\n");
  }

  return hash.digest("hex").slice(0, 24);
}

function resolveDiskModuleSourceGraph(path: string): DiskModuleSourceFile[] {
  const pending = [resolve(path)];
  const visited = new Set<string>();
  const sourceFiles: DiskModuleSourceFile[] = [];

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
    throw new Error(`Disk module local import was empty: ${specifier}`);
  }

  if (!cleanSpecifier.endsWith(".ts")) {
    throw new Error(`Disk module local imports must use explicit .ts paths: ${specifier}`);
  }

  const absolutePath = resolve(baseDir, cleanSpecifier);
  if (!existsSync(absolutePath) || lstatSync(absolutePath).isDirectory()) {
    throw new Error(`Disk module local import not found: ${specifier}`);
  }

  return realpathSync(absolutePath);
}

function listDiskSourcePaths(rootDir: string): string[] {
  const files: string[] = [];
  walkDiskSourcePaths(resolve(rootDir), files);
  return files;
}

function walkDiskSourcePaths(dir: string, files: string[]): void {
  const entries = readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }

    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDiskSourcePaths(entryPath, files);
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }
}

async function withDiskBuildNodeModules<T>(workspaceRoot: string, run: () => Promise<T>): Promise<T> {
  const nodeModulesPath = join(workspaceRoot, "node_modules");
  const srcPath = join(workspaceRoot, "src");
  const packagesPath = join(workspaceRoot, "packages");
  const runtimeSourcePath = resolveDiskBuildSourcePath();
  const runtimePackagesPath = resolveDiskBuildPackagesPath();
  const runtimeNodeModulesPaths = resolveDiskBuildNodeModulesPaths();
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

function resolveDiskBuildRoot(path: string, entryDirHints: readonly string[]): string {
  const fileDir = dirname(resolve(path));

  for (let current = fileDir; ; current = dirname(current)) {
    const currentBaseName = basename(current);
    if (currentBaseName === "packages") {
      return dirname(current);
    }

    if (entryDirHints.includes(currentBaseName)) {
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

function resolveDiskBuildNodeModulesPaths(): string[] {
  const sourceNodeModulesPath = resolveSourceCheckoutPath("node_modules");
  const installedRuntimeNodeModulesPath = join(getNanobossRuntimeDir(), "node_modules");
  const paths = [sourceNodeModulesPath, installedRuntimeNodeModulesPath]
    .filter((path, index, array) => existsSync(path) && array.indexOf(path) === index);

  if (paths.length > 0) {
    return paths;
  }

  throw new Error(
    `Disk module build runtime packages are not available. Expected ${installedRuntimeNodeModulesPath} or ${sourceNodeModulesPath}. Rebuild nanoboss to install its typia runtime packages.`,
  );
}

function resolveDiskBuildSourcePath(): string | undefined {
  const sourcePath = resolveSourceCheckoutPath("src");
  if (existsSync(sourcePath)) {
    return sourcePath;
  }

  const installedRuntimeSourcePath = join(getNanobossRuntimeDir(), "src");
  return existsSync(installedRuntimeSourcePath) ? installedRuntimeSourcePath : undefined;
}

function resolveDiskBuildPackagesPath(): string | undefined {
  const sourcePackagesPath = resolveSourceCheckoutPath("packages");
  if (existsSync(sourcePackagesPath)) {
    return sourcePackagesPath;
  }

  const installedRuntimePackagesPath = join(getNanobossRuntimeDir(), "packages");
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
      if (!existsSync(createdPath)) {
        continue;
      }

      if (isSymlinkPath(createdPath)) {
        rmSync(createdPath, { recursive: true, force: true });
        continue;
      }

      try {
        if (lstatSync(createdPath).isDirectory() && readdirSync(createdPath).length === 0) {
          rmSync(createdPath, { recursive: true, force: true });
        }
      } catch {
        // Ignore cleanup errors in the temporary overlay path.
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
      if (existsSync(targetPath) && !lstatSync(targetPath).isDirectory()) {
        continue;
      }

      if (!existsSync(targetPath)) {
        mkdirSync(targetPath, { recursive: true });
        createdPaths.push(targetPath);
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

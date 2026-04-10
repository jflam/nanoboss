import type * as acp from "@agentclientprotocol/sdk";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import autoresearchProcedure from "../../procedures/autoresearch/index.ts";
import autoresearchContinueProcedure from "../../procedures/autoresearch/continue.ts";
import autoresearchClearProcedure from "../../procedures/autoresearch/clear.ts";
import autoresearchFinalizeProcedure from "../../procedures/autoresearch/finalize.ts";
import autoresearchStartProcedure from "../../procedures/autoresearch/start.ts";
import autoresearchStatusProcedure from "../../procedures/autoresearch/status.ts";
import defaultProcedure from "../../procedures/default.ts";
import kbAnswerProcedure from "../../procedures/kb/answer.ts";
import kbCompileConceptsProcedure from "../../procedures/kb/compile-concepts.ts";
import kbCompileSourceProcedure from "../../procedures/kb/compile-source.ts";
import kbHealthProcedure from "../../procedures/kb/health.ts";
import kbIngestProcedure from "../../procedures/kb/ingest.ts";
import kbLinkProcedure from "../../procedures/kb/link.ts";
import kbRenderProcedure from "../../procedures/kb/render.ts";
import kbRefreshProcedure from "../../procedures/kb/refresh.ts";
import linterProcedure from "../../procedures/linter.ts";
import modelProcedure from "../../procedures/model.ts";
import nanobossCommitProcedure from "../../procedures/nanoboss/commit.ts";
import nanobossPreCommitChecksProcedure from "../../procedures/nanoboss/pre-commit-checks.ts";
import secondOpinionProcedure from "../../procedures/second-opinion.ts";
import simplifyProcedure from "../../procedures/simplify.ts";
import simplify2Procedure from "../../procedures/simplify2.ts";
import tokensProcedure from "../../procedures/tokens.ts";

import { getProcedureRuntimeDir } from "../core/config.ts";
import { resolveProfileProcedureRoot, resolveRepoProcedureRoot, resolveWorkspaceProcedureRoot } from "../core/procedure-paths.ts";
import { CREATE_PROCEDURE_METADATA, createCreateProcedure } from "./create.ts";
import { resolveProcedureEntryRelativePath } from "./names.ts";
import type { Procedure, ProcedureRegistryLike } from "../core/types.ts";
import { createTypiaBunPlugin } from "./typia-bun-plugin.ts";

interface ProcedureRegistryOptions {
  workspaceDir?: string;
  localProcedureRoot?: string;
  profileProcedureRoot?: string;
  diskProcedureRoots?: string[];
}

interface ProcedureDescriptor {
  name: string;
  description: string;
  inputHint?: string;
  executionMode?: "defaultConversation" | "harness";
  supportsResume?: boolean;
  load: () => Procedure | Promise<Procedure>;
}

interface DeferredProcedureEntry {
  descriptor: ProcedureDescriptor;
  loadPromise?: Promise<Procedure>;
}

type BuiltinProcedureSource = Omit<ProcedureDescriptor, "load"> & {
  load: (registry: ProcedureRegistry) => Procedure | Promise<Procedure>;
};

interface ProcedureSourceFile {
  path: string;
  contents: string;
}

const PROCEDURE_BUILD_CACHE_VERSION = 1;
const LOCAL_IMPORT_PATTERNS = [
  /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["'`](\.[^"'`]+)["'`]/g,
  /\bimport\s*\(\s*["'`](\.[^"'`]+)["'`]\s*\)/g,
];
const PROCEDURE_SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
];
const BUILTIN_PROCEDURE_SOURCES: BuiltinProcedureSource[] = [
  ...[
    defaultProcedure,
    autoresearchProcedure,
    autoresearchStartProcedure,
    autoresearchContinueProcedure,
    autoresearchStatusProcedure,
    autoresearchClearProcedure,
    autoresearchFinalizeProcedure,
    kbIngestProcedure,
    kbCompileSourceProcedure,
    kbCompileConceptsProcedure,
    kbLinkProcedure,
    kbRenderProcedure,
    kbHealthProcedure,
    kbRefreshProcedure,
    kbAnswerProcedure,
    linterProcedure,
    modelProcedure,
    nanobossPreCommitChecksProcedure,
    nanobossCommitProcedure,
    simplifyProcedure,
    simplify2Procedure,
    tokensProcedure,
    secondOpinionProcedure,
  ].map((procedure) => ({
    ...describeProcedure(procedure),
    load: () => procedure,
  })),
  {
    ...CREATE_PROCEDURE_METADATA,
    supportsResume: false,
    load: (registry) => createCreateProcedure(registry),
  },
];

export class ProcedureRegistry implements ProcedureRegistryLike {
  private readonly procedures = new Map<string, Procedure>();
  private readonly deferredProcedureEntries = new Map<string, DeferredProcedureEntry>();
  readonly localProcedureRoot?: string;
  readonly profileProcedureRoot: string;
  readonly diskProcedureRoots: string[];

  constructor(optionsOrProcedureRoot: string | ProcedureRegistryOptions = {}) {
    if (typeof optionsOrProcedureRoot === "string") {
      const resolvedProcedureRoot = resolve(optionsOrProcedureRoot);
      this.localProcedureRoot = resolvedProcedureRoot;
      this.profileProcedureRoot = resolveProfileProcedureRoot();
      this.diskProcedureRoots = uniquePaths([resolvedProcedureRoot]);
      return;
    }

    const workspaceDir = resolve(optionsOrProcedureRoot.workspaceDir ?? process.cwd());
    const localProcedureRoot = optionsOrProcedureRoot.localProcedureRoot ?? resolveWorkspaceProcedureRoot(workspaceDir);
    const profileProcedureRoot = optionsOrProcedureRoot.profileProcedureRoot ?? resolveProfileProcedureRoot();

    this.localProcedureRoot = localProcedureRoot ? resolve(localProcedureRoot) : undefined;
    this.profileProcedureRoot = resolve(profileProcedureRoot);
    this.diskProcedureRoots = uniquePaths(
      optionsOrProcedureRoot.diskProcedureRoots ?? [
        ...(this.localProcedureRoot ? [this.localProcedureRoot] : []),
        this.profileProcedureRoot,
      ],
    );
  }

  get(name: string): Procedure | undefined {
    return this.procedures.get(name);
  }

  list(): Procedure[] {
    return [...this.procedures.values()];
  }

  register(procedure: Procedure): void {
    this.assertProcedure(procedure);
    this.deferredProcedureEntries.delete(procedure.name);
    this.procedures.set(procedure.name, procedure);
  }

  loadBuiltins(): void {
    for (const descriptor of createBuiltinProcedureDescriptors(this)) {
      this.registerDescriptor(descriptor);
    }
  }

  async loadFromDisk(): Promise<void> {
    for (const procedureRoot of this.diskProcedureRoots) {
      if (!existsSync(procedureRoot)) {
        continue;
      }

      const workspaceRoot = resolveDiskProcedureWorkspaceRoot(procedureRoot);
      for (const filePath of listProcedureSourcePaths(procedureRoot)) {
        const descriptor = readProcedureDescriptor(
          filePath,
          () => this.loadProcedureFromPath(filePath, workspaceRoot),
        );
        if (descriptor) {
          this.registerDescriptor(descriptor);
        }
      }
    }
  }

  async loadProcedureFromPath(path: string, workspaceRoot?: string): Promise<Procedure> {
    const moduleUrl = await this.buildProcedureModule(path, workspaceRoot);
    const loaded: unknown = await import(moduleUrl);
    const procedure = getDefaultExport(loaded);
    this.assertProcedure(procedure);
    return procedure;
  }

  async persist(procedure: Procedure, source: string, cwd?: string): Promise<string> {
    const procedureRoot = resolvePersistProcedureRoot({
      cwd,
      fallbackProcedureRoot: this.localProcedureRoot,
      profileProcedureRoot: this.profileProcedureRoot,
    });

    const filePath = join(procedureRoot, resolveProcedureEntryRelativePath(procedure.name));
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, source, "utf8");
    return filePath;
  }

  private async buildProcedureModule(path: string, workspaceRoot?: string): Promise<string> {
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

  toAvailableCommands(): acp.AvailableCommand[] {
    return this.list()
      .filter((procedure) => procedure.name !== "default")
      .map((procedure) => ({
        name: procedure.name,
        description: procedure.description,
        input: procedure.inputHint
          ? {
              hint: procedure.inputHint,
            }
          : undefined,
      }));
  }

  private assertProcedure(procedure: unknown): asserts procedure is Procedure {
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

  private registerDescriptor(descriptor: ProcedureDescriptor): void {
    if (this.procedures.has(descriptor.name)) {
      return;
    }

    const entry: DeferredProcedureEntry = {
      descriptor,
    };
    this.deferredProcedureEntries.set(descriptor.name, entry);
    this.procedures.set(descriptor.name, this.createDeferredProcedure(entry));
  }

  private createDeferredProcedure(entry: DeferredProcedureEntry): Procedure {
    const procedure: Procedure = {
      name: entry.descriptor.name,
      description: entry.descriptor.description,
      inputHint: entry.descriptor.inputHint,
      executionMode: entry.descriptor.executionMode,
      execute: async (prompt, ctx) => {
        const loaded = await this.ensureProcedureLoaded(entry.descriptor.name);
        return await loaded.execute(prompt, ctx);
      },
    };

    if (entry.descriptor.supportsResume) {
      procedure.resume = async (prompt, state, ctx) => {
        const loaded = await this.ensureProcedureLoaded(entry.descriptor.name);
        if (!loaded.resume) {
          throw new Error(`Procedure /${loaded.name} does not support continuation.`);
        }
        return await loaded.resume(prompt, state, ctx);
      };
    }

    return procedure;
  }

  private async ensureProcedureLoaded(name: string): Promise<Procedure> {
    const entry = this.deferredProcedureEntries.get(name);
    if (!entry) {
      const procedure = this.procedures.get(name);
      if (!procedure) {
        throw new Error(`Unknown procedure: ${name}`);
      }
      return procedure;
    }

    if (!entry.loadPromise) {
      entry.loadPromise = Promise.resolve(entry.descriptor.load())
        .then((procedure) => {
          this.assertProcedure(procedure);
          return procedure;
        })
        .then((procedure) => {
          this.deferredProcedureEntries.delete(name);
          this.procedures.set(name, procedure);
          return procedure;
        })
        .catch((error: unknown) => {
          entry.loadPromise = undefined;
          throw error;
        });
    }

    return await entry.loadPromise;
  }
}

function getDefaultExport(module: unknown): unknown {
  if (!module || typeof module !== "object" || !("default" in module)) {
    return undefined;
  }

  return module.default;
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

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
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
      if (resolvedImportPath && !visited.has(resolvedImportPath)) {
        pending.push(resolvedImportPath);
      }
    }
  }

  sourceFiles.sort((left, right) => left.path.localeCompare(right.path));
  return sourceFiles;
}

function createBuiltinProcedureDescriptors(registry: ProcedureRegistry): ProcedureDescriptor[] {
  return BUILTIN_PROCEDURE_SOURCES.map(({ load, ...descriptor }) => ({
    ...descriptor,
    load: () => load(registry),
  }));
}

function listProcedureSourcePaths(rootDir: string): string[] {
  const files: string[] = [];
  walkProcedureSourcePaths(resolve(rootDir), files);
  return files;
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

function resolveLocalImportPath(baseDir: string, specifier: string): string | undefined {
  const cleanSpecifier = specifier.split("?")[0]?.split("#")[0];
  if (!cleanSpecifier) {
    return undefined;
  }

  const absoluteBase = resolve(baseDir, cleanSpecifier);
  const candidates = new Set<string>([
    absoluteBase,
    ...PROCEDURE_SOURCE_EXTENSIONS.map((extension) => `${absoluteBase}${extension}`),
    ...PROCEDURE_SOURCE_EXTENSIONS.map((extension) => join(absoluteBase, `index${extension}`)),
  ]);

  for (const candidate of candidates) {
    if (existsSync(candidate) && !lstatSync(candidate).isDirectory()) {
      return resolve(candidate);
    }
  }

  return undefined;
}

function readProcedureDescriptor(path: string, load: () => Promise<Procedure>): ProcedureDescriptor | undefined {
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
    load,
  };
}

function looksLikeProcedureModule(source: string): boolean {
  return /\bexport\s+default\b/u.test(source)
    && (/\b(?:async\s+)?execute\s*\(/u.test(source) || /\bexecute\s*:/u.test(source));
}

function looksLikeResumableProcedureModule(source: string): boolean {
  return /\b(?:async\s+)?resume\s*\(/u.test(source) || /\bresume\s*:/u.test(source);
}

function describeProcedure(procedure: Procedure): Omit<ProcedureDescriptor, "load"> {
  return {
    name: procedure.name,
    description: procedure.description,
    inputHint: procedure.inputHint,
    executionMode: procedure.executionMode,
    supportsResume: typeof procedure.resume === "function",
  };
}

function readStaticStringProperty(source: string, propertyName: string): string | undefined {
  const patterns = [
    new RegExp(`\\b${escapeRegExp(propertyName)}\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "u"),
    new RegExp(`\\b${escapeRegExp(propertyName)}\\s*:\\s*'((?:\\\\.|[^'\\\\])*)'`, "u"),
    new RegExp(`\\b${escapeRegExp(propertyName)}\\s*:\\s*\`((?:\\\\.|[^\`\\\\])*)\``, "u"),
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

function parseExecutionMode(value: string | undefined): Procedure["executionMode"] | undefined {
  return value === "defaultConversation" || value === "harness" ? value : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

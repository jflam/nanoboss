import type * as acp from "@agentclientprotocol/sdk";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import autoresearchProcedure from "../../commands/autoresearch.ts";
import autoresearchClearProcedure from "../../commands/autoresearch-clear.ts";
import autoresearchFinalizeProcedure from "../../commands/autoresearch-finalize.ts";
import autoresearchLoopProcedure from "../../commands/autoresearch-loop.ts";
import autoresearchStopProcedure from "../../commands/autoresearch-stop.ts";
import commitProcedure from "../../commands/commit.ts";
import defaultProcedure from "../../commands/default.ts";
import kbAnswerProcedure from "../../commands/kb-answer.ts";
import kbCompileConceptsProcedure from "../../commands/kb-compile-concepts.ts";
import kbCompileSourceProcedure from "../../commands/kb-compile-source.ts";
import kbHealthProcedure from "../../commands/kb-health.ts";
import kbIngestProcedure from "../../commands/kb-ingest.ts";
import kbLinkProcedure from "../../commands/kb-link.ts";
import kbRenderProcedure from "../../commands/kb-render.ts";
import kbRefreshProcedure from "../../commands/kb-refresh.ts";
import linterProcedure from "../../commands/linter.ts";
import modelProcedure from "../../commands/model.ts";
import secondOpinionProcedure from "../../commands/second-opinion.ts";
import tokensProcedure from "../../commands/tokens.ts";

import { getNanobossHome, getProcedureRuntimeDir } from "../core/config.ts";
import { createCreateProcedure } from "./create.ts";
import { sessionToolProcedures } from "../mcp/session-tool-procedures.ts";
import type { Procedure, ProcedureRegistryLike } from "../core/types.ts";
import { createTypiaBunPlugin } from "./typia-bun-plugin.ts";

interface ProcedureRegistryOptions {
  commandsDir?: string;
  profileCommandsDir?: string;
  diskCommandDirs?: string[];
}

interface ProcedureManifest {
  name: string;
  description: string;
  inputHint?: string;
  executionMode?: "defaultConversation" | "harness";
}

interface DiskProcedureEntry {
  path: string;
  manifest: ProcedureManifest;
  loadPromise?: Promise<Procedure>;
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

export class ProcedureRegistry implements ProcedureRegistryLike {
  private readonly procedures = new Map<string, Procedure>();
  private readonly diskProcedureEntries = new Map<string, DiskProcedureEntry>();
  readonly commandsDir: string;
  readonly profileCommandsDir: string;
  readonly diskCommandDirs: string[];

  constructor(optionsOrCommandsDir: string | ProcedureRegistryOptions = {}) {
    if (typeof optionsOrCommandsDir === "string") {
      this.commandsDir = optionsOrCommandsDir;
      this.profileCommandsDir = join(getNanobossHome(), "commands");
      this.diskCommandDirs = uniquePaths([optionsOrCommandsDir]);
      return;
    }

    const repoCommandsDir = optionsOrCommandsDir.commandsDir ?? resolve(process.cwd(), "commands");
    const profileCommandsDir = optionsOrCommandsDir.profileCommandsDir ?? join(getNanobossHome(), "commands");

    this.commandsDir = repoCommandsDir;
    this.profileCommandsDir = profileCommandsDir;
    this.diskCommandDirs = uniquePaths(optionsOrCommandsDir.diskCommandDirs ?? [repoCommandsDir, profileCommandsDir]);
  }

  get(name: string): Procedure | undefined {
    return this.procedures.get(name);
  }

  list(): Procedure[] {
    return [...this.procedures.values()];
  }

  register(procedure: Procedure): void {
    this.assertProcedure(procedure);
    this.diskProcedureEntries.delete(procedure.name);
    this.procedures.set(procedure.name, procedure);
  }

  loadBuiltins(): void {
    this.register(defaultProcedure);
    this.register(createCreateProcedure(this));
    this.register(autoresearchProcedure);
    this.register(autoresearchLoopProcedure);
    this.register(autoresearchStopProcedure);
    this.register(autoresearchClearProcedure);
    this.register(autoresearchFinalizeProcedure);
    this.register(commitProcedure);
    this.register(kbIngestProcedure);
    this.register(kbCompileSourceProcedure);
    this.register(kbCompileConceptsProcedure);
    this.register(kbLinkProcedure);
    this.register(kbRenderProcedure);
    this.register(kbHealthProcedure);
    this.register(kbRefreshProcedure);
    this.register(kbAnswerProcedure);
    this.register(linterProcedure);
    this.register(modelProcedure);
    this.register(tokensProcedure);
    this.register(secondOpinionProcedure);
    for (const procedure of sessionToolProcedures) {
      this.register(procedure);
    }
  }

  async loadFromDisk(): Promise<void> {
    for (const commandsDir of this.diskCommandDirs) {
      if (!existsSync(commandsDir)) {
        continue;
      }

      const files = readdirSync(commandsDir)
        .filter((entry) => entry.endsWith(".ts"))
        .sort();

      for (const file of files) {
        const fileStem = file.replace(/\.ts$/, "");
        if (this.procedures.has(fileStem)) {
          continue;
        }

        this.registerDiskProcedure(join(commandsDir, file));
      }
    }
  }

  async loadProcedureFromPath(path: string): Promise<Procedure> {
    const moduleUrl = await this.buildProcedureModule(path);
    const loaded: unknown = await import(moduleUrl);
    const procedure = getDefaultExport(loaded);
    this.assertProcedure(procedure);
    return procedure;
  }

  async persist(procedure: Procedure, source: string, cwd?: string): Promise<string> {
    const commandsDir = resolvePersistCommandsDir({
      cwd,
      fallbackCommandsDir: this.commandsDir,
      profileCommandsDir: this.profileCommandsDir,
    });

    mkdirSync(commandsDir, { recursive: true });
    const filePath = join(commandsDir, `${procedure.name}.ts`);
    writeFileSync(filePath, source, "utf8");
    return filePath;
  }

  private async buildProcedureModule(path: string): Promise<string> {
    const cacheKey = buildProcedureCacheKey(path);
    const cacheDir = join(getProcedureBuildCacheDir(), cacheKey);
    const cacheModulePath = join(cacheDir, "module.js");
    if (!existsSync(cacheModulePath)) {
      const outdir = mkdtempSync(join(tmpdir(), "nanoboss-procedure-"));
      try {
        const result = await withProcedureBuildNodeModules(path, async () =>
          await Bun.build({
            entrypoints: [path],
            outdir,
            format: "esm",
            plugins: [createTypiaBunPlugin()],
            sourcemap: "inline",
            target: "bun",
            autoloadBunfig: false,
            autoloadTsconfig: false,
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

  private registerDiskProcedure(path: string): void {
    const manifest = readProcedureManifest(path);
    if (this.procedures.has(manifest.name)) {
      return;
    }

    const entry: DiskProcedureEntry = {
      path,
      manifest,
    };
    this.diskProcedureEntries.set(manifest.name, entry);
    this.procedures.set(manifest.name, this.createLazyProcedure(entry));
  }

  private createLazyProcedure(entry: DiskProcedureEntry): Procedure {
    return {
      name: entry.manifest.name,
      description: entry.manifest.description,
      inputHint: entry.manifest.inputHint,
      executionMode: entry.manifest.executionMode,
      execute: async (prompt, ctx) => {
        const loaded = await this.ensureDiskProcedureLoaded(entry.manifest.name);
        return await loaded.execute(prompt, ctx);
      },
    };
  }

  private async ensureDiskProcedureLoaded(name: string): Promise<Procedure> {
    const entry = this.diskProcedureEntries.get(name);
    if (!entry) {
      const procedure = this.procedures.get(name);
      if (!procedure) {
        throw new Error(`Unknown procedure: ${name}`);
      }
      return procedure;
    }

    if (!entry.loadPromise) {
      entry.loadPromise = this.loadProcedureFromPath(entry.path)
        .then((procedure) => {
          this.diskProcedureEntries.delete(name);
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

function buildProcedureCacheKey(path: string): string {
  const workspaceRoot = resolveProcedureWorkspaceRoot(path);
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

function readProcedureManifest(path: string): ProcedureManifest {
  const source = readFileSync(path, "utf8");
  const name = readStaticStringProperty(source, "name") ?? basename(path, ".ts");
  const description = readStaticStringProperty(source, "description") ?? `Lazy-loaded procedure from ${basename(path)}`;
  const inputHint = readStaticStringProperty(source, "inputHint");
  const executionMode = parseExecutionMode(readStaticStringProperty(source, "executionMode"));

  return {
    name,
    description,
    inputHint,
    executionMode,
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

async function withProcedureBuildNodeModules<T>(path: string, run: () => Promise<T>): Promise<T> {
  const workspaceRoot = resolveProcedureWorkspaceRoot(path);
  const nodeModulesPath = join(workspaceRoot, "node_modules");
  if (existsSync(nodeModulesPath)) {
    return await run();
  }

  const runtimeNodeModulesPath = resolveProcedureBuildNodeModulesPath();
  let createdSymlink = false;

  try {
    symlinkSync(runtimeNodeModulesPath, nodeModulesPath, "dir");
    createdSymlink = true;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
      throw error;
    }
  }

  try {
    return await run();
  } finally {
    if (createdSymlink && isSymlinkPath(nodeModulesPath)) {
      rmSync(nodeModulesPath, { recursive: true, force: true });
    }
  }
}

function resolveProcedureWorkspaceRoot(path: string): string {
  const fileDir = dirname(resolve(path));
  return basename(fileDir) === "commands"
    ? dirname(fileDir)
    : fileDir;
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

function isSymlinkPath(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function resolvePersistCommandsDir(params: {
  cwd?: string;
  fallbackCommandsDir: string;
  profileCommandsDir: string;
}): string {
  const workingDir = params.cwd ? resolve(params.cwd) : undefined;
  if (workingDir && isNanobossRepoRoot(workingDir)) {
    return join(workingDir, "commands");
  }

  return resolve(params.profileCommandsDir || params.fallbackCommandsDir);
}

function isNanobossRepoRoot(cwd: string): boolean {
  const packageJsonPath = join(cwd, "package.json");
  const commandsDir = join(cwd, "commands");
  const nanobossEntrypoint = join(cwd, "nanoboss.ts");

  if (!existsSync(packageJsonPath) || !existsSync(commandsDir) || !existsSync(nanobossEntrypoint)) {
    return false;
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: unknown;
      module?: unknown;
    };
    return packageJson.name === "nanoboss" && packageJson.module === "nanoboss.ts";
  } catch {
    return false;
  }
}

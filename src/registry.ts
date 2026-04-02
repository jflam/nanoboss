import type * as acp from "@agentclientprotocol/sdk";
import UnpluginTypia from "@ryoppippi/unplugin-typia/bun";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import commitProcedure from "../commands/commit.ts";
import defaultProcedure from "../commands/default.ts";
import linterProcedure from "../commands/linter.ts";
import modelProcedure from "../commands/model.ts";
import secondOpinionProcedure from "../commands/second-opinion.ts";
import tokensProcedure from "../commands/tokens.ts";

import { getNanobossHome } from "./config.ts";
import { createCreateProcedure } from "./create.ts";
import type { Procedure, ProcedureRegistryLike } from "./types.ts";

interface ProcedureRegistryOptions {
  commandsDir?: string;
  profileCommandsDir?: string;
  diskCommandDirs?: string[];
}

export class ProcedureRegistry implements ProcedureRegistryLike {
  private readonly procedures = new Map<string, Procedure>();
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
    this.procedures.set(procedure.name, procedure);
  }

  loadBuiltins(): void {
    this.register(defaultProcedure);
    this.register(createCreateProcedure(this));
    this.register(commitProcedure);
    this.register(linterProcedure);
    this.register(modelProcedure);
    this.register(tokensProcedure);
    this.register(secondOpinionProcedure);
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

        const procedure = await this.loadProcedureFromPath(join(commandsDir, file));
        this.register(procedure);
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
    const outdir = mkdtempSync(join(tmpdir(), "nanoboss-procedure-"));
    const result = await Bun.build({
      entrypoints: [path],
      outdir,
      format: "esm",
      plugins: [UnpluginTypia({ log: false })],
      sourcemap: "inline",
      target: "bun",
    });

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

    return `${pathToFileURL(output.path).href}?v=${Date.now()}`;
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

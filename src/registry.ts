import type * as acp from "@agentclientprotocol/sdk";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import commitProcedure from "../commands/commit.ts";
import linterProcedure from "../commands/linter.ts";
import secondOpinionProcedure from "../commands/second-opinion.ts";

import { createCreateProcedure } from "./create.ts";
import type { Procedure, ProcedureRegistryLike } from "./types.ts";

export class ProcedureRegistry implements ProcedureRegistryLike {
  private readonly procedures = new Map<string, Procedure>();
  readonly commandsDir: string;

  constructor(commandsDir = resolve(process.cwd(), "commands")) {
    this.commandsDir = commandsDir;
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
    this.register(createCreateProcedure(this));
    this.register(commitProcedure);
    this.register(linterProcedure);
    this.register(secondOpinionProcedure);
  }

  async loadFromDisk(): Promise<void> {
    mkdirSync(this.commandsDir, { recursive: true });
    const files = readdirSync(this.commandsDir)
      .filter((entry) => entry.endsWith(".ts"))
      .sort();

    for (const file of files) {
      const fileStem = file.replace(/\.ts$/, "");
      if (this.procedures.has(fileStem)) {
        continue;
      }

      const procedure = await this.loadProcedureFromPath(join(this.commandsDir, file));
      this.register(procedure);
    }
  }

  async loadProcedureFromPath(path: string): Promise<Procedure> {
    const moduleUrl = `${pathToFileURL(path).href}?v=${Date.now()}`;
    const loaded: unknown = await import(moduleUrl);
    const procedure = getDefaultExport(loaded);
    this.assertProcedure(procedure);
    return procedure;
  }

  async persist(procedure: Procedure, source: string): Promise<string> {
    mkdirSync(this.commandsDir, { recursive: true });
    const filePath = join(this.commandsDir, `${procedure.name}.ts`);
    writeFileSync(filePath, source, "utf8");
    return filePath;
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

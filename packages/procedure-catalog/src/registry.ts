import { resolve } from "node:path";

import {
  resolvePersistProcedureRoot,
  resolveProfileProcedureRoot,
  resolveWorkspaceProcedureRoots,
} from "@nanoboss/app-support";
import {
  discoverDiskProcedures,
  loadProcedureFromPath as loadDiskProcedureFromPath,
  persistProcedureSource,
} from "./disk-loader.ts";
import { loadBuiltinProcedures } from "./builtins.ts";
import type {
  Procedure,
  ProcedureMetadata,
  ProcedureRegistryLike,
} from "@nanoboss/procedure-sdk";

interface ProcedureRegistryOptions {
  cwd?: string;
  procedureRoots?: string[];
  profileProcedureRoot?: string;
}

interface LoadableProcedureMetadata extends ProcedureMetadata {
  continuation?: {
    supportsResume: true;
  };
}

export class ProcedureRegistry implements ProcedureRegistryLike {
  private readonly procedures = new Map<string, Procedure>();
  private readonly procedureRoots: string[];
  private readonly profileProcedureRoot: string;

  constructor(options: ProcedureRegistryOptions = {}) {
    const cwd = resolve(options.cwd ?? process.cwd());
    this.profileProcedureRoot = resolve(options.profileProcedureRoot ?? resolveProfileProcedureRoot());
    this.procedureRoots = uniquePaths(
      options.procedureRoots ?? resolveWorkspaceProcedureRoots(cwd, this.profileProcedureRoot),
    );
  }

  get(name: string): Procedure | undefined {
    return this.procedures.get(name);
  }

  listMetadata(): ProcedureMetadata[] {
    return [...this.procedures.values()].map(toProcedureMetadata);
  }

  register(procedure: Procedure): void {
    this.assertProcedure(procedure);
    this.procedures.set(procedure.name, procedure);
  }

  loadBuiltins(): void {
    loadBuiltinProcedures(this);
  }

  async loadFromDisk(): Promise<void> {
    for (const procedureRoot of this.procedureRoots) {
      for (const { path, ...metadata } of discoverDiskProcedures(procedureRoot)) {
        this.registerLoadableProcedure(metadata, () => this.loadProcedureFromPath(path));
      }
    }
  }

  async loadProcedureFromPath(path: string): Promise<Procedure> {
    return await loadDiskProcedureFromPath(path);
  }

  async persist(procedureName: string, source: string, cwd: string): Promise<string> {
    return persistProcedureSource({
      procedureName,
      source,
      procedureRoot: resolvePersistProcedureRoot(cwd, this.profileProcedureRoot),
    });
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

  private registerLoadableProcedure(
    metadata: LoadableProcedureMetadata,
    load: () => Procedure | Promise<Procedure>,
  ): void {
    if (this.procedures.has(metadata.name)) {
      return;
    }

    let loadPromise: Promise<Procedure> | undefined;
    const ensureLoaded = async (): Promise<Procedure> => {
      if (!loadPromise) {
        loadPromise = Promise.resolve(load())
          .then((procedure) => {
            this.assertProcedure(procedure);
            if (procedure.name !== metadata.name) {
              throw new Error(
                `Procedure module loaded as /${procedure.name} but was discovered as /${metadata.name}`,
              );
            }
            this.procedures.set(metadata.name, procedure);
            return procedure;
          })
          .catch((error: unknown) => {
            loadPromise = undefined;
            throw error;
          });
      }

      return await loadPromise;
    };

    const procedure: Procedure = {
      name: metadata.name,
      description: metadata.description,
      inputHint: metadata.inputHint,
      executionMode: metadata.executionMode,
      execute: async (prompt, ctx) => {
        const loaded = await ensureLoaded();
        return await loaded.execute(prompt, ctx);
      },
    };

    if (metadata.continuation?.supportsResume) {
      procedure.resume = async (prompt, state, ctx) => {
        const loaded = await ensureLoaded();
        if (!loaded.resume) {
          throw new Error(`Procedure /${loaded.name} does not support continuation.`);
        }
        return await loaded.resume(prompt, state, ctx);
      };
    }

    this.procedures.set(metadata.name, procedure);
  }
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}

function toProcedureMetadata(procedure: Procedure | ProcedureMetadata): ProcedureMetadata {
  return {
    name: procedure.name,
    description: procedure.description,
    inputHint: procedure.inputHint,
    executionMode: procedure.executionMode,
  };
}

function toLoadableProcedureMetadata(procedure: Procedure): LoadableProcedureMetadata {
  return {
    ...toProcedureMetadata(procedure),
    continuation: typeof procedure.resume === "function"
      ? { supportsResume: true }
      : undefined,
  };
}

export function projectProcedureMetadata<T extends ProcedureMetadata>(
  procedures: readonly T[],
  options: { includeHidden?: boolean } = {},
): T[] {
  return options.includeHidden ? [...procedures] : procedures.filter((procedure) => procedure.name !== "default");
}

export function toAvailableCommand(metadata: ProcedureMetadata): {
  name: string;
  description: string;
  input?: { hint: string };
} {
  return {
    name: metadata.name,
    description: metadata.description,
    input: metadata.inputHint
      ? {
          hint: metadata.inputHint,
        }
      : undefined,
  };
}

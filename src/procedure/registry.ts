import { resolve } from "node:path";

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

import {
  resolvePersistProcedureRoot,
  resolveProfileProcedureRoot,
  resolveWorkspaceProcedureRoots,
} from "../core/procedure-paths.ts";
import { createCreateProcedure } from "./create.ts";
import {
  discoverDiskProcedures,
  loadProcedureFromPath as loadDiskProcedureFromPath,
  persistProcedureSource,
} from "./disk-loader.ts";
import type {
  DeferredProcedureMetadata,
  Procedure,
  ProcedureMetadata,
  ProcedureRegistryLike,
} from "../core/types.ts";

interface ProcedureRegistryOptions {
  cwd?: string;
  procedureRoots?: string[];
  profileProcedureRoot?: string;
}

const BUILTIN_PROCEDURES: Procedure[] = [
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
];

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

  listMetadata(): DeferredProcedureMetadata[] {
    return [...this.procedures.values()].map(toDeferredProcedureMetadata);
  }

  register(procedure: Procedure): void {
    this.assertProcedure(procedure);
    this.procedures.set(procedure.name, procedure);
  }

  loadBuiltins(): void {
    for (const procedure of BUILTIN_PROCEDURES) {
      this.assertProcedure(procedure);
      this.registerLoadableProcedure(toDeferredProcedureMetadata(procedure), () => procedure);
    }

    if (!this.procedures.has("create")) {
      const procedure = createCreateProcedure(this);
      this.assertProcedure(procedure);
      this.registerLoadableProcedure(toDeferredProcedureMetadata(procedure), () => procedure);
    }
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
    metadata: DeferredProcedureMetadata,
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

    if (metadata.supportsResume) {
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

function toDeferredProcedureMetadata(procedure: Procedure): DeferredProcedureMetadata {
  return {
    name: procedure.name,
    description: procedure.description,
    inputHint: procedure.inputHint,
    executionMode: procedure.executionMode,
    supportsResume: typeof procedure.resume === "function",
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

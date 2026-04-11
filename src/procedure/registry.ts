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

import { resolveProfileProcedureRoot, resolveWorkspaceProcedureRoot } from "../core/procedure-paths.ts";
import { CREATE_PROCEDURE_METADATA, createCreateProcedure } from "./create.ts";
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
  workspaceDir?: string;
  localProcedureRoot?: string;
  profileProcedureRoot?: string;
  diskProcedureRoots?: string[];
}

interface DeferredProcedureDefinition extends DeferredProcedureMetadata {
  load: () => Procedure | Promise<Procedure>;
}

interface DeferredProcedureEntry {
  definition: DeferredProcedureDefinition;
  loadPromise?: Promise<Procedure>;
}

type BuiltinProcedureSource = Omit<DeferredProcedureDefinition, "load"> & {
  load: (registry: ProcedureRegistry) => Procedure | Promise<Procedure>;
};

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
    ...describeDeferredProcedureMetadata(procedure),
    load: () => procedure,
  })),
  {
    ...CREATE_PROCEDURE_METADATA,
    supportsResume: false,
    load: (registry) => createCreateProcedure(registry),
  },
];

export class ProcedureRegistry implements ProcedureRegistryLike {
  private readonly metadataByName = new Map<string, ProcedureMetadata>();
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

  listMetadata(): ProcedureMetadata[] {
    return [...this.metadataByName.values()].map(copyProcedureMetadata);
  }

  register(procedure: Procedure): void {
    this.assertProcedure(procedure);
    this.deferredProcedureEntries.delete(procedure.name);
    this.metadataByName.set(procedure.name, copyProcedureMetadata(procedure));
    this.procedures.set(procedure.name, procedure);
  }

  loadBuiltins(): void {
    for (const definition of createBuiltinProcedureDefinitions(this)) {
      this.registerDeferredProcedure(definition);
    }
  }

  async loadFromDisk(): Promise<void> {
    for (const procedureRoot of this.diskProcedureRoots) {
      for (const definition of discoverDiskProcedures(procedureRoot)) {
        const { path, workspaceRoot, ...metadata } = definition;
        this.registerDeferredProcedure({
          ...metadata,
          load: () => this.loadProcedureFromPath(path, workspaceRoot),
        });
      }
    }
  }

  async loadProcedureFromPath(path: string, workspaceRoot?: string): Promise<Procedure> {
    return await loadDiskProcedureFromPath(path, workspaceRoot);
  }

  async persist(procedure: Procedure, source: string, cwd: string): Promise<string> {
    return await persistProcedureSource({
      procedureName: procedure.name,
      source,
      cwd,
      profileProcedureRoot: this.profileProcedureRoot,
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

  private registerDeferredProcedure(definition: DeferredProcedureDefinition): void {
    if (this.procedures.has(definition.name)) {
      return;
    }

    this.metadataByName.set(definition.name, copyProcedureMetadata(definition));
    const entry: DeferredProcedureEntry = {
      definition,
    };
    this.deferredProcedureEntries.set(definition.name, entry);
    this.procedures.set(definition.name, this.createDeferredProcedure(entry));
  }

  private createDeferredProcedure(entry: DeferredProcedureEntry): Procedure {
    const { definition } = entry;
    const procedure: Procedure = {
      name: definition.name,
      description: definition.description,
      inputHint: definition.inputHint,
      executionMode: definition.executionMode,
      execute: async (prompt, ctx) => {
        const loaded = await this.ensureProcedureLoaded(definition.name);
        return await loaded.execute(prompt, ctx);
      },
    };

    if (definition.supportsResume) {
      procedure.resume = async (prompt, state, ctx) => {
        const loaded = await this.ensureProcedureLoaded(definition.name);
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
      entry.loadPromise = Promise.resolve(entry.definition.load())
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

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}

function createBuiltinProcedureDefinitions(registry: ProcedureRegistry): DeferredProcedureDefinition[] {
  return BUILTIN_PROCEDURE_SOURCES.map(({ load, ...metadata }) => ({
    ...metadata,
    load: () => load(registry),
  }));
}

function describeDeferredProcedureMetadata(procedure: Procedure): DeferredProcedureMetadata {
  return {
    ...copyProcedureMetadata(procedure),
    supportsResume: typeof procedure.resume === "function",
  };
}

function copyProcedureMetadata(metadata: ProcedureMetadata): ProcedureMetadata {
  return {
    name: metadata.name,
    description: metadata.description,
    inputHint: metadata.inputHint,
    executionMode: metadata.executionMode,
  };
}

export function projectProcedureMetadata(
  procedures: readonly ProcedureMetadata[],
  options: { includeHidden?: boolean } = {},
): ProcedureMetadata[] {
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

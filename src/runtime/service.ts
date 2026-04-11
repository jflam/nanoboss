import { inferDataShape } from "../core/data-shape.ts";
import { shouldLoadDiskCommands } from "../core/runtime-mode.ts";
import type {
  CellDescendantsOptions,
  CellRecord,
  CellRef,
  DownstreamAgentSelection,
  ProcedureMetadata,
  ProcedureRegistryLike,
  SessionRecentOptions,
  TopLevelRunsOptions,
  ValueRef,
} from "../core/types.ts";
import {
  ProcedureDispatchJobManager,
} from "../procedure/dispatch-jobs.ts";
import { ProcedureRegistry, projectProcedureMetadata } from "../procedure/registry.ts";
import { SessionStore, readCurrentSessionMetadata, readSessionMetadata } from "../session/index.ts";
import type {
  ProcedureListResult,
  RuntimeSchemaResult,
  RuntimeServiceParams,
  ProcedureDispatchStartToolResult,
  ProcedureDispatchStatusToolResult,
} from "./api.ts";

export class NanobossRuntimeService {
  constructor(private readonly params: RuntimeServiceParams) {}

  sessionRecent(args: SessionRecentOptions & { sessionId?: string } = {}): ReturnType<SessionStore["recent"]> {
    return this.createStore(args.sessionId).recent(args);
  }

  topLevelRuns(args: TopLevelRunsOptions & { sessionId?: string } = {}): ReturnType<SessionStore["topLevelRuns"]> {
    return this.createStore(args.sessionId).topLevelRuns(args);
  }

  cellGet(cellRef: CellRef): CellRecord {
    return this.createStoreForCellRef(cellRef).readCell(cellRef);
  }

  cellAncestors(
    cellRef: CellRef,
    args: { includeSelf?: boolean; limit?: number } = {},
  ): ReturnType<SessionStore["ancestors"]> {
    return this.createStoreForCellRef(cellRef).ancestors(cellRef, args);
  }

  cellDescendants(
    cellRef: CellRef,
    args: CellDescendantsOptions = {},
  ): ReturnType<SessionStore["descendants"]> {
    return this.createStoreForCellRef(cellRef).descendants(cellRef, args);
  }

  refRead(valueRef: ValueRef): unknown {
    return this.createStoreForValueRef(valueRef).readRef(valueRef);
  }

  refStat(valueRef: ValueRef) {
    return this.createStoreForValueRef(valueRef).statRef(valueRef);
  }

  refWriteToFile(valueRef: ValueRef, path: string): { path: string } {
    const store = this.createStoreForValueRef(valueRef);
    store.writeRefToFile(valueRef, path, store.cwd);
    return { path };
  }

  getSchema(args: { cellRef?: CellRef; valueRef?: ValueRef }): RuntimeSchemaResult {
    if (args.valueRef) {
      const store = this.createStoreForValueRef(args.valueRef);
      const value = store.readRef(args.valueRef);
      return {
        target: args.valueRef,
        dataShape: inferDataShape(value),
      };
    }

    if (!args.cellRef) {
      throw new Error("get_schema requires cellRef or valueRef");
    }

    const store = this.createStoreForCellRef(args.cellRef);
    const cell = store.readCell(args.cellRef);
    return {
      target: args.cellRef,
      dataShape: inferDataShape(cell.output.data),
      explicitDataSchema: cell.output.explicitDataSchema,
    };
  }

  async procedureList(args: { includeHidden?: boolean; sessionId?: string } = {}): Promise<ProcedureListResult> {
    const registry = await this.getRegistry(args.sessionId);
    return {
      procedures: getProcedureList(registry, args.includeHidden === true),
    };
  }

  async procedureGet(args: { name: string; sessionId?: string }): Promise<ProcedureMetadata> {
    const registry = await this.getRegistry(args.sessionId);
    const procedure = registry.listMetadata().find((candidate) => candidate.name === args.name);
    if (!procedure) {
      throw new Error(`Unknown procedure: ${args.name}`);
    }

    return toPublicProcedureMetadata(procedure);
  }

  async procedureDispatchStart(args: {
    sessionId?: string;
    name: string;
    prompt: string;
    defaultAgentSelection?: DownstreamAgentSelection;
    dispatchCorrelationId?: string;
  }): Promise<ProcedureDispatchStartToolResult> {
    return await this.createDispatchJobManager(args.sessionId).start({
      name: args.name,
      prompt: args.prompt,
      defaultAgentSelection: args.defaultAgentSelection,
      dispatchCorrelationId: args.dispatchCorrelationId,
    });
  }

  async procedureDispatchStatus(args: { dispatchId: string }): Promise<ProcedureDispatchStatusToolResult> {
    return await this.createDispatchJobManager().status(args.dispatchId);
  }

  async procedureDispatchWait(args: {
    dispatchId: string;
    waitMs?: number;
  }): Promise<ProcedureDispatchStatusToolResult> {
    return await this.createDispatchJobManager().wait(args.dispatchId, args.waitMs);
  }

  private createStore(sessionIdOverride?: string): SessionStore {
    const context = this.resolveEffectiveContext(sessionIdOverride);
    if (!context.sessionId) {
      throw new Error("Nanoboss MCP requires an explicit sessionId or a current session for the server working directory.");
    }

    return new SessionStore({
      sessionId: context.sessionId,
      cwd: context.cwd,
      rootDir: context.rootDir,
    });
  }

  private createStoreForCellRef(cellRef: CellRef): SessionStore {
    return this.createStore(cellRef.sessionId);
  }

  private createStoreForValueRef(valueRef: ValueRef): SessionStore {
    return this.createStore(valueRef.cell.sessionId);
  }

  private createDispatchJobManager(sessionIdOverride?: string): ProcedureDispatchJobManager {
    const context = this.resolveEffectiveContext(sessionIdOverride);
    const store = this.createStore(sessionIdOverride);
    return new ProcedureDispatchJobManager({
      cwd: context.cwd,
      sessionId: store.sessionId,
      rootDir: store.rootDir,
      getRegistry: async () => await this.getRegistry(store.sessionId),
    });
  }

  private async getRegistry(sessionIdOverride?: string): Promise<ProcedureRegistryLike> {
    if (this.params.registry) {
      return this.params.registry;
    }

    return await loadRuntimeRegistry(this.resolveEffectiveContext(sessionIdOverride).cwd);
  }

  private resolveEffectiveContext(sessionIdOverride?: string): { sessionId?: string; cwd: string; rootDir?: string } {
    const explicitSessionId = sessionIdOverride ?? this.params.sessionId;
    if (explicitSessionId) {
      const metadata = readSessionMetadata(explicitSessionId);
      if (metadata) {
        return {
          sessionId: metadata.sessionId,
          cwd: metadata.cwd,
          rootDir: metadata.rootDir,
        };
      }

      return {
        sessionId: explicitSessionId,
        cwd: this.params.cwd,
        rootDir: this.params.rootDir,
      };
    }

    if (this.params.allowCurrentSessionFallback) {
      const current = readCurrentSessionMetadata(this.params.cwd);
      if (current) {
        return {
          sessionId: current.sessionId,
          cwd: current.cwd,
          rootDir: current.rootDir,
        };
      }
    }

    return {
      cwd: this.params.cwd,
      rootDir: this.params.rootDir,
    };
  }
}

export function createNanobossRuntimeService(params: RuntimeServiceParams): NanobossRuntimeService {
  return new NanobossRuntimeService(params);
}

export function createCurrentSessionBackedNanobossRuntimeService(cwd = process.cwd()): NanobossRuntimeService {
  return createNanobossRuntimeService({
    cwd,
    allowCurrentSessionFallback: true,
  });
}

async function loadRuntimeRegistry(cwd: string): Promise<ProcedureRegistryLike> {
  const registry = new ProcedureRegistry({
    workspaceDir: cwd,
  });
  registry.loadBuiltins();
  if (shouldLoadDiskCommands()) {
    await registry.loadFromDisk();
  }
  return registry;
}

function getProcedureList(
  registry: ProcedureRegistryLike,
  includeHidden: boolean,
): ProcedureMetadata[] {
  return projectProcedureMetadata(registry.listMetadata(), { includeHidden })
    .map(toPublicProcedureMetadata);
}

function toPublicProcedureMetadata(metadata: ProcedureMetadata): ProcedureMetadata {
  return {
    name: metadata.name,
    description: metadata.description,
    inputHint: metadata.inputHint,
  };
}

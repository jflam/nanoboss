import { inferDataShape } from "../core/data-shape.ts";
import { shouldLoadDiskCommands } from "../core/runtime-mode.ts";
import { valueRefFromRef } from "../session/store-refs.ts";
import type {
  CellDescendantsOptions,
  DownstreamAgentSelection,
  KernelValue,
  ProcedureMetadata,
  Ref,
  ProcedureRegistryLike,
  RunRef,
} from "../core/types.ts";
import { publicKernelValueFromStored } from "../core/types.ts";
import {
  ProcedureDispatchJobManager,
} from "../procedure/dispatch-jobs.ts";
import { ProcedureRegistry, projectProcedureMetadata } from "../procedure/registry.ts";
import { SessionStore, readCurrentSessionMetadata, readSessionMetadata } from "../session/index.ts";
import type {
  ListRunsArgs,
  ProcedureListResult,
  RuntimeSchemaResult,
  RuntimeServiceParams,
  ProcedureDispatchStartToolResult,
  ProcedureDispatchStatusToolResult,
} from "./api.ts";

export class NanobossRuntimeService {
  constructor(private readonly params: RuntimeServiceParams) {}

  listRuns(args: ListRunsArgs = {}) {
    const store = this.createStore(args.sessionId);
    return args.scope === "recent"
      ? store.recentRuns({ procedure: args.procedure, limit: args.limit })
      : store.topLevelRunSummaries({ procedure: args.procedure, limit: args.limit });
  }

  getRun(runRef: RunRef) {
    return this.createStoreForRunRef(runRef).readRun(runRef);
  }

  getRunAncestors(
    runRef: RunRef,
    args: { includeSelf?: boolean; limit?: number } = {},
  ) {
    return this.createStoreForRunRef(runRef).ancestorRuns(runRef, args);
  }

  getRunDescendants(
    runRef: RunRef,
    args: CellDescendantsOptions = {},
  ) {
    return this.createStoreForRunRef(runRef).descendantRuns(runRef, args);
  }

  refRead(ref: Ref): unknown {
    const valueRef = valueRefFromRef(ref);
    return publicKernelValueFromStored(this.createStoreForRef(ref).readRef(valueRef) as KernelValue);
  }

  refStat(ref: Ref) {
    const valueRef = valueRefFromRef(ref);
    return this.createStoreForRef(ref).statRef(valueRef);
  }

  refWriteToFile(ref: Ref, path: string): { path: string } {
    const valueRef = valueRefFromRef(ref);
    const store = this.createStoreForRef(ref);
    store.writeRefToFile(valueRef, path, store.cwd);
    return { path };
  }

  getSchema(args: { runRef?: RunRef; ref?: Ref }): RuntimeSchemaResult {
    if (args.ref) {
      const valueRef = valueRefFromRef(args.ref);
      const store = this.createStoreForRef(args.ref);
      const value = store.readRef(valueRef);
      return {
        target: args.ref,
        dataShape: inferDataShape(value),
      };
    }

    if (!args.runRef) {
      throw new Error("get_schema requires runRef or ref");
    }

    const store = this.createStoreForRunRef(args.runRef);
    const run = store.readRun(args.runRef);
    return {
      target: args.runRef,
      dataShape: inferDataShape(run.output.data),
      explicitDataSchema: run.output.explicitDataSchema,
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

  private createStoreForRunRef(runRef: RunRef): SessionStore {
    return this.createStore(runRef.sessionId);
  }

  private createStoreForRef(ref: Ref): SessionStore {
    return this.createStore(ref.run.sessionId);
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
          sessionId: metadata.session.sessionId,
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
          sessionId: current.session.sessionId,
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
  const registry = new ProcedureRegistry({ cwd });
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

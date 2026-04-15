import type {
  KernelValue,
  Ref,
  RunListOptions,
  RefsApi,
  RunAncestorsOptions,
  RunDescendantsOptions,
  RunRef,
  RunRecord,
  RunSummary,
  StateApi,
  StateRunsApi,
} from "./types.ts";
import type { SessionStore } from "../session/index.ts";
import { valueRefFromRef } from "../session/store-refs.ts";
import { publicKernelValueFromStored } from "./types.ts";

export class CommandRefs implements RefsApi {
  constructor(
    private readonly store: SessionStore,
    private readonly cwd: string,
  ) {}

  async read<T>(ref: Ref): Promise<T> {
    return publicKernelValueFromStored(this.store.readRef(valueRefFromRef(ref)) as KernelValue) as T;
  }

  async stat(ref: Ref) {
    return this.store.statRef(valueRefFromRef(ref));
  }

  async writeToFile(ref: Ref, path: string): Promise<void> {
    this.store.writeRefToFile(valueRefFromRef(ref), path, this.cwd);
  }
}

export class CommandRuns implements StateRunsApi {
  constructor(
    private readonly store: SessionStore,
    private readonly currentCellId: string,
  ) {}

  async list(options: RunListOptions = {}): Promise<RunSummary[]> {
    if (options.scope === "recent") {
      return this.store.recentRuns({
        procedure: options.procedure,
        limit: options.limit,
        excludeCellId: this.currentCellId,
      });
    }

    return this.store.topLevelRunSummaries({
      procedure: options.procedure,
      limit: options.limit,
    });
  }

  async get(run: RunRef): Promise<RunRecord> {
    return this.store.readRun(run);
  }

  async getAncestors(run: RunRef, options?: RunAncestorsOptions): Promise<RunSummary[]> {
    return this.store.ancestorRuns(run, options);
  }

  async getDescendants(run: RunRef, options?: RunDescendantsOptions): Promise<RunSummary[]> {
    return this.store.descendantRuns(run, options);
  }
}

export class CommandState implements StateApi {
  readonly refs: RefsApi;
  readonly runs: StateRunsApi;

  constructor(store: SessionStore, cwd: string, currentCellId: string) {
    this.refs = new CommandRefs(store, cwd);
    this.runs = new CommandRuns(store, currentCellId);
  }
}

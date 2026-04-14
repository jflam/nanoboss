import type {
  KernelValue,
  Ref,
  RefsApi,
  RunAncestorsOptions,
  RunDescendantsOptions,
  RunRef,
  RunRecord,
  RunSummary,
  SessionRecentOptions,
  StateApi,
  StateRunsApi,
  TopLevelRunsOptions,
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

  async recent(options?: SessionRecentOptions): Promise<RunSummary[]> {
    return this.store.recentRuns({
      ...options,
      excludeCellId: this.currentCellId,
    });
  }

  async latest(options?: SessionRecentOptions): Promise<RunSummary | undefined> {
    return this.store.latestRun({
      ...options,
      excludeCellId: this.currentCellId,
    });
  }

  async topLevelRuns(options?: TopLevelRunsOptions): Promise<RunSummary[]> {
    return this.store.topLevelRunSummaries(options);
  }

  async get(run: RunRef): Promise<RunRecord> {
    return this.store.readRun(run);
  }

  async parent(run: RunRef): Promise<RunSummary | undefined> {
    return this.store.parentRun(run);
  }

  async children(run: RunRef, options?: Omit<RunDescendantsOptions, "maxDepth">): Promise<RunSummary[]> {
    return this.store.childRuns(run, options);
  }

  async ancestors(run: RunRef, options?: RunAncestorsOptions): Promise<RunSummary[]> {
    return this.store.ancestorRuns(run, options);
  }

  async descendants(run: RunRef, options?: RunDescendantsOptions): Promise<RunSummary[]> {
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

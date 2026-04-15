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
import type { SessionStore } from "@nanoboss/store";
import { publicKernelValueFromStored } from "./types.ts";

export class CommandRefs implements RefsApi {
  constructor(
    private readonly store: SessionStore,
    private readonly cwd: string,
  ) {}

  async read<T>(ref: Ref): Promise<T> {
    return publicKernelValueFromStored(this.store.readRef(ref) as KernelValue) as T;
  }

  async stat(ref: Ref) {
    return this.store.statRef(ref);
  }

  async writeToFile(ref: Ref, path: string): Promise<void> {
    this.store.writeRefToFile(ref, path, this.cwd);
  }
}

export class CommandRuns implements StateRunsApi {
  constructor(
    private readonly store: SessionStore,
    private readonly currentRunId: string,
  ) {}

  async list(options: RunListOptions = {}): Promise<RunSummary[]> {
    const runs = this.store.listRuns(options);
    return options.scope === "recent"
      ? runs.filter((summary) => summary.run.runId !== this.currentRunId)
      : runs;
  }

  async get(run: RunRef): Promise<RunRecord> {
    return this.store.getRun(run);
  }

  async getAncestors(run: RunRef, options?: RunAncestorsOptions): Promise<RunSummary[]> {
    return this.store.getRunAncestors(run, options);
  }

  async getDescendants(run: RunRef, options?: RunDescendantsOptions): Promise<RunSummary[]> {
    return this.store.getRunDescendants(run, options);
  }
}

export class CommandState implements StateApi {
  readonly refs: RefsApi;
  readonly runs: StateRunsApi;

  constructor(store: SessionStore, cwd: string, currentRunId: string) {
    this.refs = new CommandRefs(store, cwd);
    this.runs = new CommandRuns(store, currentRunId);
  }
}

import { publicKernelValueFromStored, type SessionStore } from "@nanoboss/store";
import type {
  KernelValue,
  Ref,
  RefsApi,
  RunAncestorsOptions,
  RunDescendantsOptions,
  RunListOptions,
  RunRecord,
  RunRef,
  RunSummary,
  StateApi,
  StateRunsApi,
} from "@nanoboss/procedure-sdk";

class CommandRefs implements RefsApi {
  constructor(
    private readonly store: SessionStore,
    private readonly cwd: string,
    private readonly assertNotCancelled?: () => void,
  ) {}

  async read<T>(ref: Ref): Promise<T> {
    this.assertNotCancelled?.();
    return publicKernelValueFromStored(this.store.readRef(ref) as KernelValue) as T;
  }

  async stat(ref: Ref) {
    this.assertNotCancelled?.();
    return this.store.statRef(ref);
  }

  async writeToFile(ref: Ref, path: string): Promise<void> {
    this.assertNotCancelled?.();
    this.store.writeRefToFile(ref, path, this.cwd);
  }
}

class CommandRuns implements StateRunsApi {
  constructor(
    private readonly store: SessionStore,
    private readonly currentRunId: string,
    private readonly assertNotCancelled?: () => void,
  ) {}

  async list(options: RunListOptions = {}): Promise<RunSummary[]> {
    this.assertNotCancelled?.();
    const runs = this.store.listRuns(options);
    return options.scope === "recent"
      ? runs.filter((summary) => summary.run.runId !== this.currentRunId)
      : runs;
  }

  async get(run: RunRef): Promise<RunRecord> {
    this.assertNotCancelled?.();
    return this.store.getRun(run);
  }

  async getAncestors(run: RunRef, options?: RunAncestorsOptions): Promise<RunSummary[]> {
    this.assertNotCancelled?.();
    return this.store.getRunAncestors(run, options);
  }

  async getDescendants(run: RunRef, options?: RunDescendantsOptions): Promise<RunSummary[]> {
    this.assertNotCancelled?.();
    return this.store.getRunDescendants(run, options);
  }
}

export class CommandState implements StateApi {
  readonly refs: RefsApi;
  readonly runs: StateRunsApi;

  constructor(
    store: SessionStore,
    cwd: string,
    currentRunId: string,
    assertNotCancelled?: () => void,
  ) {
    this.refs = new CommandRefs(store, cwd, assertNotCancelled);
    this.runs = new CommandRuns(store, currentRunId, assertNotCancelled);
  }
}

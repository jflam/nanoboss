import type {
  CellAncestorsOptions,
  CellDescendantsOptions,
  CellRef,
  RefsApi,
  SessionRecentOptions,
  StateApi,
  StateRunsApi,
  TopLevelRunsOptions,
  ValueRef,
} from "./types.ts";
import type { SessionStore } from "../session/index.ts";

export class CommandRefs implements RefsApi {
  constructor(
    private readonly store: SessionStore,
    private readonly cwd: string,
  ) {}

  async read<T>(valueRef: ValueRef): Promise<T> {
    return this.store.readRef(valueRef) as T;
  }

  async stat(valueRef: ValueRef) {
    return this.store.statRef(valueRef);
  }

  async writeToFile(valueRef: ValueRef, path: string): Promise<void> {
    this.store.writeRefToFile(valueRef, path, this.cwd);
  }
}

export class CommandRuns implements StateRunsApi {
  constructor(
    private readonly store: SessionStore,
    private readonly currentCellId: string,
  ) {}

  async recent(options?: SessionRecentOptions) {
    return this.store.recent({
      ...options,
      excludeCellId: this.currentCellId,
    });
  }

  async latest(options?: SessionRecentOptions) {
    return this.store.latest({
      ...options,
      excludeCellId: this.currentCellId,
    });
  }

  async topLevelRuns(options?: TopLevelRunsOptions) {
    return this.store.topLevelRuns(options);
  }

  async get(cellRef: CellRef) {
    return this.store.readCell(cellRef);
  }

  async parent(cellRef: CellRef) {
    return this.store.parent(cellRef);
  }

  async children(cellRef: CellRef, options?: Omit<CellDescendantsOptions, "maxDepth">) {
    return this.store.children(cellRef, options);
  }

  async ancestors(cellRef: CellRef, options?: CellAncestorsOptions) {
    return this.store.ancestors(cellRef, options);
  }

  async descendants(cellRef: CellRef, options?: CellDescendantsOptions) {
    return this.store.descendants(cellRef, options);
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

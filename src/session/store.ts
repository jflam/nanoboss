import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { getSessionDir } from "../core/config.ts";
import { inferDataShape } from "../core/data-shape.ts";
import { summarizeText } from "../util/text.ts";
import type {
  CellAncestorsOptions,
  CellDescendantsOptions,
  CellFilterOptions,
  CellKind,
  CellRecord,
  CellRef,
  CellSummary,
  DownstreamAgentSelection,
  KernelValue,
  PersistedFrontendEvent,
  ProcedureResult,
  RefStat,
  RunResult,
  TopLevelRunsOptions,
  ValueRef,
} from "../core/types.ts";

interface CellDraft {
  cell: CellRef;
  procedure: string;
  input: string;
  meta: {
    createdAt: string;
    parentCellId?: string;
    kind: CellKind;
    dispatchCorrelationId?: string;
    defaultAgentSelection?: DownstreamAgentSelection;
  };
  streamChunks: string[];
}

interface RecentOptions {
  procedure?: string;
  limit?: number;
  excludeCellId?: string;
}

interface FinalizeCellOptions {
  display?: string;
  stream?: string;
  summary?: string;
  raw?: string;
  replayEvents?: PersistedFrontendEvent[];
  meta?: Partial<CellRecord["meta"]>;
}

export function createCellRef(sessionId: string, cellId: string): CellRef {
  return { sessionId, cellId };
}

export function createValueRef(cell: CellRef, path: string): ValueRef {
  return { cell, path };
}

export function normalizeProcedureResult<T extends KernelValue = KernelValue>(
  result: ProcedureResult<T> | string | void,
): ProcedureResult<T> {
  if (typeof result === "string") {
    return {
      display: result,
      summary: summarizeText(result),
    };
  }

  return result === undefined ? {} : result;
}

export class SessionStore {
  readonly sessionId: string;
  readonly cwd: string;
  readonly rootDir: string;

  private readonly cellsDir: string;
  private readonly cells = new Map<string, CellRecord>();
  private readonly cellFilePaths = new Map<string, string>();
  private readonly order: string[] = [];
  private readonly parentByCellId = new Map<string, string | undefined>();
  private readonly childrenByCellId = new Map<string, string[]>();
  private readonly topLevelCellIds: string[] = [];

  constructor(params: { sessionId: string; cwd: string; rootDir?: string }) {
    this.sessionId = params.sessionId;
    this.cwd = params.cwd;
    this.rootDir = params.rootDir ?? getSessionDir(params.sessionId);
    this.cellsDir = join(this.rootDir, "cells");
    mkdirSync(this.cellsDir, { recursive: true });
    this.loadExistingCells();
  }

  startCell(params: {
    procedure: string;
    input: string;
    kind: CellKind;
    parentCellId?: string;
    dispatchCorrelationId?: string;
  }): CellDraft {
    return {
      cell: createCellRef(this.sessionId, crypto.randomUUID()),
      procedure: params.procedure,
      input: params.input,
      meta: {
        createdAt: new Date().toISOString(),
        parentCellId: params.parentCellId,
        kind: params.kind,
        dispatchCorrelationId: params.dispatchCorrelationId,
      },
      streamChunks: [],
    };
  }

  appendStream(draft: CellDraft, text: string): void {
    draft.streamChunks.push(text);
  }

  finalizeCell<T extends KernelValue = KernelValue>(
    draft: CellDraft,
    result: ProcedureResult<T>,
    options: FinalizeCellOptions = {},
  ): RunResult<T> {
    const stream = draft.streamChunks.join("") || options.stream;
    const display = result.display ?? options.display ?? options.raw;
    const summary = result.summary ?? options.summary ?? (
      display !== undefined && result.data === undefined
        ? summarizeText(display)
        : undefined
    );
    const memory = result.memory;
    const pause = result.pause;

    const record: CellRecord = {
      cellId: draft.cell.cellId,
      procedure: draft.procedure,
      input: draft.input,
      output: {
        ...(result.data !== undefined ? { data: result.data } : {}),
        ...(display !== undefined ? { display } : {}),
        ...(stream !== undefined && stream.length > 0 ? { stream } : {}),
        ...(summary !== undefined && summary.length > 0 ? { summary } : {}),
        ...(memory !== undefined && memory.length > 0 ? { memory } : {}),
        ...(pause !== undefined ? { pause } : {}),
        ...(options.replayEvents && options.replayEvents.length > 0
          ? { replayEvents: options.replayEvents }
          : {}),
        ...(result.explicitDataSchema !== undefined
          ? { explicitDataSchema: result.explicitDataSchema }
          : {}),
      },
      meta: {
        ...draft.meta,
        ...options.meta,
      },
    };

    const filePath = join(this.cellsDir, `${Date.now()}-${record.cellId}.json`);
    writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    this.storeCellRecord(record, filePath);

    const dataRef = record.output.data !== undefined
      ? createValueRef(draft.cell, "output.data")
      : undefined;
    const displayRef = record.output.display !== undefined
      ? createValueRef(draft.cell, "output.display")
      : undefined;
    const streamRef = record.output.stream !== undefined
      ? createValueRef(draft.cell, "output.stream")
      : undefined;
    const pauseRef = record.output.pause !== undefined
      ? createValueRef(draft.cell, "output.pause")
      : undefined;

    return {
      cell: draft.cell,
      data: result.data,
      dataRef,
      displayRef,
      streamRef,
      pause: record.output.pause,
      pauseRef,
      summary: record.output.summary,
      rawRef: options.raw !== undefined ? displayRef : undefined,
    };
  }

  patchCell(
    cellRef: CellRef,
    patch: {
      output?: Partial<CellRecord["output"]>;
      meta?: Partial<CellRecord["meta"]>;
    },
  ): CellRecord {
    this.loadExistingCells();
    const existing = this.readCell(cellRef);
    const filePath = this.cellFilePaths.get(cellRef.cellId);
    if (!filePath) {
      throw new Error(`Unknown cell: ${cellRef.cellId}`);
    }

    const updated: CellRecord = {
      ...existing,
      output: {
        ...existing.output,
        ...patch.output,
      },
      meta: {
        ...existing.meta,
        ...patch.meta,
      },
    };

    this.cells.set(cellRef.cellId, updated);
    writeFileSync(filePath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    return updated;
  }

  readRef(valueRef: ValueRef): unknown {
    const cell = this.readCell(valueRef.cell);
    return getValueAtPath(cell, valueRef.path);
  }

  statRef(valueRef: ValueRef): RefStat {
    const value = this.readRef(valueRef);
    const preview = buildPreview(value);

    return {
      cell: valueRef.cell,
      path: valueRef.path,
      type: inferType(value),
      size: Buffer.byteLength(serializeValue(value), "utf8"),
      ...(preview ? { preview } : {}),
    };
  }

  writeRefToFile(valueRef: ValueRef, path: string, cwd = this.cwd): void {
    const value = this.readRef(valueRef);
    const targetPath = resolve(cwd, path);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, materializeForFile(value), "utf8");
  }

  recent(options: RecentOptions = {}): CellSummary[] {
    this.loadExistingCells();
    return this.collectReverseSummaries(this.order, {
      ...options,
      limit: options.limit ?? 10,
    });
  }

  latest(options: RecentOptions = {}): CellSummary | undefined {
    return this.recent({
      ...options,
      limit: 1,
    })[0];
  }

  parent(cellRef: CellRef): CellSummary | undefined {
    this.loadExistingCells();
    this.readCell(cellRef);
    const parentCellId = this.parentByCellId.get(cellRef.cellId);
    return parentCellId ? this.toSummaryByCellId(parentCellId) : undefined;
  }

  children(cellRef: CellRef, options: Omit<CellDescendantsOptions, "maxDepth"> = {}): CellSummary[] {
    return this.descendants(cellRef, {
      ...options,
      maxDepth: 1,
    });
  }

  ancestors(cellRef: CellRef, options: CellAncestorsOptions = {}): CellSummary[] {
    this.loadExistingCells();
    const cell = this.readCell(cellRef);
    const limit = normalizeLimit(options.limit);
    const ancestors: CellSummary[] = [];
    let currentCellId = options.includeSelf ? cell.cellId : this.parentByCellId.get(cell.cellId);

    while (currentCellId) {
      ancestors.push(this.toSummaryByCellId(currentCellId));
      if (limit !== undefined && ancestors.length >= limit) {
        break;
      }
      currentCellId = this.parentByCellId.get(currentCellId);
    }

    return ancestors;
  }

  descendants(cellRef: CellRef, options: CellDescendantsOptions = {}): CellSummary[] {
    this.loadExistingCells();
    this.readCell(cellRef);
    const limit = normalizeLimit(options.limit);
    const maxDepth = normalizeLimit(options.maxDepth);
    if (limit === 0 || maxDepth === 0) {
      return [];
    }

    const descendants: CellSummary[] = [];
    const stack = [...(this.childrenByCellId.get(cellRef.cellId) ?? [])]
      .reverse()
      .map((cellId) => ({ cellId, depth: 1 }));

    while (stack.length > 0) {
      const next = stack.pop();
      if (!next) {
        break;
      }

      if (maxDepth !== undefined && next.depth > maxDepth) {
        continue;
      }

      const record = this.cells.get(next.cellId);
      if (!record) {
        continue;
      }

      if (matchesCell(record, options)) {
        descendants.push(this.toSummary(record));
        if (limit !== undefined && descendants.length >= limit) {
          break;
        }
      }

      if (maxDepth !== undefined && next.depth >= maxDepth) {
        continue;
      }

      const childCellIds = this.childrenByCellId.get(next.cellId) ?? [];
      for (let index = childCellIds.length - 1; index >= 0; index -= 1) {
        const childCellId = childCellIds[index];
        if (!childCellId) {
          continue;
        }
        stack.push({ cellId: childCellId, depth: next.depth + 1 });
      }
    }

    return descendants;
  }

  topLevelRuns(options: TopLevelRunsOptions = {}): CellSummary[] {
    this.loadExistingCells();
    return this.collectReverseSummaries(this.topLevelCellIds, options);
  }

  readCell(cellRef: CellRef): CellRecord {
    this.loadExistingCells();
    if (cellRef.sessionId !== this.sessionId) {
      throw new Error(`Unknown session: ${cellRef.sessionId}`);
    }

    const existing = this.cells.get(cellRef.cellId);
    if (existing) {
      return existing;
    }

    const filePath = this.cellFilePaths.get(cellRef.cellId);
    if (!filePath) {
      throw new Error(`Unknown cell: ${cellRef.cellId}`);
    }

    const loaded = JSON.parse(readFileSync(filePath, "utf8")) as CellRecord;
    this.cells.set(cellRef.cellId, loaded);
    return loaded;
  }

  private toSummary(record: CellRecord): CellSummary {
    const cell = createCellRef(this.sessionId, record.cellId);

    return {
      cell,
      procedure: record.procedure,
      kind: record.meta.kind,
      ...(record.meta.parentCellId ? { parentCellId: record.meta.parentCellId } : {}),
      summary: record.output.summary,
      memory: record.output.memory,
      dataRef: record.output.data !== undefined ? createValueRef(cell, "output.data") : undefined,
      displayRef: record.output.display !== undefined
        ? createValueRef(cell, "output.display")
        : undefined,
      streamRef: record.output.stream !== undefined ? createValueRef(cell, "output.stream") : undefined,
      dataShape: record.output.data !== undefined ? inferDataShape(record.output.data) : undefined,
      explicitDataSchema: record.output.explicitDataSchema,
      createdAt: record.meta.createdAt,
    };
  }

  private toSummaryByCellId(cellId: string): CellSummary {
    const record = this.cells.get(cellId);
    if (!record) {
      throw new Error(`Unknown cell: ${cellId}`);
    }

    return this.toSummary(record);
  }

  private collectReverseSummaries(
    cellIds: readonly string[],
    options: RecentOptions = {},
  ): CellSummary[] {
    const limit = normalizeLimit(options.limit);
    if (limit === 0) {
      return [];
    }

    const summaries: CellSummary[] = [];

    for (let index = cellIds.length - 1; index >= 0; index -= 1) {
      const cellId = cellIds[index];
      if (!cellId || cellId === options.excludeCellId) {
        continue;
      }

      const record = this.cells.get(cellId);
      if (!record) {
        continue;
      }

      if (options.procedure && record.procedure !== options.procedure) {
        continue;
      }

      summaries.push(this.toSummary(record));
      if (limit !== undefined && summaries.length >= limit) {
        break;
      }
    }

    return summaries;
  }

  private storeCellRecord(record: CellRecord, filePath: string): void {
    this.cells.set(record.cellId, record);
    this.cellFilePaths.set(record.cellId, filePath);
    this.order.push(record.cellId);
    this.sortCellIdsByCreationOrder(this.order);
    this.indexCell(record);
  }

  private indexCell(record: CellRecord): void {
    this.parentByCellId.set(record.cellId, record.meta.parentCellId);
    this.childrenByCellId.set(record.cellId, this.childrenByCellId.get(record.cellId) ?? []);

    if (record.meta.parentCellId) {
      const childCellIds = this.childrenByCellId.get(record.meta.parentCellId) ?? [];
      childCellIds.push(record.cellId);
      this.sortCellIdsByCreationOrder(childCellIds);
      this.childrenByCellId.set(record.meta.parentCellId, childCellIds);
    }

    if (record.meta.kind === "top_level") {
      this.topLevelCellIds.push(record.cellId);
      this.sortCellIdsByCreationOrder(this.topLevelCellIds);
    }
  }

  private sortCellIdsByCreationOrder(cellIds: string[]): void {
    cellIds.sort((leftId, rightId) => this.compareCellOrder(leftId, rightId));
  }

  private compareCellOrder(leftId: string, rightId: string): number {
    const left = this.cells.get(leftId);
    const right = this.cells.get(rightId);
    if (!left || !right) {
      return 0;
    }

    const createdAtCompare = left.meta.createdAt.localeCompare(right.meta.createdAt);
    if (createdAtCompare !== 0) {
      return createdAtCompare;
    }

    const leftPath = this.cellFilePaths.get(leftId);
    const rightPath = this.cellFilePaths.get(rightId);
    if (leftPath && rightPath) {
      const pathCompare = leftPath.localeCompare(rightPath);
      if (pathCompare !== 0) {
        return pathCompare;
      }
    }

    return leftId.localeCompare(rightId);
  }

  private loadExistingCells(): void {
    const files = readdirSync(this.cellsDir)
      .filter((entry) => entry.endsWith(".json"))
      .sort();

    for (const fileName of files) {
      const filePath = join(this.cellsDir, fileName);
      const record = JSON.parse(readFileSync(filePath, "utf8")) as CellRecord;

      if (!record.cellId) {
        throw new Error(`Invalid cell record: ${filePath}`);
      }

      const existingPath = this.cellFilePaths.get(record.cellId);
      if (existingPath) {
        continue;
      }

      this.storeCellRecord(record, filePath);
    }
  }
}

function matchesCell(record: CellRecord, options: Pick<CellFilterOptions, "kind" | "procedure">): boolean {
  if (options.kind && record.meta.kind !== options.kind) {
    return false;
  }

  if (options.procedure && record.procedure !== options.procedure) {
    return false;
  }

  return true;
}

function normalizeLimit(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(0, Math.floor(value));
}

function getValueAtPath(root: unknown, path: string): unknown {
  if (!path.trim()) {
    return root;
  }

  return path.split(".").reduce((current, segment) => {
    if (current === null || current === undefined) {
      throw new Error(`Invalid ref path: ${path}`);
    }

    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new Error(`Invalid ref path: ${path}`);
      }
      return current[index];
    }

    if (typeof current !== "object") {
      throw new Error(`Invalid ref path: ${path}`);
    }

    const value = (current as Record<string, unknown>)[segment];
    if (value === undefined) {
      throw new Error(`Invalid ref path: ${path}`);
    }
    return value;
  }, root);
}

function inferType(value: unknown): string {
  if (isCellRef(value)) {
    return "cell_ref";
  }

  if (isValueRef(value)) {
    return "value_ref";
  }

  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  return typeof value;
}

function buildPreview(value: unknown): string | undefined {
  const serialized = serializeValue(value).replace(/\s+/g, " ").trim();
  if (!serialized) {
    return undefined;
  }

  return serialized.length > 120 ? `${serialized.slice(0, 117)}...` : serialized;
}

function serializeValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function materializeForFile(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  const serialized = JSON.stringify(value, null, 2);
  return serialized.endsWith("\n") ? serialized : `${serialized}\n`;
}

function isCellRef(value: unknown): value is CellRef {
  return (
    typeof value === "object" &&
    value !== null &&
    "sessionId" in value &&
    typeof (value as { sessionId: unknown }).sessionId === "string" &&
    "cellId" in value &&
    typeof (value as { cellId: unknown }).cellId === "string"
  );
}

function isValueRef(value: unknown): value is ValueRef {
  return (
    typeof value === "object" &&
    value !== null &&
    "cell" in value &&
    typeof (value as { cell: unknown }).cell === "object" &&
    (value as { cell: unknown }).cell !== null &&
    "path" in value &&
    typeof (value as { path: unknown }).path === "string"
  );
}

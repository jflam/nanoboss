import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { getSessionDir } from "./config.ts";
import type {
  CellKind,
  CellRecord,
  CellRef,
  CellSummary,
  KernelValue,
  ProcedureResult,
  RefStat,
  RunResult,
  ValueRef,
} from "./types.ts";

interface CellDraft {
  cell: CellRef;
  procedure: string;
  input: string;
  meta: {
    createdAt: string;
    parentCellId?: string;
    kind: CellKind;
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

export function summarizeText(text: string, maxLength = 80): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }

  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

export class SessionStore {
  readonly sessionId: string;
  readonly cwd: string;
  readonly rootDir: string;

  private readonly cellsDir: string;
  private readonly cells = new Map<string, CellRecord>();
  private readonly cellFilePaths = new Map<string, string>();
  private readonly order: string[] = [];

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
  }): CellDraft {
    return {
      cell: createCellRef(this.sessionId, crypto.randomUUID()),
      procedure: params.procedure,
      input: params.input,
      meta: {
        createdAt: new Date().toISOString(),
        parentCellId: params.parentCellId,
        kind: params.kind,
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

    const record: CellRecord = {
      cellId: draft.cell.cellId,
      procedure: draft.procedure,
      input: draft.input,
      output: {
        ...(result.data !== undefined ? { data: result.data } : {}),
        ...(display !== undefined ? { display } : {}),
        ...(stream !== undefined && stream.length > 0 ? { stream } : {}),
        ...(summary !== undefined && summary.length > 0 ? { summary } : {}),
      },
      meta: draft.meta,
    };

    const filePath = join(this.cellsDir, `${Date.now()}-${record.cellId}.json`);
    writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    this.cells.set(record.cellId, record);
    this.cellFilePaths.set(record.cellId, filePath);
    this.order.push(record.cellId);

    const dataRef = record.output.data !== undefined
      ? createValueRef(draft.cell, "output.data")
      : undefined;
    const displayRef = record.output.display !== undefined
      ? createValueRef(draft.cell, "output.display")
      : undefined;
    const streamRef = record.output.stream !== undefined
      ? createValueRef(draft.cell, "output.stream")
      : undefined;

    return {
      cell: draft.cell,
      data: result.data,
      dataRef,
      displayRef,
      streamRef,
      summary: record.output.summary,
      rawRef: options.raw !== undefined ? displayRef : undefined,
    };
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

  last(options: Omit<RecentOptions, "limit"> = {}): CellSummary | undefined {
    return this.recent({ ...options, limit: 1 })[0];
  }

  recent(options: RecentOptions = {}): CellSummary[] {
    const limit = options.limit ?? 10;
    const summaries: CellSummary[] = [];

    for (let index = this.order.length - 1; index >= 0; index -= 1) {
      const cellId = this.order[index];
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
      if (summaries.length >= limit) {
        break;
      }
    }

    return summaries;
  }

  readCell(cellRef: CellRef): CellRecord {
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
      summary: record.output.summary,
      dataRef: record.output.data !== undefined ? createValueRef(cell, "output.data") : undefined,
      displayRef: record.output.display !== undefined
        ? createValueRef(cell, "output.display")
        : undefined,
      streamRef: record.output.stream !== undefined ? createValueRef(cell, "output.stream") : undefined,
      createdAt: record.meta.createdAt,
    };
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

      if (this.cellFilePaths.has(record.cellId)) {
        throw new Error(`Duplicate cell record: ${record.cellId}`);
      }

      this.cells.set(record.cellId, record);
      this.cellFilePaths.set(record.cellId, filePath);
      this.order.push(record.cellId);
    }
  }
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

import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { writeJsonFileAtomicSync } from "@nanoboss/app-support";
import {
  cellRefFromRunRef,
  valueRefFromRef,
} from "./ref-store.ts";
import { getSessionDir } from "./paths.ts";
import {
  buildPreview,
  getValueAtPath,
  inferType,
  materializeForFile,
  serializeValue,
} from "./stored-value-access.ts";
import { PromptImageAttachmentStore } from "./prompt-image-attachments.ts";
import type {
  KernelValue,
  PromptImageSummary,
  PromptInput,
  Ref,
  RefStat,
  RunAncestorsOptions,
  RunDescendantsOptions,
  RunKind,
  RunListOptions,
  RunRef,
  RunSummary,
} from "@nanoboss/contracts";
import { createRef, createRunRef } from "@nanoboss/contracts";
import { inferDataShape, summarizeText, type ProcedureResult } from "@nanoboss/procedure-sdk";
import {
  matchesCell,
  normalizeLimit,
  normalizeProcedureResult,
  toCellSummary,
  toRunRecord,
  toRunSummary,
  type CellRecord,
  type CellRef,
  type CellSummary,
  type CompleteRunOptions,
  type RecentOptions,
  type RunDraft,
  type StoredRunRecord,
  type StoredRunResult,
} from "./session-records.ts";

export { normalizeProcedureResult } from "./session-records.ts";
export type { StoredRunResult } from "./session-records.ts";

export class SessionStore {
  readonly sessionId: string;
  readonly cwd: string;
  readonly rootDir: string;

  private readonly cellsDir: string;
  private readonly attachments: PromptImageAttachmentStore;
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
    this.attachments = new PromptImageAttachmentStore(this.rootDir);
    mkdirSync(this.cellsDir, { recursive: true });
    this.loadExistingCells();
    this.attachments.cleanupStaleAttachmentTemps();
  }

  persistPromptImages(input: PromptInput): PromptImageSummary[] | undefined {
    return this.attachments.persistPromptImages(input);
  }

  startRun(params: {
    procedure: string;
    input: string;
    kind: RunKind;
    parentRunId?: string;
    dispatchCorrelationId?: string;
    promptImages?: CellRecord["meta"]["promptImages"];
  }): RunDraft {
    return {
      run: createRunRef(this.sessionId, crypto.randomUUID()),
      procedure: params.procedure,
      input: params.input,
      meta: {
        createdAt: new Date().toISOString(),
        parentRunId: params.parentRunId,
        kind: params.kind,
        dispatchCorrelationId: params.dispatchCorrelationId,
        promptImages: params.promptImages,
      },
      streamChunks: [],
    };
  }

  appendStream(draft: RunDraft, text: string): void {
    draft.streamChunks.push(text);
  }

  completeRun<T extends KernelValue = KernelValue>(
    draft: RunDraft,
    result: ProcedureResult<T>,
    options: CompleteRunOptions = {},
  ): StoredRunResult<T> {
    const stream = draft.streamChunks.join("") || options.stream;
    const display = result.display ?? options.display ?? options.raw;
    const summary = result.summary ?? options.summary ?? (
      display !== undefined && result.data === undefined
        ? summarizeText(display)
        : undefined
    );
    const memory = result.memory;
    const pause = result.pause;
    const cell = cellRefFromRunRef(draft.run);

    const record: CellRecord = {
      cellId: draft.run.runId,
      procedure: draft.procedure,
      input: draft.input,
      output: {
        ...(result.data !== undefined ? { data: result.data } : {}),
        ...(display !== undefined ? { display } : {}),
        ...(stream !== undefined && stream.length > 0 ? { stream } : {}),
        ...(summary !== undefined && summary.length > 0 ? { summary } : {}),
        ...(memory !== undefined && memory.length > 0 ? { memory } : {}),
        ...(pause !== undefined ? { pause } : {}),
        ...(options.agentUpdates !== undefined
          ? { agentUpdates: options.agentUpdates }
          : {}),
        ...(options.replayEvents && options.replayEvents.length > 0
          ? { replayEvents: options.replayEvents }
          : {}),
        ...(result.explicitDataSchema !== undefined
          ? { explicitDataSchema: result.explicitDataSchema }
          : {}),
      },
      meta: {
        createdAt: draft.meta.createdAt,
        parentCellId: draft.meta.parentRunId,
        kind: draft.meta.kind,
        dispatchCorrelationId: draft.meta.dispatchCorrelationId,
        defaultAgentSelection: draft.meta.defaultAgentSelection,
        promptImages: draft.meta.promptImages,
        ...options.meta,
      },
    };

    const filePath = join(this.cellsDir, `${Date.now()}-${record.cellId}.json`);
    writeJsonFileAtomicSync(filePath, record);
    try {
      this.attachments.promotePendingPromptImages(draft.meta.promptImages);
    } catch (error) {
      unlinkSync(filePath);
      throw error;
    }

    this.storeCellRecord(record, filePath);

    const dataRef = record.output.data !== undefined
      ? createRef(draft.run, "output.data")
      : undefined;
    const displayRef = record.output.display !== undefined
      ? createRef(draft.run, "output.display")
      : undefined;
    const streamRef = record.output.stream !== undefined
      ? createRef(draft.run, "output.stream")
      : undefined;
    const pauseRef = record.output.pause !== undefined
      ? createRef(draft.run, "output.pause")
      : undefined;

    return {
      run: draft.run,
      data: result.data,
      dataRef,
      display: record.output.display,
      displayRef,
      streamRef,
      memory: record.output.memory,
      pause: record.output.pause,
      pauseRef,
      summary: record.output.summary,
      dataShape: record.output.data !== undefined ? inferDataShape(record.output.data) : undefined,
      explicitDataSchema: record.output.explicitDataSchema,
      rawRef: options.raw !== undefined ? displayRef : undefined,
    };
  }

  patchRun(
    runRef: RunRef,
    patch: {
      output?: Partial<CellRecord["output"]>;
      meta?: Partial<CellRecord["meta"]>;
    },
  ): StoredRunRecord {
    this.loadExistingCells();
    const cellRef = cellRefFromRunRef(runRef);
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
    writeJsonFileAtomicSync(filePath, updated);
    return toRunRecord(this.sessionId, updated);
  }

  readRef(ref: Ref): unknown {
    const valueRef = valueRefFromRef(ref);
    const cell = this.readCell(valueRef.cell);
    return getValueAtPath(cell, valueRef.path);
  }

  getRun(runRef: RunRef): StoredRunRecord {
    return toRunRecord(this.sessionId, this.readCell(cellRefFromRunRef(runRef)));
  }

  statRef(ref: Ref): RefStat {
    const value = this.readRef(ref);
    const preview = buildPreview(value);

    return {
      run: ref.run,
      path: ref.path,
      type: inferType(value),
      size: Buffer.byteLength(serializeValue(value), "utf8"),
      ...(preview ? { preview } : {}),
    };
  }

  writeRefToFile(ref: Ref, path: string, cwd = this.cwd): void {
    const value = this.readRef(ref);
    const targetPath = resolve(cwd, path);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, materializeForFile(value), "utf8");
  }

  listRuns(options: RunListOptions = {}): RunSummary[] {
    const summaries = options.scope === "recent"
      ? this.listRecentCellSummaries({
        procedure: options.procedure,
        limit: options.limit,
      })
      : this.listTopLevelCellSummaries({
        procedure: options.procedure,
        limit: options.limit,
      });

    return summaries.map(toRunSummary);
  }

  getRunAncestors(runRef: RunRef, options: RunAncestorsOptions = {}): RunSummary[] {
    return this.listRunAncestorSummaries(cellRefFromRunRef(runRef), options).map(toRunSummary);
  }

  getRunDescendants(runRef: RunRef, options: RunDescendantsOptions = {}): RunSummary[] {
    return this.listRunDescendantSummaries(cellRefFromRunRef(runRef), options).map(toRunSummary);
  }

  private listRecentCellSummaries(options: RecentOptions = {}): CellSummary[] {
    this.loadExistingCells();
    return this.collectReverseSummaries(this.order, {
      ...options,
      limit: options.limit ?? 10,
    });
  }

  private listRunAncestorSummaries(cellRef: CellRef, options: RunAncestorsOptions = {}): CellSummary[] {
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

  private listRunDescendantSummaries(cellRef: CellRef, options: RunDescendantsOptions = {}): CellSummary[] {
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
        descendants.push(toCellSummary(this.sessionId, record));
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

  private listTopLevelCellSummaries(options: RecentOptions = {}): CellSummary[] {
    this.loadExistingCells();
    return this.collectReverseSummaries(this.topLevelCellIds, options);
  }

  private readCell(cellRef: CellRef): CellRecord {
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

  private toSummaryByCellId(cellId: string): CellSummary {
    const record = this.cells.get(cellId);
    if (!record) {
      throw new Error(`Unknown cell: ${cellId}`);
    }

    return toCellSummary(this.sessionId, record);
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

      summaries.push(toCellSummary(this.sessionId, record));
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

      this.attachments.promotePersistedPromptImages(record.meta.promptImages);
      this.storeCellRecord(record, filePath);
    }
  }

  discardPendingPromptImages(promptImages: CellRecord["meta"]["promptImages"]): void {
    this.attachments.discardPendingPromptImages(promptImages);
  }
}

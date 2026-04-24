import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { writeJsonFileAtomicSync } from "@nanoboss/app-support";
import {
  cellRefFromRunRef,
  createCellRef,
  createValueRef,
  valueRefFromRef,
} from "./ref-store.ts";
import { getSessionDir } from "./paths.ts";
import { publicContinuationFromStored, publicKernelValueFromStored } from "./stored-values.ts";
import type {
  Continuation,
  DownstreamAgentSelection,
  KernelValue,
  PromptImagePart,
  PromptImageSummary,
  PromptInput,
  Ref,
  RefStat,
  RunAncestorsOptions,
  RunDescendantsOptions,
  RunFilterOptions,
  RunKind,
  RunListOptions,
  RunRecord,
  RunRef,
  RunSummary,
} from "@nanoboss/contracts";
import { createRef, createRunRef } from "@nanoboss/contracts";
import { inferDataShape, summarizeText, type ProcedureResult } from "@nanoboss/procedure-sdk";

interface RunDraft {
  run: RunRef;
  procedure: string;
  input: string;
  meta: {
    createdAt: string;
    parentRunId?: string;
    kind: RunKind;
    dispatchCorrelationId?: string;
    defaultAgentSelection?: DownstreamAgentSelection;
    promptImages?: CellRecord["meta"]["promptImages"];
  };
  streamChunks: string[];
}

type CellRef = ReturnType<typeof createCellRef>;
type ValueRef = ReturnType<typeof createValueRef>;

interface CellRecord {
  cellId: string;
  procedure: string;
  input: string;
  output: {
    data?: KernelValue;
    display?: string;
    stream?: string;
    summary?: string;
    memory?: string;
    pause?: Continuation;
    explicitDataSchema?: object;
    agentUpdates?: unknown[];
    replayEvents?: unknown[];
  };
  meta: {
    createdAt: string;
    parentCellId?: string;
    kind: RunKind;
    dispatchCorrelationId?: string;
    defaultAgentSelection?: DownstreamAgentSelection;
    promptImages?: PromptImageSummary[];
  };
}

interface CellSummary {
  cell: CellRef;
  procedure: string;
  kind: RunKind;
  parentCellId?: string;
  summary?: string;
  memory?: string;
  dataRef?: ValueRef;
  displayRef?: ValueRef;
  streamRef?: ValueRef;
  dataShape?: ReturnType<typeof inferDataShape>;
  explicitDataSchema?: object;
  createdAt: string;
}

interface RecentOptions {
  procedure?: string;
  limit?: number;
  excludeCellId?: string;
}

interface CompleteRunOptions {
  display?: string;
  stream?: string;
  summary?: string;
  raw?: string;
  agentUpdates?: unknown[];
  replayEvents?: unknown[];
  meta?: Partial<CellRecord["meta"]>;
}

export interface StoredRunResult<T extends KernelValue = KernelValue> {
  run: RunRef;
  data?: T;
  dataRef?: Ref;
  display?: string;
  displayRef?: Ref;
  streamRef?: Ref;
  memory?: string;
  pause?: Continuation;
  pauseRef?: Ref;
  summary?: string;
  dataShape?: ReturnType<typeof inferDataShape>;
  explicitDataSchema?: object;
  rawRef?: Ref;
}

interface StoredRunRecord extends RunRecord {
  output: Omit<RunRecord["output"], "agentUpdates" | "replayEvents"> & {
    agentUpdates?: unknown[];
    replayEvents?: unknown[];
  };
}

const STALE_ATTACHMENT_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
  private readonly attachmentsDir: string;
  private readonly pendingAttachmentStages = new Map<string, { tempPath: string; refCount: number }>();
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
    this.attachmentsDir = join(this.rootDir, "attachments");
    mkdirSync(this.cellsDir, { recursive: true });
    this.loadExistingCells();
    this.cleanupStaleAttachmentTemps();
  }

  persistPromptImages(input: PromptInput): PromptImageSummary[] | undefined {
    const images = input.parts.filter((part): part is PromptImagePart => part.type === "image");
    if (images.length === 0) {
      return undefined;
    }

    mkdirSync(this.attachmentsDir, { recursive: true });
    return images.map((image) => this.persistPromptImage(image));
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
      this.promotePendingPromptImages(draft.meta.promptImages);
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

      this.promotePersistedPromptImages(record.meta.promptImages);
      this.storeCellRecord(record, filePath);
    }
  }

  private persistPromptImage(image: PromptImagePart): PromptImageSummary {
    const bytes = Buffer.from(image.data, "base64");
    const digest = createHash("sha256")
      .update(image.mimeType)
      .update("\0")
      .update(bytes)
      .digest("hex");
    const extension = fileExtensionForMimeType(image.mimeType);
    const attachmentId = extension ? `${digest}.${extension}` : digest;
    const attachmentPath = `attachments/${attachmentId}`;
    const filePath = join(this.rootDir, attachmentPath);
    const tempPath = buildAttachmentTempPath(filePath);
    const pendingStage = this.pendingAttachmentStages.get(attachmentPath);

    if (!existsSync(filePath)) {
      if (pendingStage && existsSync(pendingStage.tempPath)) {
        pendingStage.refCount += 1;
      } else if (existsSync(tempPath)) {
        this.pendingAttachmentStages.set(attachmentPath, {
          tempPath,
          refCount: 1,
        });
      } else {
        writeFileSync(tempPath, bytes);
        this.pendingAttachmentStages.set(attachmentPath, {
          tempPath,
          refCount: 1,
        });
      }
    }

    return {
      token: image.token,
      mimeType: image.mimeType,
      width: image.width,
      height: image.height,
      byteLength: image.byteLength,
      attachmentId,
      attachmentPath,
    };
  }

  discardPendingPromptImages(promptImages: CellRecord["meta"]["promptImages"]): void {
    for (const image of promptImages ?? []) {
      const attachmentPath = image.attachmentPath;
      if (!attachmentPath) {
        continue;
      }

      const filePath = join(this.rootDir, attachmentPath);
      if (existsSync(filePath)) {
        this.pendingAttachmentStages.delete(attachmentPath);
        continue;
      }

      const stage = this.pendingAttachmentStages.get(attachmentPath);
      if (!stage || !existsSync(stage.tempPath)) {
        continue;
      }

      stage.refCount -= 1;
      if (stage.refCount <= 0) {
        unlinkSync(stage.tempPath);
        this.pendingAttachmentStages.delete(attachmentPath);
      }
    }
  }

  private promotePersistedPromptImages(promptImages: CellRecord["meta"]["promptImages"]): void {
    for (const image of promptImages ?? []) {
      const attachmentPath = image.attachmentPath;
      if (!attachmentPath) {
        continue;
      }

      const filePath = join(this.rootDir, attachmentPath);
      if (existsSync(filePath)) {
        continue;
      }

      const tempPath = buildAttachmentTempPath(filePath);
      if (existsSync(tempPath)) {
        renameSync(tempPath, filePath);
      }
    }
  }

  private promotePendingPromptImages(promptImages: CellRecord["meta"]["promptImages"]): void {
    const promotions = new Map<string, { attachmentPath: string; filePath: string; tempPath: string }>();

    for (const image of promptImages ?? []) {
      const attachmentPath = image.attachmentPath;
      if (!attachmentPath) {
        continue;
      }

      const filePath = join(this.rootDir, attachmentPath);
      if (existsSync(filePath)) {
        this.pendingAttachmentStages.delete(attachmentPath);
        continue;
      }

      const tempPath = buildAttachmentTempPath(filePath);
      if (!existsSync(tempPath)) {
        throw new Error(`Missing staged prompt image attachment: ${attachmentPath}`);
      }

      promotions.set(attachmentPath, { attachmentPath, filePath, tempPath });
    }

    const uniquePromotions = [...promotions.values()];
    const promoted = new Map<string, { attachmentPath: string; filePath: string; tempPath: string }>();
    try {
      for (const promotion of uniquePromotions) {
        renameSync(promotion.tempPath, promotion.filePath);
        promoted.set(promotion.attachmentPath, promotion);
      }
    } catch (error) {
      const promotedEntries = [...promoted.values()];
      for (let index = promotedEntries.length - 1; index >= 0; index -= 1) {
        const promotion = promotedEntries[index];
        if (promotion && existsSync(promotion.filePath) && !existsSync(promotion.tempPath)) {
          renameSync(promotion.filePath, promotion.tempPath);
        }
      }
      throw error;
    }

    for (const promotion of uniquePromotions) {
      this.pendingAttachmentStages.delete(promotion.attachmentPath);
    }
  }

  private cleanupStaleAttachmentTemps(now = Date.now()): void {
    if (!existsSync(this.attachmentsDir)) {
      return;
    }

    for (const entry of readdirSync(this.attachmentsDir)) {
      if (!entry.endsWith(".tmp")) {
        continue;
      }

      const path = join(this.attachmentsDir, entry);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }

      if (now - stats.mtimeMs <= STALE_ATTACHMENT_TEMP_MAX_AGE_MS) {
        continue;
      }

      unlinkSync(path);
    }
  }
}

function fileExtensionForMimeType(mimeType: string): string | undefined {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return undefined;
  }
}

function buildAttachmentTempPath(path: string): string {
  return `${path}.tmp`;
}

function matchesCell(record: CellRecord, options: Pick<RunFilterOptions, "kind" | "procedure">): boolean {
  if (options.kind && record.meta.kind !== options.kind) {
    return false;
  }

  if (options.procedure && record.procedure !== options.procedure) {
    return false;
  }

  return true;
}

function toRunRecord(sessionId: string, record: CellRecord): StoredRunRecord {
  return {
    run: {
      sessionId,
      runId: record.cellId,
    },
    kind: record.meta.kind,
    procedure: record.procedure,
    input: record.input,
    output: {
      data: publicKernelValueFromStored(record.output.data),
      display: record.output.display,
      stream: record.output.stream,
      summary: record.output.summary,
      memory: record.output.memory,
      pause: publicContinuationFromStored(record.output.pause),
      explicitDataSchema: record.output.explicitDataSchema,
      agentUpdates: record.output.agentUpdates,
      replayEvents: record.output.replayEvents,
    },
    meta: {
      createdAt: record.meta.createdAt,
      parentRunId: record.meta.parentCellId,
      dispatchCorrelationId: record.meta.dispatchCorrelationId,
      defaultAgentSelection: record.meta.defaultAgentSelection,
      promptImages: record.meta.promptImages,
    },
  };
}

function toRunSummary(summary: CellSummary): RunSummary {
  return {
    run: createRunRef(summary.cell.sessionId, summary.cell.cellId),
    procedure: summary.procedure,
    kind: summary.kind,
    parentRunId: summary.parentCellId,
    summary: summary.summary,
    memory: summary.memory,
    dataRef: summary.dataRef
      ? createRef(createRunRef(summary.dataRef.cell.sessionId, summary.dataRef.cell.cellId), summary.dataRef.path)
      : undefined,
    displayRef: summary.displayRef
      ? createRef(createRunRef(summary.displayRef.cell.sessionId, summary.displayRef.cell.cellId), summary.displayRef.path)
      : undefined,
    streamRef: summary.streamRef
      ? createRef(createRunRef(summary.streamRef.cell.sessionId, summary.streamRef.cell.cellId), summary.streamRef.path)
      : undefined,
    dataShape: summary.dataShape,
    explicitDataSchema: summary.explicitDataSchema,
    createdAt: summary.createdAt,
  };
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

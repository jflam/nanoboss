import type {
  Continuation,
  DownstreamAgentSelection,
  KernelValue,
  PromptImageSummary,
  Ref,
  RunFilterOptions,
  RunKind,
  RunRecord,
  RunRef,
  RunSummary,
} from "@nanoboss/contracts";
import { createRef, createRunRef } from "@nanoboss/contracts";
import { inferDataShape, summarizeText, type ProcedureResult } from "@nanoboss/procedure-sdk";

import {
  createCellRef,
  createValueRef,
} from "./ref-store.ts";
import { publicContinuationFromStored, publicKernelValueFromStored } from "./stored-values.ts";

export interface RunDraft {
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

export type CellRef = ReturnType<typeof createCellRef>;
export type ValueRef = ReturnType<typeof createValueRef>;

export interface CellRecord {
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

export interface CellSummary {
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

export interface RecentOptions {
  procedure?: string;
  limit?: number;
  excludeCellId?: string;
}

export interface CompleteRunOptions {
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
  rawRef?: ReturnType<typeof createRef>;
}

export interface StoredRunRecord extends RunRecord {
  output: Omit<RunRecord["output"], "agentUpdates" | "replayEvents"> & {
    agentUpdates?: unknown[];
    replayEvents?: unknown[];
  };
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

export function toCellSummary(sessionId: string, record: CellRecord): CellSummary {
  const cell = createCellRef(sessionId, record.cellId);

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

export function matchesCell(record: CellRecord, options: Pick<RunFilterOptions, "kind" | "procedure">): boolean {
  if (options.kind && record.meta.kind !== options.kind) {
    return false;
  }

  if (options.procedure && record.procedure !== options.procedure) {
    return false;
  }

  return true;
}

export function toRunRecord(sessionId: string, record: CellRecord): StoredRunRecord {
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

export function toRunSummary(summary: CellSummary): RunSummary {
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

export function normalizeLimit(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(0, Math.floor(value));
}

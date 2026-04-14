import type { CellRef, ValueRef } from "./store-refs.ts";
import {
  refFromValueRef,
  runRefFromCellRef,
} from "./store-refs.ts";
import type {
  CellKind,
  DownstreamAgentSelection,
  JsonValue,
  KernelValue,
  PersistedFrontendEvent,
  ProcedurePause,
  PromptImageSummary,
  RunRecord,
  RunSummary,
} from "../core/types.ts";
import {
  continuationFromPause,
  publicKernelValueFromStored,
} from "../core/types.ts";

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
    pause?: ProcedurePause;
    explicitDataSchema?: object;
    replayEvents?: PersistedFrontendEvent[];
  };
  meta: {
    createdAt: string;
    parentCellId?: string;
    kind: CellKind;
    dispatchCorrelationId?: string;
    defaultAgentSelection?: DownstreamAgentSelection;
    promptImages?: PromptImageSummary[];
  };
}

export interface CellSummary {
  cell: CellRef;
  procedure: string;
  kind: CellKind;
  parentCellId?: string;
  summary?: string;
  memory?: string;
  dataRef?: ValueRef;
  displayRef?: ValueRef;
  streamRef?: ValueRef;
  dataShape?: JsonValue;
  explicitDataSchema?: object;
  createdAt: string;
}

export function runRecordFromCellRecord(sessionId: string, record: CellRecord): RunRecord {
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
      pause: record.output.pause ? continuationFromPause(record.output.pause) : undefined,
      explicitDataSchema: record.output.explicitDataSchema,
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

export function runSummaryFromCellSummary(summary: CellSummary): RunSummary {
  return {
    run: runRefFromCellRef(summary.cell),
    procedure: summary.procedure,
    kind: summary.kind,
    parentRunId: summary.parentCellId,
    summary: summary.summary,
    memory: summary.memory,
    dataRef: summary.dataRef ? refFromValueRef(summary.dataRef) : undefined,
    displayRef: summary.displayRef ? refFromValueRef(summary.displayRef) : undefined,
    streamRef: summary.streamRef ? refFromValueRef(summary.streamRef) : undefined,
    dataShape: summary.dataShape,
    explicitDataSchema: summary.explicitDataSchema,
    createdAt: summary.createdAt,
  };
}

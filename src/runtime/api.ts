import type { ProcedureExecutionResult } from "../procedure/runner.ts";
import type { ProcedureDispatchStartResult, ProcedureDispatchStatusResult } from "../procedure/dispatch-jobs.ts";
import type {
  CellRef,
  DownstreamAgentSelection,
  ProcedureMetadata,
  ProcedureRegistryLike,
  SessionRecentOptions,
  TopLevelRunsOptions,
  ValueRef,
} from "../core/types.ts";

export interface RuntimeServiceParams {
  sessionId?: string;
  cwd: string;
  rootDir?: string;
  registry?: ProcedureRegistryLike;
  allowCurrentSessionFallback?: boolean;
}

export interface ProcedureListResult {
  procedures: ProcedureMetadata[];
}

export type ProcedureDispatchResult = ProcedureExecutionResult;
export type ProcedureDispatchStartToolResult = ProcedureDispatchStartResult;
export type ProcedureDispatchStatusToolResult = ProcedureDispatchStatusResult;

export interface RuntimeSchemaResult {
  target: CellRef | ValueRef;
  dataShape: unknown;
  explicitDataSchema?: object;
}

export interface RuntimeService {
  sessionRecent(args?: SessionRecentOptions & { sessionId?: string }): unknown;
  topLevelRuns(args?: TopLevelRunsOptions & { sessionId?: string }): unknown;
  cellGet(cellRef: CellRef): unknown;
  cellAncestors(cellRef: CellRef, args?: { includeSelf?: boolean; limit?: number }): unknown;
  cellDescendants(cellRef: CellRef, args?: unknown): unknown;
  refRead(valueRef: ValueRef): unknown;
  refStat(valueRef: ValueRef): unknown;
  refWriteToFile(valueRef: ValueRef, path: string): { path: string };
  getSchema(args: { cellRef?: CellRef; valueRef?: ValueRef }): RuntimeSchemaResult;
  procedureList(args?: { includeHidden?: boolean; sessionId?: string }): Promise<ProcedureListResult>;
  procedureGet(args: { name: string; sessionId?: string }): Promise<ProcedureMetadata>;
  procedureDispatchStart(args: {
    sessionId?: string;
    name: string;
    prompt: string;
    defaultAgentSelection?: DownstreamAgentSelection;
    dispatchCorrelationId?: string;
  }): Promise<ProcedureDispatchStartToolResult>;
  procedureDispatchStatus(args: { dispatchId: string }): Promise<ProcedureDispatchStatusToolResult>;
  procedureDispatchWait(args: { dispatchId: string; waitMs?: number }): Promise<ProcedureDispatchStatusToolResult>;
}

export function isProcedureDispatchStatusResult(value: unknown): value is ProcedureDispatchStatusToolResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { dispatchId?: unknown }).dispatchId === "string" &&
    typeof (value as { procedure?: unknown }).procedure === "string" &&
    typeof (value as { status?: unknown }).status === "string"
  );
}

export function isProcedureDispatchResult(value: unknown): value is ProcedureDispatchResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { procedure?: unknown }).procedure === "string" &&
    isCellRefLike((value as { cell?: unknown }).cell) &&
    typeof (value as { status?: unknown }).status !== "string" &&
    typeof (value as { dispatchId?: unknown }).dispatchId !== "string"
  );
}

function isCellRefLike(value: unknown): value is CellRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { sessionId?: unknown }).sessionId === "string" &&
    typeof (value as { cellId?: unknown }).cellId === "string"
  );
}

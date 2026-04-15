import type { ProcedureDispatchStartResult, ProcedureDispatchStatusResult } from "../procedure/dispatch-jobs.ts";
import type {
  DownstreamAgentSelection,
  ProcedureMetadata,
  ProcedureRegistryLike,
  Ref,
  RunRef,
  RunResult,
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

export type ProcedureDispatchResult = RunResult;
export type ProcedureDispatchStartToolResult = ProcedureDispatchStartResult;
export type ProcedureDispatchStatusToolResult = ProcedureDispatchStatusResult;

export interface RuntimeSchemaResult {
  target: RunRef | Ref;
  dataShape: unknown;
  explicitDataSchema?: object;
}

export interface ListRunsArgs {
  sessionId?: string;
  procedure?: string;
  limit?: number;
  scope?: "recent" | "top_level";
}

export interface RuntimeService {
  listRuns(args?: ListRunsArgs): unknown;
  getRun(runRef: RunRef): unknown;
  getRunAncestors(runRef: RunRef, args?: { includeSelf?: boolean; limit?: number }): unknown;
  getRunDescendants(runRef: RunRef, args?: unknown): unknown;
  readRef(ref: Ref): unknown;
  statRef(ref: Ref): unknown;
  refWriteToFile(ref: Ref, path: string): { path: string };
  getRefSchema(ref: Ref): RuntimeSchemaResult;
  getRunSchema(runRef: RunRef): RuntimeSchemaResult;
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
    isRunRefLike((value as { run?: unknown }).run) &&
    typeof (value as { status?: unknown }).status !== "string" &&
    typeof (value as { dispatchId?: unknown }).dispatchId !== "string" &&
    (
      "summary" in (value as object)
      || "display" in (value as object)
      || "dataRef" in (value as object)
      || "displayRef" in (value as object)
      || "streamRef" in (value as object)
      || "pause" in (value as object)
      || "pauseRef" in (value as object)
      || "rawRef" in (value as object)
    )
  );
}

function isRunRefLike(value: unknown): value is RunRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { sessionId?: unknown }).sessionId === "string" &&
    typeof (value as { runId?: unknown }).runId === "string"
  );
}

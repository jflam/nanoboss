import type { ProcedureDispatchStartResult, ProcedureDispatchStatusResult } from "@nanoboss/procedure-engine";
import type {
  DownstreamAgentSelection,
  Ref,
  RunRef,
} from "@nanoboss/contracts";
import type {
  ProcedureMetadata,
  ProcedureRegistryLike,
  RunResult,
} from "@nanoboss/procedure-sdk";

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

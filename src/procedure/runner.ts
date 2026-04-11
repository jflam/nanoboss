import { CommandContextImpl, type PreparedDefaultPrompt, type SessionUpdateEmitter } from "../core/context.ts";
import {
  RunCancelledError,
  type RunCancellationReason,
  normalizeRunCancelledError,
} from "../core/cancellation.ts";
import type { DefaultConversationSession } from "../agent/default-session.ts";
import type { FrontendEvent } from "../http/frontend-events.ts";
import { RunLogger } from "../core/logger.ts";
import { inferDataShape } from "../core/data-shape.ts";
import { formatErrorMessage } from "../core/error-format.ts";
import {
  type SessionStore,
  createValueRef,
  normalizeProcedureResult,
} from "../session/index.ts";
import { toDownstreamAgentSelection } from "../core/config.ts";
import { appendTimingTraceEvent, type RunTimingTrace } from "../core/timing-trace.ts";
import { summarizeText } from "../util/text.ts";
import type {
  AgentTokenUsage,
  CellRecord,
  CellRef,
  DownstreamAgentConfig,
  DownstreamAgentSelection,
  KernelValue,
  Procedure,
  ProcedurePause,
  ProcedureRegistryLike,
  ValueRef,
} from "../core/types.ts";

export interface ProcedureExecutionResult {
  procedure: string;
  cell: CellRef;
  summary?: string;
  display?: string;
  memory?: string;
  dataRef?: ValueRef;
  displayRef?: ValueRef;
  streamRef?: ValueRef;
  pause?: ProcedurePause;
  pauseRef?: ValueRef;
  dataShape?: unknown;
  explicitDataSchema?: object;
  tokenUsage?: AgentTokenUsage;
  defaultAgentSelection?: DownstreamAgentSelection;
}

export interface ProcedureRunnerEmitter extends SessionUpdateEmitter {
  readonly currentTokenUsage?: AgentTokenUsage;
}

export class TopLevelProcedureExecutionError extends Error {
  constructor(message: string, readonly cell: CellRef) {
    super(message);
    this.name = "TopLevelProcedureExecutionError";
  }
}

export class TopLevelProcedureCancelledError extends RunCancelledError {
  constructor(
    message: string,
    readonly cell: CellRef,
    reason: RunCancellationReason = "soft_stop",
  ) {
    super(message, reason);
    this.name = "TopLevelProcedureCancelledError";
  }
}

export async function executeTopLevelProcedure(params: {
  cwd: string;
  sessionId: string;
  store: SessionStore;
  registry: ProcedureRegistryLike;
  procedure: Procedure;
  prompt: string;
  emitter: ProcedureRunnerEmitter;
  signal?: AbortSignal;
  softStopSignal?: AbortSignal;
  defaultConversation?: DefaultConversationSession;
  getDefaultAgentConfig: () => DownstreamAgentConfig;
  setDefaultAgentSelection: (selection: DownstreamAgentSelection) => DownstreamAgentConfig;
  prepareDefaultPrompt?: (prompt: string) => PreparedDefaultPrompt;
  onError?: (ctx: CommandContextImpl, errorText: string) => void | Promise<void>;
  dispatchCorrelationId?: string;
  assertCanStartBoundary?: () => void;
  timingTrace?: RunTimingTrace;
  resume?: {
    prompt: string;
    state: KernelValue;
  };
}): Promise<ProcedureExecutionResult> {
  const logger = new RunLogger();
  const rootSpanId = logger.newSpan();
  const rootCell = params.store.startCell({
    procedure: params.procedure.name,
    input: params.prompt,
    kind: "top_level",
    dispatchCorrelationId: params.dispatchCorrelationId,
  });
  const beforeSelection = toDownstreamAgentSelection(params.getDefaultAgentConfig());
  const startedAt = Date.now();

  const ctx = new CommandContextImpl({
    cwd: params.cwd,
    sessionId: params.sessionId,
    logger,
    registry: params.registry,
    procedureName: params.procedure.name,
    spanId: rootSpanId,
    emitter: params.emitter,
    store: params.store,
    cell: rootCell,
    signal: params.signal,
    softStopSignal: params.softStopSignal,
    defaultConversation: params.defaultConversation,
    getDefaultAgentConfig: params.getDefaultAgentConfig,
    setDefaultAgentSelection: params.setDefaultAgentSelection,
    prepareDefaultPrompt: params.prepareDefaultPrompt,
    assertCanStartBoundary: params.assertCanStartBoundary,
    timingTrace: params.timingTrace,
  });

  logger.write({
    spanId: rootSpanId,
    procedure: params.procedure.name,
    kind: "procedure_start",
    prompt: params.prompt,
  });
  appendTimingTraceEvent(params.timingTrace, "procedure_runner", "top_level_procedure_started", {
    procedure: params.procedure.name,
  });

  try {
    const rawResult = params.resume
      ? await resumeTopLevelProcedure(params.procedure, params.resume.prompt, params.resume.state, ctx)
      : await params.procedure.execute(params.prompt, ctx);
    const result = normalizeProcedureResult(rawResult);
    const afterSelection = toDownstreamAgentSelection(params.getDefaultAgentConfig());
    const changedSelection = sameSelection(beforeSelection, afterSelection) ? undefined : afterSelection;
    const finalized = params.store.finalizeCell(rootCell, result, {
      meta: changedSelection ? { defaultAgentSelection: changedSelection } : undefined,
    });
    const record = params.store.readCell(finalized.cell);

    logger.write({
      spanId: rootSpanId,
      procedure: params.procedure.name,
      kind: "procedure_end",
      durationMs: Date.now() - startedAt,
      result: result.data,
      raw: result.display,
    });

    return buildProcedureExecutionResult({
      sessionId: params.sessionId,
      cell: record,
      tokenUsage: params.emitter.currentTokenUsage,
      defaultAgentSelection: changedSelection,
    });
  } catch (error) {
    const cancelled = normalizeRunCancelledError(
      error,
      params.softStopSignal?.aborted ? "soft_stop" : "abort",
    );
    if (cancelled) {
      logger.write({
        spanId: rootSpanId,
        procedure: params.procedure.name,
        kind: "procedure_end",
        durationMs: Date.now() - startedAt,
        error: cancelled.message,
      });

      const finalized = params.store.finalizeCell(rootCell, {
        display: cancelled.message,
        summary: summarizeText(cancelled.message),
      });
      throw new TopLevelProcedureCancelledError(cancelled.message, finalized.cell, cancelled.reason);
    }

    const message = formatErrorMessage(error);
    const errorText = `Error: ${message}\n`;

    logger.write({
      spanId: rootSpanId,
      procedure: params.procedure.name,
      kind: "procedure_end",
      durationMs: Date.now() - startedAt,
      error: message,
    });

    await params.onError?.(ctx, errorText);
    const finalized = params.store.finalizeCell(rootCell, {
      summary: summarizeText(errorText),
    });
    throw new TopLevelProcedureExecutionError(message, finalized.cell);
  } finally {
    await params.emitter.flush();
    logger.close();
  }
}

export function buildProcedureExecutionResult(params: {
  sessionId: string;
  cell: CellRecord;
  tokenUsage?: AgentTokenUsage;
  defaultAgentSelection?: DownstreamAgentSelection;
}): ProcedureExecutionResult {
  const cellRef = { sessionId: params.sessionId, cellId: params.cell.cellId };
  return {
    procedure: params.cell.procedure,
    cell: cellRef,
    summary: params.cell.output.summary,
    display: params.cell.output.display,
    memory: params.cell.output.memory,
    dataRef: params.cell.output.data !== undefined ? createValueRef(cellRef, "output.data") : undefined,
    displayRef: params.cell.output.display !== undefined ? createValueRef(cellRef, "output.display") : undefined,
    streamRef: params.cell.output.stream !== undefined ? createValueRef(cellRef, "output.stream") : undefined,
    pause: params.cell.output.pause,
    pauseRef: params.cell.output.pause !== undefined ? createValueRef(cellRef, "output.pause") : undefined,
    dataShape: params.cell.output.data !== undefined ? inferDataShape(params.cell.output.data) : undefined,
    explicitDataSchema: params.cell.output.explicitDataSchema,
    tokenUsage: params.tokenUsage,
    defaultAgentSelection: params.defaultAgentSelection ?? params.cell.meta.defaultAgentSelection,
  };
}

export function buildRunCompletedEvent(params: {
  runId: string;
  procedure: string;
  result: Pick<ProcedureExecutionResult, "cell" | "summary" | "display">;
  completedAt?: string;
  tokenUsage?: AgentTokenUsage;
}): Extract<FrontendEvent, { type: "run_completed" }> {
  return {
    type: "run_completed",
    runId: params.runId,
    procedure: params.procedure,
    completedAt: params.completedAt ?? new Date().toISOString(),
    cell: params.result.cell,
    summary: params.result.summary,
    display: params.result.display,
    tokenUsage: params.tokenUsage,
  };
}

export function buildRunCancelledEvent(params: {
  runId: string;
  procedure: string;
  message: string;
  cell?: CellRef;
  completedAt?: string;
}): Extract<FrontendEvent, { type: "run_cancelled" }> {
  return {
    type: "run_cancelled",
    runId: params.runId,
    procedure: params.procedure,
    completedAt: params.completedAt ?? new Date().toISOString(),
    message: params.message,
    cell: params.cell,
  };
}

export function buildRunPausedEvent(params: {
  runId: string;
  procedure: string;
  result: Pick<ProcedureExecutionResult, "cell" | "display" | "pause">;
  pausedAt?: string;
  tokenUsage?: AgentTokenUsage;
}): Extract<FrontendEvent, { type: "run_paused" }> {
  if (!params.result.pause) {
    throw new Error("Paused run event requires pause metadata.");
  }

  return {
    type: "run_paused",
    runId: params.runId,
    procedure: params.procedure,
    pausedAt: params.pausedAt ?? new Date().toISOString(),
    cell: params.result.cell,
    question: params.result.pause.question,
    display: params.result.display,
    inputHint: params.result.pause.inputHint,
    suggestedReplies: params.result.pause.suggestedReplies,
    continuationUi: params.result.pause.continuationUi,
    tokenUsage: params.tokenUsage,
  };
}

async function resumeTopLevelProcedure(
  procedure: Procedure,
  prompt: string,
  state: KernelValue,
  ctx: CommandContextImpl,
) {
  if (!procedure.resume) {
    throw new Error(`Procedure /${procedure.name} does not support continuation.`);
  }

  return await procedure.resume(prompt, state, ctx);
}

function sameSelection(
  left: DownstreamAgentSelection | undefined,
  right: DownstreamAgentSelection | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

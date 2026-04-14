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
  promptInputDisplayText,
  promptInputToPlainText,
} from "../core/prompt.ts";
import {
  type SessionStore,
  normalizeProcedureResult,
} from "../session/index.ts";
import { toDownstreamAgentSelection } from "../core/config.ts";
import { appendTimingTraceEvent, type RunTimingTrace } from "../core/timing-trace.ts";
import { summarizeText } from "../util/text.ts";
import type {
  AgentTokenUsage,
  Continuation,
  DownstreamAgentConfig,
  DownstreamAgentSelection,
  KernelValue,
  Procedure,
  ProcedurePause,
  PromptInput,
  ProcedureRegistryLike,
  Ref,
  RunRecord,
  RunRef,
} from "../core/types.ts";
import { createRef, pauseFromContinuation } from "../core/types.ts";

export interface ProcedureExecutionResult {
  procedure: string;
  run: RunRef;
  summary?: string;
  display?: string;
  memory?: string;
  dataRef?: Ref;
  displayRef?: Ref;
  streamRef?: Ref;
  pause?: ProcedurePause;
  pauseRef?: Ref;
  dataShape?: unknown;
  explicitDataSchema?: object;
  tokenUsage?: AgentTokenUsage;
  defaultAgentSelection?: DownstreamAgentSelection;
}

export interface ProcedureRunnerEmitter extends SessionUpdateEmitter {
  readonly currentTokenUsage?: AgentTokenUsage;
}

export class TopLevelProcedureExecutionError extends Error {
  constructor(message: string, readonly run: RunRef) {
    super(message);
    this.name = "TopLevelProcedureExecutionError";
  }
}

export class TopLevelProcedureCancelledError extends RunCancelledError {
  constructor(
    message: string,
    readonly run: RunRef,
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
  promptInput?: PromptInput;
  emitter: ProcedureRunnerEmitter;
  signal?: AbortSignal;
  softStopSignal?: AbortSignal;
  defaultConversation?: DefaultConversationSession;
  getDefaultAgentConfig: () => DownstreamAgentConfig;
  setDefaultAgentSelection: (selection: DownstreamAgentSelection) => DownstreamAgentConfig;
  prepareDefaultPrompt?: (promptInput: PromptInput) => PreparedDefaultPrompt;
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
  const promptInput = params.promptInput;
  const displayPrompt = promptInput ? promptInputDisplayText(promptInput) : params.prompt;
  const plainTextPrompt = promptInput ? promptInputToPlainText(promptInput) : params.prompt;
  const rootCell = params.store.startCell({
    procedure: params.procedure.name,
    input: displayPrompt,
    kind: "top_level",
    dispatchCorrelationId: params.dispatchCorrelationId,
    promptImages: promptInput ? params.store.persistPromptImages(promptInput) : undefined,
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
    promptInput,
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
    prompt: displayPrompt,
  });
  appendTimingTraceEvent(params.timingTrace, "procedure_runner", "top_level_procedure_started", {
    procedure: params.procedure.name,
  });

  try {
    const rawResult = params.resume
      ? await resumeTopLevelProcedure(params.procedure, params.resume.prompt, params.resume.state, ctx)
      : await params.procedure.execute(plainTextPrompt, ctx);
    const result = normalizeProcedureResult(rawResult);
    const afterSelection = toDownstreamAgentSelection(params.getDefaultAgentConfig());
    const changedSelection = sameSelection(beforeSelection, afterSelection) ? undefined : afterSelection;
    const finalized = params.store.finalizeCell(rootCell, result, {
      meta: changedSelection ? { defaultAgentSelection: changedSelection } : undefined,
    });
    const run = params.store.readRun(finalized.run);

    logger.write({
      spanId: rootSpanId,
      procedure: params.procedure.name,
      kind: "procedure_end",
      durationMs: Date.now() - startedAt,
      result: result.data,
      raw: result.display,
    });

    return buildProcedureExecutionResult({
      run,
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
      throw new TopLevelProcedureCancelledError(
        cancelled.message,
        finalized.run,
        cancelled.reason,
      );
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
    throw new TopLevelProcedureExecutionError(message, finalized.run);
  } finally {
    await params.emitter.flush();
    logger.close();
  }
}

export function buildProcedureExecutionResult(params: {
  run: RunRecord;
  tokenUsage?: AgentTokenUsage;
  defaultAgentSelection?: DownstreamAgentSelection;
}): ProcedureExecutionResult {
  const pause = procedurePauseFromRunPause(params.run.output.pause);
  return {
    procedure: params.run.procedure,
    run: params.run.run,
    summary: params.run.output.summary,
    display: params.run.output.display,
    memory: params.run.output.memory,
    dataRef: params.run.output.data !== undefined
      ? createRef(params.run.run, "output.data")
      : undefined,
    displayRef: params.run.output.display !== undefined
      ? createRef(params.run.run, "output.display")
      : undefined,
    streamRef: params.run.output.stream !== undefined
      ? createRef(params.run.run, "output.stream")
      : undefined,
    pause,
    pauseRef: pause !== undefined
      ? createRef(params.run.run, "output.pause")
      : undefined,
    dataShape: params.run.output.data !== undefined ? inferDataShape(params.run.output.data) : undefined,
    explicitDataSchema: params.run.output.explicitDataSchema,
    tokenUsage: params.tokenUsage,
    defaultAgentSelection: params.defaultAgentSelection ?? params.run.meta.defaultAgentSelection,
  };
}

function procedurePauseFromRunPause(pause: Continuation | undefined): ProcedurePause | undefined {
  return pause ? pauseFromContinuation(pause) : undefined;
}

export function buildRunCompletedEvent(params: {
  runId: string;
  procedure: string;
  result: Pick<ProcedureExecutionResult, "run" | "summary" | "display">;
  completedAt?: string;
  tokenUsage?: AgentTokenUsage;
}): Extract<FrontendEvent, { type: "run_completed" }> {
  return {
    type: "run_completed",
    runId: params.runId,
    procedure: params.procedure,
    completedAt: params.completedAt ?? new Date().toISOString(),
    run: params.result.run,
    summary: params.result.summary,
    display: params.result.display,
    tokenUsage: params.tokenUsage,
  };
}

export function buildRunCancelledEvent(params: {
  runId: string;
  procedure: string;
  message: string;
  run?: RunRef;
  completedAt?: string;
}): Extract<FrontendEvent, { type: "run_cancelled" }> {
  return {
    type: "run_cancelled",
    runId: params.runId,
    procedure: params.procedure,
    completedAt: params.completedAt ?? new Date().toISOString(),
    message: params.message,
    run: params.run,
  };
}

export function buildRunPausedEvent(params: {
  runId: string;
  procedure: string;
  result: Pick<ProcedureExecutionResult, "run" | "display" | "pause">;
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
    run: params.result.run,
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

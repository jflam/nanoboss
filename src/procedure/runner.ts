import { CommandContextImpl, type PreparedDefaultPrompt, type SessionUpdateEmitter } from "../core/context.ts";
import {
  RunCancelledError,
  type RunCancellationReason,
  normalizeRunCancelledError,
} from "../core/cancellation.ts";
import type { FrontendEvent } from "../http/frontend-events.ts";
import { RunLogger } from "../core/logger.ts";
import { formatErrorMessage } from "../core/error-format.ts";
import { runResultFromRunRecord } from "../core/run-result.ts";
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
  AgentSession,
  AgentTokenUsage,
  Continuation,
  DownstreamAgentConfig,
  DownstreamAgentSelection,
  KernelValue,
  Procedure,
  PromptInput,
  ProcedureRegistryLike,
  RunRecord,
  RunResult,
  RunRef,
} from "../core/types.ts";

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
  agentSession?: AgentSession;
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
}): Promise<RunResult> {
  const logger = new RunLogger();
  const rootSpanId = logger.newSpan();
  const promptInput = params.promptInput;
  const displayPrompt = promptInput ? promptInputDisplayText(promptInput) : params.prompt;
  const plainTextPrompt = promptInput ? promptInputToPlainText(promptInput) : params.prompt;
  const rootRun = params.store.startRun({
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
    run: rootRun,
    promptInput,
    signal: params.signal,
    softStopSignal: params.softStopSignal,
    agentSession: params.agentSession,
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
    const finalized = params.store.completeRun(rootRun, result, {
      meta: changedSelection ? { defaultAgentSelection: changedSelection } : undefined,
    });
    const run = params.store.getRun(finalized.run);

    logger.write({
      spanId: rootSpanId,
      procedure: params.procedure.name,
      kind: "procedure_end",
      durationMs: Date.now() - startedAt,
      result: result.data,
      raw: result.display,
    });

    return runResultFromRunRecord(run, {
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

      const finalized = params.store.completeRun(rootRun, {
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
    const finalized = params.store.completeRun(rootRun, {
      summary: summarizeText(errorText),
    });
    throw new TopLevelProcedureExecutionError(message, finalized.run);
  } finally {
    await params.emitter.flush();
    logger.close();
  }
}

export function buildRunCompletedEvent(params: {
  runId: string;
  procedure: string;
  result: Pick<RunResult, "run" | "summary" | "display">;
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
  result: Pick<RunResult, "run" | "display" | "pause">;
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
    ui: params.result.pause.ui,
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

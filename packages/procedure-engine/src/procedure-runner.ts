import { CommandContextImpl } from "./context/context.ts";
import { assertProcedureSupportsResume } from "@nanoboss/procedure-catalog";
import {
  type SessionStore,
  normalizeProcedureResult,
} from "@nanoboss/store";
import type {
  DownstreamAgentSelection,
  KernelValue,
  PromptInput,
  RunRef,
} from "@nanoboss/contracts";
import type {
  Procedure,
  ProcedureCancelContext,
  ProcedureRegistryLike,
  RunResult,
} from "@nanoboss/procedure-sdk";
import {
  toDownstreamAgentSelection,
} from "@nanoboss/agent-acp";
import {
  RunCancelledError,
  formatErrorMessage,
  promptInputDisplayText,
  promptInputToPlainText,
  summarizeText,
  throwIfCancelled,
  toCancelledError,
  type RunCancellationReason,
} from "@nanoboss/procedure-sdk";
import type { RuntimeBindings, SessionUpdateEmitter } from "./context/shared.ts";
import { RunLogger } from "./logger.ts";
import { runResultFromRunRecord } from "./run-result.ts";
import { appendTimingTraceEvent, type RunTimingTrace } from "@nanoboss/app-support";

export class ProcedureExecutionError extends Error {
  constructor(message: string, readonly run: RunRef) {
    super(message);
    this.name = "ProcedureExecutionError";
  }
}

export class ProcedureCancelledError extends RunCancelledError {
  constructor(
    message: string,
    readonly run: RunRef,
    reason: RunCancellationReason = "soft_stop",
  ) {
    super(message, reason);
    this.name = "ProcedureCancelledError";
  }
}

export interface ExecuteProcedureParams {
  cwd: string;
  sessionId: string;
  store: SessionStore;
  registry: ProcedureRegistryLike;
  procedure: Procedure;
  prompt: string;
  promptInput?: PromptInput;
  emitter: SessionUpdateEmitter;
  signal?: AbortSignal;
  softStopSignal?: AbortSignal;
  bindings: RuntimeBindings;
  isAutoApproveEnabled?: () => boolean;
  onError?: (ctx: CommandContextImpl, errorText: string) => void | Promise<void>;
  dispatchCorrelationId?: string;
  assertCanStartBoundary?: () => void;
  timingTrace?: RunTimingTrace;
  resume?: {
    prompt: string;
    state: KernelValue;
  };
}

export async function executeProcedure(params: ExecuteProcedureParams): Promise<RunResult> {
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
  const beforeSelection = toDownstreamAgentSelection(params.bindings.getDefaultAgentConfig());
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
    current: params.bindings,
    root: params.bindings,
    isAutoApproveEnabled: params.isAutoApproveEnabled,
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
    throwIfCancelled(params);
    const rawResult = params.resume
      ? await resumeProcedureExecution(params.procedure, params.resume.prompt, params.resume.state, ctx)
      : await params.procedure.execute(plainTextPrompt, ctx);
    throwIfCancelled(params);
    const result = normalizeProcedureResult(rawResult);
    const afterSelection = toDownstreamAgentSelection(params.bindings.getDefaultAgentConfig());
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
    const cancelled = toCancelledError(error, params);
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
      throw new ProcedureCancelledError(
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
    throw new ProcedureExecutionError(message, finalized.run);
  } finally {
    await params.emitter.flush();
    logger.close();
  }
}

async function resumeProcedureExecution(
  procedure: Procedure,
  prompt: string,
  state: KernelValue,
  ctx: CommandContextImpl,
) {
  assertProcedureSupportsResume(procedure);
  return await procedure.resume(prompt, state, ctx);
}

/**
 * Invokes a procedure's optional `cancel` hook with the supplied paused state.
 * The hook is advisory-only: any error it throws is captured and returned but
 * never prevents the caller from emitting `run_cancelled`. Callers should
 * route a returned error into their existing error-reporting path.
 */
export async function runProcedureCancelHook(
  procedure: Procedure,
  state: KernelValue,
  ctx: ProcedureCancelContext,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  if (!procedure.cancel) {
    return { ok: true };
  }
  try {
    await procedure.cancel(state, ctx);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function sameSelection(
  left: DownstreamAgentSelection | undefined,
  right: DownstreamAgentSelection | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

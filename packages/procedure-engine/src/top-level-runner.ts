import { CommandContextImpl, type PreparedDefaultPrompt, type SessionUpdateEmitter } from "./context/context.ts";
import {
  type SessionStore,
  normalizeProcedureResult,
} from "@nanoboss/store";
import type { AgentSession } from "@nanoboss/agent-acp";
import type {
  AgentTokenUsage,
  DownstreamAgentConfig,
  DownstreamAgentSelection,
  KernelValue,
  PromptInput,
  RunRef,
} from "@nanoboss/contracts";
import type {
  Procedure,
  ProcedureRegistryLike,
  RunResult,
} from "@nanoboss/procedure-sdk";
import {
  promptInputDisplayText,
  promptInputToPlainText,
} from "@nanoboss/procedure-sdk";

import { toDownstreamAgentSelection } from "./agent-config.ts";
import {
  RunCancelledError,
  type RunCancellationReason,
  normalizeRunCancelledError,
} from "./cancellation.ts";
import { formatErrorMessage } from "./error-format.ts";
import { RunLogger } from "./logger.ts";
import { runResultFromRunRecord } from "./run-result.ts";
import { summarizeText } from "./text.ts";
import { appendTimingTraceEvent, type RunTimingTrace } from "./timing-trace.ts";

interface ProcedureRunnerEmitter extends SessionUpdateEmitter {
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
  isAutoApproveEnabled?: () => boolean;
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
    isAutoApproveEnabled: params.isAutoApproveEnabled,
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

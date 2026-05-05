import type * as acp from "@agentclientprotocol/sdk";
import {
  normalizeAgentTokenUsage,
  toDownstreamAgentSelection,
} from "@nanoboss/agent-acp";
import {
  appendTimingTraceEvent,
  createRunTimingTrace,
  type RunTimingTrace,
} from "@nanoboss/app-support";
import {
  createTextPromptInput,
  RunCancelledError,
  defaultCancellationMessage,
  formatErrorMessage,
  hasPromptInputContent,
  hasPromptInputImages,
  normalizeRunCancelledError,
  normalizePromptInput,
  promptInputAttachmentSummaries,
  promptInputDisplayText,
} from "@nanoboss/procedure-sdk";
import { resolveDownstreamAgentConfig } from "@nanoboss/procedure-engine";

import { buildMcpProcedureDispatchPrompt } from "./agent-runtime-instructions.ts";
import {
  SessionEventLog,
  toRuntimeCommands,
} from "./runtime-events.ts";
import { readStoredSessionMetadata } from "@nanoboss/store";
import {
  executeProcedure,
  procedureDispatchResultFromRecoveredRun,
  type RuntimeBindings,
  runProcedureCancelHook,
  type SessionUpdateEmitter,
  startProcedureDispatchProgressBridge,
  ProcedureCancelledError,
  ProcedureExecutionError,
  waitForRecoveredProcedureDispatchRun,
} from "@nanoboss/procedure-engine";
import { CompositeSessionUpdateEmitter } from "./composite-session-update-emitter.ts";
import {
  cancelActiveProcedureDispatches,
  waitForProcedureDispatchResult,
} from "./procedure-dispatch-manager.ts";
import {
  publishRunCancelled,
  publishRunCompleted,
  publishRunFailed,
  publishRunPaused,
} from "./run-publication.ts";
import { ProcedureRegistry } from "@nanoboss/procedure-catalog";
import { shouldLoadDiskCommands } from "./runtime-mode.ts";
import {
  createActiveRunState,
  type ActiveRunState,
  startRunHeartbeat,
} from "./active-run.ts";
import {
  buildAvailableCommands,
  buildPendingContinuation,
  createDismissContinuationProcedure,
  DISMISS_CONTINUATION_COMMAND_NAME,
  resolveCommand,
  toRuntimeContinuation,
} from "./continuations.ts";
import { prepareDefaultPrompt } from "./default-agent-policy.ts";
import {
  capturePersistedRuntimeEvents,
  restorePersistedSessionHistory,
} from "./replay.ts";
import {
  extractProcedureDispatchFailure,
  extractProcedureDispatchId,
  extractProcedureDispatchResult,
} from "./procedure-dispatch-result.ts";
import type { AgentTokenUsage } from "@nanoboss/contracts";
import {
  buildSessionDescriptor,
  createSessionState,
  persistSessionState,
  type RuntimeSessionDescriptor,
  type SessionState,
} from "./session-runtime.ts";
import type {
  DownstreamAgentConfig,
  DownstreamAgentSelection,
  PendingContinuation,
  PromptInput,
  RunRef,
  RunResult,
} from "@nanoboss/procedure-sdk";

export class NanobossService {
  private readonly sessions = new Map<acp.SessionId, SessionState>();

  constructor(
    private readonly registry: ProcedureRegistry,
    private readonly resolveDefaultAgentConfig: (
      cwd: string,
      selection?: DownstreamAgentSelection,
    ) => DownstreamAgentConfig = resolveDownstreamAgentConfig,
  ) {}

  static async create(): Promise<NanobossService> {
    const registry = new ProcedureRegistry();
    registry.loadBuiltins();
    if (shouldLoadDiskCommands()) {
      await registry.loadFromDisk();
    }
    return new NanobossService(registry);
  }

  getAvailableCommands(): acp.AvailableCommand[] {
    return buildAvailableCommands(this.registry);
  }

  createSession(params: {
    cwd: string;
    autoApprove?: boolean;
    defaultAgentSelection?: DownstreamAgentSelection;
    sessionId?: string;
  }): RuntimeSessionDescriptor {
    const sessionId = params.sessionId ?? crypto.randomUUID();
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session already exists: ${sessionId}`);
    }

    const state = createSessionState({
      sessionId,
      cwd: params.cwd,
      commands: mapAvailableCommands(this.registry),
      resolveDefaultAgentConfig: this.resolveDefaultAgentConfig,
      autoApprove: params.autoApprove,
      defaultAgentSelection: params.defaultAgentSelection,
    });

    this.sessions.set(sessionId, state);
    persistSessionState(state);
    state.events.publish(sessionId, {
      type: "commands_updated",
      commands: state.commands,
    });
    this.publishPendingContinuation(sessionId, state);

    return buildSessionDescriptor(sessionId, state);
  }

  async createSessionReady(
    params: {
      cwd: string;
      autoApprove?: boolean;
      defaultAgentSelection?: DownstreamAgentSelection;
      sessionId?: string;
    },
  ): Promise<RuntimeSessionDescriptor> {
    const session = this.createSession(params);
    return await this.awaitDefaultConversationWarm(session.sessionId);
  }

  resumeSession(params: {
    sessionId: string;
    cwd?: string;
    autoApprove?: boolean;
    defaultAgentSelection?: DownstreamAgentSelection;
  }): RuntimeSessionDescriptor {
    const existing = this.sessions.get(params.sessionId);
    if (existing) {
      if (params.autoApprove !== undefined) {
        existing.autoApprove = params.autoApprove;
      }
      persistSessionState(existing);
      return buildSessionDescriptor(params.sessionId, existing);
    }

    const stored = readStoredSessionMetadata(params.sessionId);
    const cwd = stored?.cwd || params.cwd;
    if (!cwd) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }

    const state = createSessionState({
      sessionId: params.sessionId,
      cwd,
      commands: mapAvailableCommands(this.registry),
      resolveDefaultAgentConfig: this.resolveDefaultAgentConfig,
      defaultAgentSelection: params.defaultAgentSelection ?? stored?.defaultAgentSelection,
      defaultAgentSessionId: stored?.defaultAgentSessionId,
      autoApprove: params.autoApprove ?? stored?.autoApprove,
      pendingContinuation: stored?.pendingContinuation,
    });
    restorePersistedSessionHistory({
      sessionId: params.sessionId,
      store: state.store,
      events: state.events,
    });

    this.sessions.set(params.sessionId, state);
    persistSessionState(state);
    state.events.publish(params.sessionId, {
      type: "commands_updated",
      commands: state.commands,
    });
    this.publishPendingContinuation(params.sessionId, state);

    return buildSessionDescriptor(params.sessionId, state);
  }

  async resumeSessionReady(params: {
    sessionId: string;
    cwd?: string;
    autoApprove?: boolean;
    defaultAgentSelection?: DownstreamAgentSelection;
  }): Promise<RuntimeSessionDescriptor> {
    const session = this.resumeSession(params);
    return await this.awaitDefaultConversationWarm(session.sessionId);
  }

  getSession(sessionId: string): RuntimeSessionDescriptor | undefined {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return undefined;
    }

    return buildSessionDescriptor(sessionId, state);
  }

  private async awaitDefaultConversationWarm(sessionId: string): Promise<RuntimeSessionDescriptor> {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    await state.defaultAgentSession.warm?.();
    persistSessionState(state);
    return buildSessionDescriptor(sessionId, state);
  }

  setSessionAutoApprove(sessionId: string, enabled: boolean): RuntimeSessionDescriptor {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    session.autoApprove = enabled;
    persistSessionState(session);
    return buildSessionDescriptor(sessionId, session);
  }

  private publishPendingContinuation(sessionId: string, session: SessionState): void {
    session.events.publish(sessionId, {
      type: "continuation_updated",
      continuation: toRuntimeContinuation(session.pendingContinuation),
    });
  }

  private setPendingContinuation(
    sessionId: string,
    session: SessionState,
    continuation?: PendingContinuation,
  ): void {
    session.pendingContinuation = continuation;
    this.publishPendingContinuation(sessionId, session);
  }

  getSessionEvents(sessionId: string): SessionEventLog | undefined {
    return this.sessions.get(sessionId)?.events;
  }

  cancel(sessionId: string, runId?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    const activeRun = session.activeRun;
    if (!activeRun) {
      // No active run: a soft-stop while paused is treated as a continuation
      // cancel so form-esc and ctrl+c both route through a single terminal
      // transition.
      if (session.pendingContinuation) {
        void this.requestContinuationCancel(sessionId);
      }
      return;
    }

    if ((runId && activeRun.runId !== runId) || activeRun.softStopRequested) {
      return;
    }

    activeRun.softStopRequested = true;
    activeRun.softStopController.abort();
    cancelActiveProcedureDispatches(sessionId, session, activeRun);
  }

  /**
   * Engine-authoritative cancel for a paused continuation. Invokes the
   * procedure's optional `cancel` hook (best-effort cleanup, cannot veto),
   * emits `run_cancelled` for the paused run, and clears
   * `pendingContinuation`. Returns `true` when a paused run was cancelled;
   * `false` when no continuation was pending (no-op).
   */
  async requestContinuationCancel(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    const pending = session.pendingContinuation;
    if (!pending) {
      return false;
    }

    const procedure = this.registry.get(pending.procedure);
    const cancelResult = procedure
      ? await runProcedureCancelHook(procedure, pending.state, {
          sessionId,
          cwd: session.cwd,
        })
      : { ok: true as const };

    if (!cancelResult.ok) {
      const message = formatErrorMessage(cancelResult.error);
      session.events.publish(sessionId, {
        type: "procedure_panel",
        runId: pending.run.runId,
        procedure: pending.procedure,
        panelId: `panel-${pending.run.runId}-cancel-error`,
        rendererId: "nb/error@1",
        payload: {
          procedure: pending.procedure,
          message: `cancelling /${pending.procedure}: ${message}`,
        },
        severity: "error",
        dismissible: false,
      });
    }

    const cancellationMessage = defaultCancellationMessage("soft_stop");
    publishRunCancelled({
      session,
      sessionId,
      runId: pending.run.runId,
      procedure: pending.procedure,
      message: cancellationMessage,
      markRunActivity: () => {},
      run: pending.run,
    });
    this.setPendingContinuation(sessionId, session, undefined);
    persistSessionState(session);
    return true;
  }

  destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    cancelActiveProcedureDispatches(sessionId, session, session.activeRun);
    session.activeRun?.abortController.abort();
    session.activeRun?.softStopController.abort();
    session.defaultAgentSession.close();
    this.sessions.delete(sessionId);
  }

  private prepareDefaultPrompt(
    session: SessionState,
    promptInput: PromptInput,
    runId: string,
    timingTrace?: RunTimingTrace,
  ) {
    return prepareDefaultPrompt(session, promptInput, runId, timingTrace);
  }

  private async dispatchProcedureIntoDefaultConversation(
    session: SessionState,
    procedureName: string,
    procedurePrompt: string,
    emitter: CompositeSessionUpdateEmitter,
    timingTrace: RunTimingTrace,
    options: {
      dispatchCorrelationId: string;
      signal?: AbortSignal;
      softStopSignal?: AbortSignal;
      assertCanStartBoundary?: () => void;
      activeRun?: ActiveRunState;
    },
  ): Promise<{ result: RunResult; tokenUsage?: AgentTokenUsage }> {
    const dispatchCorrelationId = options.dispatchCorrelationId;
    options.activeRun?.dispatchCorrelationIds.add(dispatchCorrelationId);
    appendTimingTraceEvent(timingTrace, "service", "dispatch_via_default_started", {
      procedure: procedureName,
      dispatchCorrelationId,
    });
    const stopProgressBridge = startProcedureDispatchProgressBridge(
      session.store.rootDir,
      dispatchCorrelationId,
      emitter,
    );

    try {
      options.assertCanStartBoundary?.();
      let sawDefaultPromptUpdate = false;
      appendTimingTraceEvent(timingTrace, "service", "default_dispatch_prompt_started", {
        procedure: procedureName,
      });
      const promptResult = await session.defaultAgentSession.prompt(
        createTextPromptInput(buildMcpProcedureDispatchPrompt(
          session.store.sessionId,
          procedureName,
          procedurePrompt,
          toDownstreamAgentSelection(session.defaultAgentConfig),
          dispatchCorrelationId,
        )),
        {
          signal: options.signal,
          softStopSignal: options.softStopSignal,
          timingTrace,
          onUpdate: async (update) => {
            if (!sawDefaultPromptUpdate) {
              sawDefaultPromptUpdate = true;
              appendTimingTraceEvent(timingTrace, "service", "default_dispatch_prompt_first_update", {
                updateType: update.sessionUpdate,
              });
            }
            if (
              update.sessionUpdate === "agent_message_chunk" ||
              update.sessionUpdate === "tool_call" ||
              update.sessionUpdate === "tool_call_update" ||
              update.sessionUpdate === "usage_update"
            ) {
              emitter.emit(update);
            }
          },
        },
      );
      appendTimingTraceEvent(timingTrace, "service", "default_dispatch_prompt_completed", {
        updateCount: promptResult.updates.length,
      });

      const result = extractProcedureDispatchResult(promptResult.updates);
      if (result) {
        appendTimingTraceEvent(timingTrace, "service", "dispatch_result_extracted_from_prompt", {
          procedure: procedureName,
        });
        session.syncedProcedureMemoryRunIds.add(result.run.runId);
        return {
          result,
          tokenUsage: normalizeAgentTokenUsage(
            promptResult.tokenSnapshot ?? await session.defaultAgentSession.getCurrentTokenSnapshot(),
            session.defaultAgentConfig,
          ),
        };
      }

      const dispatchId = extractProcedureDispatchId(promptResult.updates);
      if (dispatchId) {
        appendTimingTraceEvent(timingTrace, "service", "dispatch_id_received", {
          dispatchId,
        });
      }

      const dispatchStatus = await waitForProcedureDispatchResult({
        registry: this.registry,
        session,
        promptUpdates: promptResult.updates,
        signal: options.signal,
        softStopSignal: options.softStopSignal,
      });
      if (dispatchStatus) {
        appendTimingTraceEvent(timingTrace, "service", "dispatch_wait_completed", {
          dispatchId: dispatchStatus.dispatchId,
          status: dispatchStatus.status,
        });
      }
      if (dispatchStatus?.status === "completed" && dispatchStatus.result) {
        session.syncedProcedureMemoryRunIds.add(dispatchStatus.result.run.runId);
        return {
          result: dispatchStatus.result,
          tokenUsage: normalizeAgentTokenUsage(
            promptResult.tokenSnapshot ?? await session.defaultAgentSession.getCurrentTokenSnapshot(),
            session.defaultAgentConfig,
          ),
        };
      }
      if (dispatchStatus?.status === "cancelled") {
        throw new RunCancelledError(
          dispatchStatus.error?.trim() || defaultCancellationMessage("soft_stop"),
          "soft_stop",
        );
      }
      if (dispatchStatus?.status === "failed") {
        throw new Error(
          dispatchStatus.error?.trim() || `Default session async dispatch failed for /${procedureName}.`,
        );
      }

      const recoveredRun = await waitForRecoveredProcedureDispatchRun(session.store, {
        procedureName,
        dispatchCorrelationId,
        signal: options.signal,
        softStopSignal: options.softStopSignal,
      });
      if (recoveredRun) {
        appendTimingTraceEvent(timingTrace, "service", "dispatch_result_recovered_from_store", {
          procedure: procedureName,
          runId: recoveredRun.run.runId,
        });
        return {
          result: procedureDispatchResultFromRecoveredRun(recoveredRun),
          tokenUsage: normalizeAgentTokenUsage(
            promptResult.tokenSnapshot ?? await session.defaultAgentSession.getCurrentTokenSnapshot(),
            session.defaultAgentConfig,
          ),
        };
      }

      const failureMessage = extractProcedureDispatchFailure(promptResult.updates);
      throw new Error(
        failureMessage
          ? `Default session did not complete async dispatch for /${procedureName}: ${failureMessage}`
          : `Default session did not complete async dispatch for /${procedureName}.`,
      );
    } finally {
      options.activeRun?.dispatchCorrelationIds.delete(dispatchCorrelationId);
      await stopProgressBridge();
    }
  }

  private applyDefaultAgentSelection(
    session: SessionState,
    selection: DownstreamAgentSelection | undefined,
  ): void {
    if (!selection) {
      return;
    }

    const currentSelection = toDownstreamAgentSelection(session.defaultAgentConfig);
    if (JSON.stringify(currentSelection) === JSON.stringify(selection)) {
      return;
    }

    const nextConfig = this.resolveDefaultAgentConfig(session.cwd, selection);
    session.defaultAgentConfig = nextConfig;
    session.defaultAgentSession.updateConfig(nextConfig);
    persistSessionState(session, { preserveDefaultAcpSessionId: false });
  }

  async promptSession(
    sessionId: string,
    promptText: string | PromptInput,
    delegate?: SessionUpdateEmitter,
  ): Promise<{ stopReason: "end_turn"; runId: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    const promptInput = normalizePromptInput(promptText);
    if (!hasPromptInputContent(promptInput)) {
      throw new Error("prompt is required");
    }

    cancelActiveProcedureDispatches(sessionId, session, session.activeRun);
    session.activeRun?.abortController.abort();
    session.activeRun?.softStopController.abort();

    const displayPrompt = promptInputDisplayText(promptInput);
    const { commandName, commandPrompt, commandPromptInput, continuation } = resolveCommand(
      promptInput,
      session.pendingContinuation,
    );
    const procedure = commandName === DISMISS_CONTINUATION_COMMAND_NAME
      ? createDismissContinuationProcedure(session)
      : this.registry.get(commandName);
    const procedureName = procedure?.name ?? commandName;
    const activeRun = createActiveRunState();
    session.activeRun = activeRun;
    const runId = activeRun.runId;
    const directTimingTrace = procedure
      ? createRunTimingTrace(session.store.rootDir, runId)
      : undefined;
    appendTimingTraceEvent(directTimingTrace, "service", "submit_received", {
      runId,
      procedure: procedureName,
      promptLength: promptInputDisplayText(commandPromptInput).length,
      mode: continuation ? "resume" : "direct",
    });
    const startedAt = Date.now();
    const assertCanStartBoundary = () => {
      if (activeRun.softStopRequested) {
        throw new RunCancelledError(defaultCancellationMessage("soft_stop"), "soft_stop");
      }

      if (activeRun.abortController.signal.aborted) {
        throw new RunCancelledError(defaultCancellationMessage("abort"), "abort");
      }
    };
    let persistedTopLevelRun: RunRef | undefined;
    const replayCapture = capturePersistedRuntimeEvents(session.events, runId);
    const heartbeat = startRunHeartbeat({
      eventLog: session.events,
      sessionId,
      runId,
      procedure: procedureName,
    });
    const { markRunActivity } = heartbeat;

    session.events.publish(sessionId, {
      type: "run_started",
      runId,
      procedure: procedureName,
      prompt: promptInputDisplayText(commandPromptInput),
      startedAt: new Date(startedAt).toISOString(),
    });
    markRunActivity();
    const emitter = new CompositeSessionUpdateEmitter(
      sessionId,
      runId,
      procedureName,
      session.events,
      markRunActivity,
      delegate,
    );

    try {
      if (hasPromptInputImages(commandPromptInput) && procedureName !== "default") {
        const error = `Image prompts are currently only supported for /default. /${procedureName} cannot accept images yet.`;
        delegate?.emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `${error}\n`,
          },
        });
        await emitter.flush();
        publishRunFailed({
          session,
          sessionId,
          runId,
          procedure: procedureName,
          error,
          markRunActivity,
        });
        return { stopReason: "end_turn", runId };
      }

      if (!procedure) {
        const error = continuation
          ? `Pending continuation for /${commandName} is no longer available.`
          : `Unknown command: /${commandName}`;
        if (continuation) {
          this.setPendingContinuation(sessionId, session, undefined);
        }
        delegate?.emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `${error}\n`,
          },
        });
        await emitter.flush();

        publishRunFailed({
          session,
          sessionId,
          runId,
          procedure: procedureName,
          error,
          markRunActivity,
        });

        return { stopReason: "end_turn", runId };
      }

      if (continuation && !procedure.resume) {
        const error = `Procedure /${procedure.name} does not support continuation.`;
        this.setPendingContinuation(sessionId, session, undefined);
        delegate?.emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `${error}\n`,
          },
        });
        await emitter.flush();

        publishRunFailed({
          session,
          sessionId,
          runId,
          procedure: procedure.name,
          error,
          markRunActivity,
        });

        return { stopReason: "end_turn", runId };
      }

      try {
        const timingTrace = directTimingTrace;
        const bindings = {
          agentSession: session.defaultAgentSession,
          getDefaultAgentConfig: () => session.defaultAgentConfig,
          setDefaultAgentSelection: (selection) => {
            const nextConfig = this.resolveDefaultAgentConfig(session.cwd, selection);
            session.defaultAgentConfig = nextConfig;
            session.defaultAgentSession.updateConfig(nextConfig);
            return nextConfig;
          },
          prepareDefaultPrompt: (prompt) => prepareDefaultPrompt(session, prompt, runId, timingTrace),
        } satisfies RuntimeBindings;
        appendTimingTraceEvent(timingTrace, "service", "prompt_started", {
          runId,
          procedure: procedure.name,
          mode: continuation ? "resume" : "direct",
        });
        const result = await executeProcedure({
          cwd: session.cwd,
          sessionId,
          store: session.store,
          registry: this.registry,
          procedure,
          prompt: commandPrompt,
          promptInput: commandPromptInput,
          emitter,
          signal: activeRun.abortController.signal,
          softStopSignal: activeRun.softStopController.signal,
          bindings,
          isAutoApproveEnabled: () => session.autoApprove,
          onError: (ctx, errorText) => {
            ctx.ui.text(errorText);
          },
          assertCanStartBoundary,
          timingTrace,
          resume: continuation
            ? {
                prompt: commandPrompt,
                state: continuation.state,
              }
            : undefined,
        });

        if (result.pause) {
          this.setPendingContinuation(
            sessionId,
            session,
            buildPendingContinuation(procedure.name, result),
          );
          publishRunPaused({
            session,
            sessionId,
            runId,
            procedure: procedure.name,
            result,
            tokenUsage: result.tokenUsage,
            emitter,
            markRunActivity,
            applyDefaultAgentSelection: (selection) => this.applyDefaultAgentSelection(session, selection),
          });
        } else {
          if (continuation) {
            this.setPendingContinuation(sessionId, session, undefined);
          } else if (procedure.name === DISMISS_CONTINUATION_COMMAND_NAME) {
            this.setPendingContinuation(sessionId, session, undefined);
          }
          publishRunCompleted({
            session,
            sessionId,
            runId,
            procedure: procedure.name,
            result,
            tokenUsage: result.tokenUsage,
            emitter,
            markRunActivity,
            applyDefaultAgentSelection: (selection) => this.applyDefaultAgentSelection(session, selection),
          });
        }
        persistedTopLevelRun = result.run;
      } catch (error) {
        if (error instanceof ProcedureExecutionError) {
          publishRunFailed({
            session,
            sessionId,
            runId,
            procedure: procedure.name,
            error: error.message,
            run: error.run,
            markRunActivity,
          });
        } else if (error instanceof ProcedureCancelledError) {
          publishRunCancelled({
            session,
            sessionId,
            runId,
            procedure: procedure.name,
            message: error.message,
            run: error.run,
            markRunActivity,
          });
          persistedTopLevelRun = error.run;
        }
        throw error;
      }
    } catch (error) {
      const cancelled = normalizeRunCancelledError(
        error,
        activeRun.softStopRequested ? "soft_stop" : "abort",
      );
      const message = cancelled?.message ?? formatErrorMessage(error);
      if (!emitter.hasAnyStreamedText) {
        emitter.emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: cancelled ? `${message}\n` : `Error: ${message}\n`,
          },
        });
      }

      if (cancelled && !(error instanceof ProcedureCancelledError)) {
        publishRunCancelled({
          session,
          sessionId,
          runId,
          procedure: procedureName,
          message,
          markRunActivity,
        });
      } else if (!cancelled && !(error instanceof ProcedureExecutionError)) {
        publishRunFailed({
          session,
          sessionId,
          runId,
          procedure: procedureName,
          error: message,
          markRunActivity,
        });
      }
    } finally {
      heartbeat.stop();
      const availableCommands = buildAvailableCommands(this.registry);
      const commands = mapAvailableCommands(availableCommands);
      session.commands = commands;
      session.events.publish(sessionId, {
        type: "commands_updated",
        commands,
      });
      delegate?.emit({
        sessionUpdate: "available_commands_update",
        availableCommands,
      });
      await emitter.flush();
      replayCapture.stop();
      if (persistedTopLevelRun && replayCapture.replayEvents.length > 0) {
        session.store.patchRun(persistedTopLevelRun, {
          output: {
            replayEvents: replayCapture.replayEvents,
          },
        });
      }
      persistSessionState(session, { prompt: displayPrompt });
      if (session.activeRun === activeRun) {
        session.activeRun = undefined;
      }
    }

    return { stopReason: "end_turn", runId };
  }
}

function mapAvailableCommands(
  registryOrCommands: ProcedureRegistry | acp.AvailableCommand[],
): SessionState["commands"] {
  const availableCommands = Array.isArray(registryOrCommands)
    ? registryOrCommands
    : buildAvailableCommands(registryOrCommands);
  return toRuntimeCommands(availableCommands);
}

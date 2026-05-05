import type * as acp from "@agentclientprotocol/sdk";
import {
  toDownstreamAgentSelection,
} from "@nanoboss/agent-acp";
import {
  appendTimingTraceEvent,
  type RunTimingTrace,
} from "@nanoboss/app-support";
import {
  formatErrorMessage,
  hasPromptInputContent,
  hasPromptInputImages,
  normalizeRunCancelledError,
  normalizePromptInput,
  promptInputAttachmentSummaries,
  promptInputDisplayText,
} from "@nanoboss/procedure-sdk";
import { resolveDownstreamAgentConfig } from "@nanoboss/procedure-engine";

import {
  SessionEventLog,
} from "./runtime-events.ts";
import { readStoredSessionMetadata } from "@nanoboss/store";
import {
  executeProcedure,
  type SessionUpdateEmitter,
  ProcedureCancelledError,
  ProcedureExecutionError,
} from "@nanoboss/procedure-engine";
import { cancelActiveProcedureDispatches } from "./procedure-dispatch-manager.ts";
import {
  publishRunCancelled,
  publishRunCompleted,
  publishRunFailed,
  publishRunPaused,
} from "./run-publication.ts";
import { ProcedureRegistry } from "@nanoboss/procedure-catalog";
import { shouldLoadDiskCommands } from "./runtime-mode.ts";
import {
  buildAvailableCommands,
  buildPendingContinuation,
  createDismissContinuationProcedure,
  DISMISS_CONTINUATION_COMMAND_NAME,
  publishPendingContinuation,
  resolveCommand,
  setPendingContinuation,
} from "./continuations.ts";
import { requestContinuationCancel as requestContinuationCancelInternal } from "./continuation-cancel.ts";
import {
  applyDefaultAgentSelection as applyDefaultAgentSelectionInternal,
  createProcedureRuntimeBindings,
} from "./procedure-runtime-bindings.ts";
import { prepareDefaultPrompt } from "./default-agent-policy.ts";
import {
  restorePersistedSessionHistory,
} from "./replay.ts";
import { startPromptRun } from "./prompt-run-lifecycle.ts";
import {
  mapRuntimeCommands,
  publishSessionCommands,
  refreshSessionCommands,
} from "./runtime-commands.ts";
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
      commands: mapRuntimeCommands(this.registry),
      resolveDefaultAgentConfig: this.resolveDefaultAgentConfig,
      autoApprove: params.autoApprove,
      defaultAgentSelection: params.defaultAgentSelection,
    });

    this.sessions.set(sessionId, state);
    persistSessionState(state);
    publishSessionCommands(sessionId, state);
    publishPendingContinuation(sessionId, state);

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
      commands: mapRuntimeCommands(this.registry),
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
    publishSessionCommands(params.sessionId, state);
    publishPendingContinuation(params.sessionId, state);

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

    return await requestContinuationCancelInternal({
      session,
      sessionId,
      registry: this.registry,
      setPendingContinuation: (continuation) => {
        setPendingContinuation(sessionId, session, continuation);
      },
    });
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

  private applyDefaultAgentSelection(
    session: SessionState,
    selection: DownstreamAgentSelection | undefined,
  ): void {
    applyDefaultAgentSelectionInternal({
      session,
      selection,
      resolveDefaultAgentConfig: this.resolveDefaultAgentConfig,
      currentSelection: toDownstreamAgentSelection(session.defaultAgentConfig),
    });
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
    let persistedTopLevelRun: RunRef | undefined;
    const {
      activeRun,
      runId,
      timingTrace,
      assertCanStartBoundary,
      replayCapture,
      heartbeat,
      markRunActivity,
      emitter,
    } = startPromptRun({
      sessionId,
      session,
      procedureName,
      commandPromptInput,
      hasProcedure: Boolean(procedure),
      mode: continuation ? "resume" : "direct",
      delegate,
    });

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
          setPendingContinuation(sessionId, session, undefined);
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
        setPendingContinuation(sessionId, session, undefined);
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
        const bindings = createProcedureRuntimeBindings({
          session,
          runId,
          timingTrace,
          resolveDefaultAgentConfig: this.resolveDefaultAgentConfig,
        });
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
          setPendingContinuation(
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
            setPendingContinuation(sessionId, session, undefined);
          } else if (procedure.name === DISMISS_CONTINUATION_COMMAND_NAME) {
            setPendingContinuation(sessionId, session, undefined);
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
      const availableCommands = refreshSessionCommands({
        sessionId,
        session,
        registry: this.registry,
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

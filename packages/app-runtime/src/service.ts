import type * as acp from "@agentclientprotocol/sdk";
import {
  normalizeAgentTokenUsage,
} from "@nanoboss/agent-acp";
import {
  createTextPromptInput,
  hasPromptInputContent,
  hasPromptInputImages,
  normalizePromptInput,
  promptInputAttachmentSummaries,
  promptInputDisplayText,
} from "@nanoboss/procedure-sdk";

import { buildMcpProcedureDispatchPrompt } from "./agent-runtime-instructions.ts";
import { resolveDownstreamAgentConfig, toDownstreamAgentSelection } from "../../../src/core/config.ts";
import { materializeProcedureMemoryCard } from "./memory-cards.ts";
import {
  mapProcedureUiEventToRuntimeEvent,
  mapSessionUpdateToRuntimeEvents,
  SessionEventLog,
  toRuntimeCommands,
} from "./runtime-events.ts";
import { readStoredSessionMetadata } from "@nanoboss/store";
import {
  appendTimingTraceEvent,
  createRunTimingTrace,
  defaultCancellationMessage,
  formatErrorMessage,
  normalizeRunCancelledError,
  ProcedureDispatchJobManager,
  type ProcedureUiEvent,
  type ProcedureDispatchStatusResult,
  procedureDispatchResultFromRecoveredRun,
  RunCancelledError,
  type RunTimingTrace,
  resumeProcedure,
  runProcedure,
  type SessionUpdateEmitter,
  startProcedureDispatchProgressBridge,
  TopLevelProcedureCancelledError,
  TopLevelProcedureExecutionError,
  waitForRecoveredProcedureDispatchRun,
} from "@nanoboss/procedure-engine";
import {
  buildRunCancelledEvent,
  buildRunCompletedEvent,
  buildRunPausedEvent,
} from "./run-events.ts";
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
import { isProcedureDispatchResult, isProcedureDispatchStatusResult } from "./runtime-api.ts";
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

class CompositeSessionUpdateEmitter implements SessionUpdateEmitter {
  private streamedText = "";
  private latestTokenUsage?: AgentTokenUsage;

  constructor(
    private readonly sessionId: string,
    private readonly runId: string,
    private readonly eventLog: SessionEventLog,
    private readonly onActivity: () => void,
    private readonly delegate?: SessionUpdateEmitter,
  ) {}

  emit(update: acp.SessionUpdate): void {
    this.onActivity();

    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      this.streamedText += update.content.text;
    }

    for (const event of mapSessionUpdateToRuntimeEvents(this.runId, update)) {
      if (event.type === "token_usage") {
        this.latestTokenUsage = event.usage;
      }
      this.eventLog.publish(this.sessionId, event);
    }

    this.delegate?.emit(update);
  }

  emitUiEvent(event: ProcedureUiEvent): void {
    this.onActivity();
    this.eventLog.publish(this.sessionId, mapProcedureUiEventToRuntimeEvent(this.runId, event));
  }

  get currentTokenUsage(): AgentTokenUsage | undefined {
    return this.latestTokenUsage;
  }

  hasStreamedText(text: string): boolean {
    return this.streamedText === text;
  }

  get hasAnyStreamedText(): boolean {
    return this.streamedText.length > 0;
  }

  flush(): Promise<void> {
    return this.delegate?.flush() ?? Promise.resolve();
  }
}

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
    const activeRun = session?.activeRun;
    if (!activeRun) {
      return;
    }

    if ((runId && activeRun.runId !== runId) || activeRun.softStopRequested) {
      return;
    }

    activeRun.softStopRequested = true;
    activeRun.softStopController.abort();
    this.cancelActiveProcedureDispatches(sessionId, session, activeRun);
  }

  destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    this.cancelActiveProcedureDispatches(sessionId, session, session.activeRun);
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

      const dispatchStatus = await this.waitForProcedureDispatchResult({
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

  private cancelActiveProcedureDispatches(
    sessionId: string,
    session: SessionState,
    activeRun: ActiveRunState | undefined,
  ): void {
    if (!activeRun || activeRun.dispatchCorrelationIds.size === 0) {
      return;
    }

    const manager = new ProcedureDispatchJobManager({
      cwd: session.cwd,
      sessionId,
      rootDir: session.store.rootDir,
      getRegistry: async () => {
        throw new Error("Procedure registry is unavailable during cancellation.");
      },
    });

    for (const dispatchCorrelationId of activeRun.dispatchCorrelationIds) {
      manager.cancelByCorrelationId(dispatchCorrelationId);
    }
  }

  private async waitForProcedureDispatchResult(params: {
    session: SessionState;
    promptUpdates: acp.SessionUpdate[];
    signal?: AbortSignal;
    softStopSignal?: AbortSignal;
  }): Promise<ProcedureDispatchStatusResult | undefined> {
    const dispatchId = extractProcedureDispatchId(params.promptUpdates);
    if (!dispatchId) {
      return undefined;
    }

    const manager = this.createProcedureDispatchManager(params.session);
    let latest = extractProcedureDispatchStatus(params.promptUpdates) ?? await manager.status(dispatchId);
    while (latest.status === "queued" || latest.status === "running") {
      if (params.softStopSignal?.aborted) {
        throw new RunCancelledError(defaultCancellationMessage("soft_stop"), "soft_stop");
      }
      if (params.signal?.aborted) {
        throw new RunCancelledError(defaultCancellationMessage("abort"), "abort");
      }

      latest = await manager.wait(dispatchId, 1_000);
    }

    return latest;
  }

  private createProcedureDispatchManager(session: SessionState): ProcedureDispatchJobManager {
    return new ProcedureDispatchJobManager({
      cwd: session.cwd,
      sessionId: session.store.sessionId,
      rootDir: session.store.rootDir,
      getRegistry: async () => this.registry,
    });
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

  private emitDisplayIfNeeded(
    emitter: CompositeSessionUpdateEmitter,
    display: string | undefined,
  ): void {
    if (!display || emitter.hasStreamedText(display)) {
      return;
    }

    emitter.emit({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: display,
      },
    });
  }

  private publishRunCompleted(params: {
    session: SessionState;
    sessionId: string;
    runId: string;
    procedure: string;
    result: RunResult;
    tokenUsage?: AgentTokenUsage;
    emitter: CompositeSessionUpdateEmitter;
    markRunActivity: () => void;
  }): void {
    this.applyDefaultAgentSelection(params.session, params.result.defaultAgentSelection);
    this.emitDisplayIfNeeded(params.emitter, params.result.display);
    publishStoredMemoryCard(params.session, params.sessionId, params.runId, params.result.run);
    if (params.tokenUsage) {
      params.session.events.publish(params.sessionId, {
        type: "token_usage",
        runId: params.runId,
        usage: params.tokenUsage,
        sourceUpdate: "run_completed",
      });
    }
    params.session.events.publish(
      params.sessionId,
      buildRunCompletedEvent({
        runId: params.runId,
        procedure: params.procedure,
        result: params.result,
        tokenUsage: params.tokenUsage,
      }),
    );
    params.markRunActivity();
  }

  private publishRunPaused(params: {
    session: SessionState;
    sessionId: string;
    runId: string;
    procedure: string;
    result: RunResult;
    tokenUsage?: AgentTokenUsage;
    emitter: CompositeSessionUpdateEmitter;
    markRunActivity: () => void;
  }): void {
    this.applyDefaultAgentSelection(params.session, params.result.defaultAgentSelection);
    this.emitDisplayIfNeeded(
      params.emitter,
      params.result.display ?? params.result.pause?.question,
    );
    publishStoredMemoryCard(params.session, params.sessionId, params.runId, params.result.run);
    if (params.tokenUsage) {
      params.session.events.publish(params.sessionId, {
        type: "token_usage",
        runId: params.runId,
        usage: params.tokenUsage,
        sourceUpdate: "run_paused",
      });
    }
    params.session.events.publish(
      params.sessionId,
      buildRunPausedEvent({
        runId: params.runId,
        procedure: params.procedure,
        result: params.result,
        tokenUsage: params.tokenUsage,
      }),
    );
    params.markRunActivity();
  }

  private publishRunFailed(params: {
    session: SessionState;
    sessionId: string;
    runId: string;
    procedure: string;
    error: string;
    markRunActivity: () => void;
    run?: RunRef;
  }): void {
    params.session.events.publish(params.sessionId, {
      type: "run_failed",
      runId: params.runId,
      procedure: params.procedure,
      completedAt: new Date().toISOString(),
      error: params.error,
      run: params.run,
    });
    params.markRunActivity();
  }

  private publishRunCancelled(params: {
    session: SessionState;
    sessionId: string;
    runId: string;
    procedure: string;
    message: string;
    markRunActivity: () => void;
    run?: RunRef;
  }): void {
    params.session.events.publish(
      params.sessionId,
      buildRunCancelledEvent({
        runId: params.runId,
        procedure: params.procedure,
        message: params.message,
        run: params.run,
      }),
    );
    params.markRunActivity();
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

    this.cancelActiveProcedureDispatches(sessionId, session, session.activeRun);
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
        this.publishRunFailed({
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

        this.publishRunFailed({
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

        this.publishRunFailed({
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
        appendTimingTraceEvent(timingTrace, "service", "prompt_started", {
          runId,
          procedure: procedure.name,
          mode: continuation ? "resume" : "direct",
        });
        const result = await (continuation ? resumeProcedure({
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
          agentSession: session.defaultAgentSession,
          getDefaultAgentConfig: () => session.defaultAgentConfig,
          setDefaultAgentSelection: (selection) => {
            const nextConfig = this.resolveDefaultAgentConfig(session.cwd, selection);
            session.defaultAgentConfig = nextConfig;
            session.defaultAgentSession.updateConfig(nextConfig);
            return nextConfig;
          },
          isAutoApproveEnabled: () => session.autoApprove,
          prepareDefaultPrompt: (prompt) => prepareDefaultPrompt(session, prompt, runId, timingTrace),
          onError: (ctx, errorText) => {
            ctx.ui.text(errorText);
          },
          assertCanStartBoundary,
          timingTrace,
          state: continuation.state,
        }) : runProcedure({
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
          agentSession: session.defaultAgentSession,
          getDefaultAgentConfig: () => session.defaultAgentConfig,
          setDefaultAgentSelection: (selection) => {
            const nextConfig = this.resolveDefaultAgentConfig(session.cwd, selection);
            session.defaultAgentConfig = nextConfig;
            session.defaultAgentSession.updateConfig(nextConfig);
            return nextConfig;
          },
          isAutoApproveEnabled: () => session.autoApprove,
          prepareDefaultPrompt: (prompt) => prepareDefaultPrompt(session, prompt, runId, timingTrace),
          onError: (ctx, errorText) => {
            ctx.ui.text(errorText);
          },
          assertCanStartBoundary,
          timingTrace,
        }));

        if (result.pause) {
          this.setPendingContinuation(
            sessionId,
            session,
            buildPendingContinuation(procedure.name, result),
          );
          this.publishRunPaused({
            session,
            sessionId,
            runId,
            procedure: procedure.name,
            result,
            tokenUsage: result.tokenUsage,
            emitter,
            markRunActivity,
          });
        } else {
          if (continuation) {
            this.setPendingContinuation(sessionId, session, undefined);
          } else if (procedure.name === DISMISS_CONTINUATION_COMMAND_NAME) {
            this.setPendingContinuation(sessionId, session, undefined);
          }
          this.publishRunCompleted({
            session,
            sessionId,
            runId,
            procedure: procedure.name,
            result,
            tokenUsage: result.tokenUsage,
            emitter,
            markRunActivity,
          });
        }
        persistedTopLevelRun = result.run;
      } catch (error) {
        if (error instanceof TopLevelProcedureExecutionError) {
          this.publishRunFailed({
            session,
            sessionId,
            runId,
            procedure: procedure.name,
            error: error.message,
            run: error.run,
            markRunActivity,
          });
        } else if (error instanceof TopLevelProcedureCancelledError) {
          this.publishRunCancelled({
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

      if (cancelled && !(error instanceof TopLevelProcedureCancelledError)) {
        this.publishRunCancelled({
          session,
          sessionId,
          runId,
          procedure: procedureName,
          message,
          markRunActivity,
        });
      } else if (!cancelled && !(error instanceof TopLevelProcedureExecutionError)) {
        this.publishRunFailed({
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

function publishStoredMemoryCard(
  session: SessionState,
  sessionId: string,
  runId: string,
  runRef?: RunRef,
): void {
  if (!runRef) {
    return;
  }

  const storedMemoryCard = materializeProcedureMemoryCard(session.store, runRef);
  if (!storedMemoryCard) {
    return;
  }

  session.events.publish(sessionId, {
    type: "memory_card_stored",
    runId,
    card: storedMemoryCard,
  });
}

function mapAvailableCommands(
  registryOrCommands: ProcedureRegistry | acp.AvailableCommand[],
): SessionState["commands"] {
  const availableCommands = Array.isArray(registryOrCommands)
    ? registryOrCommands
    : buildAvailableCommands(registryOrCommands);
  return toRuntimeCommands(availableCommands);
}

export function extractProcedureDispatchResult(updates: acp.SessionUpdate[]): RunResult | undefined {
  for (const update of [...updates].reverse()) {
    if (update.sessionUpdate !== "tool_call_update" || update.status !== "completed") {
      continue;
    }

    for (const candidate of collectProcedureDispatchCandidates(update)) {
      const parsed = parseProcedureDispatchResultCandidate(candidate);
      if (parsed) {
        return parsed;
      }
    }
  }

  return undefined;
}

function extractProcedureDispatchId(updates: acp.SessionUpdate[]): string | undefined {
  for (const update of [...updates].reverse()) {
    if (update.sessionUpdate !== "tool_call_update") {
      continue;
    }

    for (const candidate of collectProcedureDispatchCandidates(update)) {
      const parsed = parseProcedureDispatchIdCandidate(candidate);
      if (parsed) {
        return parsed;
      }
    }
  }

  return undefined;
}

function extractProcedureDispatchStatus(updates: acp.SessionUpdate[]): ProcedureDispatchStatusResult | undefined {
  for (const update of [...updates].reverse()) {
    if (update.sessionUpdate !== "tool_call_update") {
      continue;
    }

    for (const candidate of collectProcedureDispatchCandidates(update)) {
      const parsed = parseProcedureDispatchStatusCandidate(candidate);
      if (parsed) {
        return parsed;
      }
    }
  }

  return undefined;
}

function collectProcedureDispatchCandidates(update: Extract<acp.SessionUpdate, { sessionUpdate: "tool_call_update" }>): unknown[] {
  const rawOutput = update.rawOutput;
  const candidates: unknown[] = [rawOutput];

  if (rawOutput && typeof rawOutput === "object") {
    candidates.push((rawOutput as { structuredContent?: unknown }).structuredContent);
    candidates.push((rawOutput as { content?: unknown }).content);
    candidates.push((rawOutput as { detailedContent?: unknown }).detailedContent);
    candidates.push((rawOutput as { contents?: unknown }).contents);
  }

  if ("content" in update) {
    candidates.push((update as { content?: unknown }).content);
  }

  return candidates;
}

function parseProcedureDispatchResultCandidate(value: unknown): RunResult | undefined {
  if (isProcedureDispatchResult(value)) {
    return value;
  }

  if (isProcedureDispatchStatusResult(value) && value.status === "completed" && value.result) {
    return value.result;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parseProcedureDispatchResultCandidate(parsed);
    } catch {
      return undefined;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = parseProcedureDispatchResultCandidate(item);
      if (parsed) {
        return parsed;
      }
    }
    return undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const contentText = (value as { text?: unknown }).text;
  if (typeof contentText === "string") {
    const parsed = parseProcedureDispatchResultCandidate(contentText);
    if (parsed) {
      return parsed;
    }
  }

  const nestedContent = (value as { content?: unknown }).content;
  if (nestedContent !== undefined) {
    const parsed = parseProcedureDispatchResultCandidate(nestedContent);
    if (parsed) {
      return parsed;
    }
  }

  const nestedResult = (value as { result?: unknown }).result;
  if (nestedResult !== undefined) {
    const parsed = parseProcedureDispatchResultCandidate(nestedResult);
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}

function parseProcedureDispatchIdCandidate(value: unknown): string | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof value === "string") {
    try {
      return parseProcedureDispatchIdCandidate(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = parseProcedureDispatchIdCandidate(item);
      if (parsed) {
        return parsed;
      }
    }
    return undefined;
  }

  if (typeof value !== "object") {
    return undefined;
  }

  const dispatchId = (value as { dispatchId?: unknown }).dispatchId;
  if (typeof dispatchId === "string" && dispatchId.trim()) {
    return dispatchId;
  }

  const contentText = (value as { text?: unknown }).text;
  if (typeof contentText === "string") {
    const parsed = parseProcedureDispatchIdCandidate(contentText);
    if (parsed) {
      return parsed;
    }
  }

  const nestedContent = (value as { content?: unknown }).content;
  if (nestedContent !== undefined) {
    const parsed = parseProcedureDispatchIdCandidate(nestedContent);
    if (parsed) {
      return parsed;
    }
  }

  const nestedResult = (value as { result?: unknown }).result;
  if (nestedResult !== undefined) {
    const parsed = parseProcedureDispatchIdCandidate(nestedResult);
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}

function parseProcedureDispatchStatusCandidate(value: unknown): ProcedureDispatchStatusResult | undefined {
  if (isProcedureDispatchStatusResult(value)) {
    return value;
  }

  if (typeof value === "string") {
    try {
      return parseProcedureDispatchStatusCandidate(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = parseProcedureDispatchStatusCandidate(item);
      if (parsed) {
        return parsed;
      }
    }
    return undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const contentText = (value as { text?: unknown }).text;
  if (typeof contentText === "string") {
    const parsed = parseProcedureDispatchStatusCandidate(contentText);
    if (parsed) {
      return parsed;
    }
  }

  const nestedContent = (value as { content?: unknown }).content;
  if (nestedContent !== undefined) {
    const parsed = parseProcedureDispatchStatusCandidate(nestedContent);
    if (parsed) {
      return parsed;
    }
  }

  const nestedResult = (value as { result?: unknown }).result;
  if (nestedResult !== undefined) {
    const parsed = parseProcedureDispatchStatusCandidate(nestedResult);
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}

function extractProcedureDispatchFailure(updates: acp.SessionUpdate[]): string | undefined {
  for (const update of [...updates].reverse()) {
    if (update.sessionUpdate !== "tool_call_update") {
      continue;
    }

    const asyncFailure = parseProcedureDispatchFailureCandidate(update.rawOutput);
    if (asyncFailure) {
      return asyncFailure;
    }

    if (update.status !== "failed") {
      continue;
    }

    const rawOutput = update.rawOutput;
    if (!rawOutput || typeof rawOutput !== "object") {
      continue;
    }

    const message = (rawOutput as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }

    const error = (rawOutput as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) {
      return error.trim();
    }
  }

  return undefined;
}

function parseProcedureDispatchFailureCandidate(value: unknown): string | undefined {
  if (isProcedureDispatchStatusResult(value) && (value.status === "failed" || value.status === "cancelled")) {
    return value.error?.trim() || `${value.procedure} ${value.status}`;
  }

  if (typeof value === "string") {
    try {
      return parseProcedureDispatchFailureCandidate(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = parseProcedureDispatchFailureCandidate(item);
      if (parsed) {
        return parsed;
      }
    }
    return undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const nestedContent = (value as { content?: unknown }).content;
  if (nestedContent !== undefined) {
    const parsed = parseProcedureDispatchFailureCandidate(nestedContent);
    if (parsed) {
      return parsed;
    }
  }

  const nestedText = (value as { text?: unknown }).text;
  if (typeof nestedText === "string") {
    const parsed = parseProcedureDispatchFailureCandidate(nestedText);
    if (parsed) {
      return parsed;
    }
  }

  const nestedResult = (value as { result?: unknown }).result;
  if (nestedResult !== undefined) {
    const parsed = parseProcedureDispatchFailureCandidate(nestedResult);
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}

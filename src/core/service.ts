import type * as acp from "@agentclientprotocol/sdk";

import { buildMcpProcedureDispatchPrompt } from "./agent-runtime-instructions.ts";
import { getBuildLabel } from "./build-info.ts";
import { RunCancelledError, defaultCancellationMessage, normalizeRunCancelledError } from "./cancellation.ts";
import { resolveDownstreamAgentConfig, toDownstreamAgentSelection } from "./config.ts";
import { type SessionUpdateEmitter } from "./context.ts";
import type { ProcedureUiEvent } from "./context-shared.ts";
import { formatErrorMessage } from "./error-format.ts";
import { DefaultConversationSession } from "../agent/default-session.ts";
import { normalizeAgentTokenUsage } from "../agent/token-usage.ts";
import {
  collectUnsyncedProcedureMemoryCards,
  materializeProcedureMemoryCard,
  renderProcedureMemoryCardsSection,
} from "./memory-cards.ts";
import {
  mapProcedureUiEventToFrontendEvent,
  mapSessionUpdateToFrontendEvents,
  SessionEventLog,
  toReplayableFrontendEvent,
  toFrontendCommands,
  type FrontendEvent,
  type FrontendCommand,
} from "../http/frontend-events.ts";
import {
  SessionStore,
  readSessionMetadata,
  type SessionMetadata,
  writeSessionMetadata,
} from "../session/index.ts";
import { startProcedureDispatchProgressBridge } from "../procedure/dispatch-progress.ts";
import {
  procedureDispatchResultFromRecoveredCell,
  waitForRecoveredProcedureDispatchCell,
} from "../procedure/dispatch-recovery.ts";
import {
  ProcedureDispatchJobManager,
  type ProcedureDispatchStatusResult,
} from "../procedure/dispatch-jobs.ts";
import {
  buildRunCancelledEvent,
  buildRunCompletedEvent,
  buildRunPausedEvent,
  executeTopLevelProcedure,
  TopLevelProcedureCancelledError,
  TopLevelProcedureExecutionError,
  type ProcedureExecutionResult,
} from "../procedure/runner.ts";
import { ProcedureRegistry, projectProcedureMetadata, toAvailableCommand } from "../procedure/registry.ts";
import { formatAgentBanner } from "./runtime-banner.ts";
import { shouldLoadDiskCommands } from "./runtime-mode.ts";
import { appendTimingTraceEvent, createRunTimingTrace, type RunTimingTrace } from "./timing-trace.ts";
import { isProcedureDispatchResult, isProcedureDispatchStatusResult } from "../runtime/api.ts";
import type {
  AgentTokenUsage,
  DownstreamAgentConfig,
  DownstreamAgentSelection,
  FrontendPendingProcedureContinuation,
  PendingProcedureContinuation,
  PersistedFrontendEvent,
  Procedure,
  ProcedureRegistryLike,
} from "./types.ts";

interface ActiveRunState {
  runId: string;
  abortController: AbortController;
  softStopController: AbortController;
  softStopRequested: boolean;
  dispatchCorrelationIds: Set<string>;
}

interface SessionState {
  cwd: string;
  store: SessionStore;
  events: SessionEventLog;
  defaultAgentConfig: DownstreamAgentConfig;
  defaultConversation: DefaultConversationSession;
  syncedProcedureMemoryCellIds: Set<string>;
  recentRecoverySyncAtMs?: number;
  activeRun?: ActiveRunState;
  commands: FrontendCommand[];
  pendingProcedureContinuation?: PendingProcedureContinuation;
}

export interface SessionDescriptor {
  sessionId: string;
  cwd: string;
  commands: FrontendCommand[];
  buildLabel: string;
  agentLabel: string;
  defaultAgentSelection?: DownstreamAgentSelection;
}

const DISMISS_CONTINUATION_COMMAND_NAME = "dismiss";
const DISMISS_CONTINUATION_COMMAND: acp.AvailableCommand = {
  name: DISMISS_CONTINUATION_COMMAND_NAME,
  description: "Clear the pending paused continuation",
};

const SESSION_TOOL_GUIDANCE = [
  "Nanoboss session tool guidance:",
  "- For prior stored procedure results, prefer the global `nanoboss` MCP tools over filesystem inspection.",
  "- Use top_level_runs(...) to find prior chat-visible commands such as /default, /linter, or /second-opinion.",
  "- Use cell_descendants(...) to inspect nested procedure and agent calls under one run; set maxDepth=1 when you only want direct children.",
  "- Use cell_ancestors(...) to identify which top-level run owns a nested cell; set limit=1 when you only want the direct parent.",
  "- After you find a candidate cell, use cell_get(...) for exact metadata and ref_read(...) for exact stored values.",
  "- If ref_read(...) returns nested refs such as critique or answer, call ref_read(...) on those refs too.",
  "- Use session_recent(...) only for true global recency scans across the whole session; it is not the primary retrieval path.",
  "- Do not treat not-found results from a bounded scan as proof of absence unless the search scope was exhaustive.",
  "- Never inspect ~/.nanoboss/agent-logs directly; active transcript files can recurse into the current run.",
  "- If filesystem fallback is unavoidable, scope it to a specific session path such as ~/.nanoboss/sessions/<sessionId> or current-sessions.json; never scan ~/.nanoboss broadly.",
  "- Do not inspect ~/.nanoboss/sessions directly unless the nanoboss MCP tools fail.",
].join("\n");

function renderSessionToolGuidance(): string {
  return SESSION_TOOL_GUIDANCE;
}

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

    for (const event of mapSessionUpdateToFrontendEvents(this.runId, update)) {
      if (event.type === "token_usage") {
        this.latestTokenUsage = event.usage;
      }
      this.eventLog.publish(this.sessionId, event);
    }

    this.delegate?.emit(update);
  }

  emitUiEvent(event: ProcedureUiEvent): void {
    this.onActivity();
    this.eventLog.publish(this.sessionId, mapProcedureUiEventToFrontendEvent(this.runId, event));
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

  createSession(params: { cwd: string; defaultAgentSelection?: DownstreamAgentSelection; sessionId?: string }): SessionDescriptor {
    const sessionId = params.sessionId ?? crypto.randomUUID();
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session already exists: ${sessionId}`);
    }

    const state = this.createSessionState({
      sessionId,
      cwd: params.cwd,
      defaultAgentSelection: params.defaultAgentSelection,
    });

    this.sessions.set(sessionId, state);
    this.persistSessionState(state);
    state.events.publish(sessionId, {
      type: "commands_updated",
      commands: state.commands,
    });
    this.publishPendingProcedureContinuation(sessionId, state);

    return this.buildSessionDescriptor(sessionId, state);
  }

  async createSessionReady(
    params: { cwd: string; defaultAgentSelection?: DownstreamAgentSelection; sessionId?: string },
  ): Promise<SessionDescriptor> {
    const session = this.createSession(params);
    return await this.awaitDefaultConversationWarm(session.sessionId);
  }

  resumeSession(params: {
    sessionId: string;
    cwd?: string;
    defaultAgentSelection?: DownstreamAgentSelection;
  }): SessionDescriptor {
    const existing = this.sessions.get(params.sessionId);
    if (existing) {
      this.persistSessionState(existing);
      return this.buildSessionDescriptor(params.sessionId, existing);
    }

    const stored = readSessionMetadata(params.sessionId);
    const cwd = stored?.cwd || params.cwd;
    if (!cwd) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }

    const state = this.createSessionState({
      sessionId: params.sessionId,
      cwd,
      defaultAgentSelection: params.defaultAgentSelection ?? stored?.defaultAgentSelection,
      defaultAcpSessionId: stored?.defaultAcpSessionId,
      pendingProcedureContinuation: stored?.pendingProcedureContinuation,
    });
    this.restorePersistedSessionHistory(params.sessionId, state);

    this.sessions.set(params.sessionId, state);
    this.persistSessionState(state);
    state.events.publish(params.sessionId, {
      type: "commands_updated",
      commands: state.commands,
    });
    this.publishPendingProcedureContinuation(params.sessionId, state);

    return this.buildSessionDescriptor(params.sessionId, state);
  }

  async resumeSessionReady(params: {
    sessionId: string;
    cwd?: string;
    defaultAgentSelection?: DownstreamAgentSelection;
  }): Promise<SessionDescriptor> {
    const session = this.resumeSession(params);
    return await this.awaitDefaultConversationWarm(session.sessionId);
  }

  getSession(sessionId: string): SessionDescriptor | undefined {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return undefined;
    }

    return this.buildSessionDescriptor(sessionId, state);
  }

  private async awaitDefaultConversationWarm(sessionId: string): Promise<SessionDescriptor> {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    await state.defaultConversation.warm();
    this.persistSessionState(state);
    return this.buildSessionDescriptor(sessionId, state);
  }

  private createSessionState(params: {
    sessionId: string;
    cwd: string;
    defaultAgentSelection?: DownstreamAgentSelection;
    defaultAcpSessionId?: string;
    pendingProcedureContinuation?: PendingProcedureContinuation;
  }): SessionState {
    const commands = toFrontendCommands(buildAvailableCommands(this.registry));
    const defaultAgentConfig = this.resolveDefaultAgentConfig(params.cwd, params.defaultAgentSelection);
    const store = new SessionStore({
      sessionId: params.sessionId,
      cwd: params.cwd,
    });
    const defaultConversation = new DefaultConversationSession({
      config: defaultAgentConfig,
      persistedSessionId: params.defaultAcpSessionId,
    });
    if (shouldPrewarmDefaultConversation()) {
      void defaultConversation.warm();
    }

    return {
      cwd: params.cwd,
      store,
      events: new SessionEventLog(),
      defaultAgentConfig,
      defaultConversation,
      syncedProcedureMemoryCellIds: new Set(),
      commands,
      pendingProcedureContinuation: params.pendingProcedureContinuation,
    };
  }

  private buildSessionDescriptor(sessionId: string, state: SessionState): SessionDescriptor {
    return {
      sessionId,
      cwd: state.cwd,
      commands: state.commands,
      buildLabel: getBuildLabel(),
      agentLabel: formatAgentBanner(state.defaultAgentConfig),
      defaultAgentSelection: toDownstreamAgentSelection(state.defaultAgentConfig),
    };
  }

  private publishPendingProcedureContinuation(sessionId: string, session: SessionState): void {
    session.events.publish(sessionId, {
      type: "continuation_updated",
      continuation: toFrontendPendingProcedureContinuation(session.pendingProcedureContinuation),
    });
  }

  private setPendingProcedureContinuation(
    sessionId: string,
    session: SessionState,
    continuation?: PendingProcedureContinuation,
  ): void {
    session.pendingProcedureContinuation = continuation;
    this.publishPendingProcedureContinuation(sessionId, session);
  }

  private restorePersistedSessionHistory(sessionId: string, session: SessionState): void {
    const runs = session.store.topLevelRuns().reverse();
    for (const summary of runs) {
      const record = session.store.readCell(summary.cell);
      const replayEvents = record.output.replayEvents;
      const terminalEvent = getRestoredRunTerminalEvent(replayEvents);
      const runId = replayEvents?.[0]?.runId ?? record.cellId;

      session.events.publish(sessionId, {
        type: "run_restored",
        runId,
        procedure: record.procedure,
        prompt: record.input,
        completedAt: getRestoredRunEndedAt(terminalEvent) ?? record.meta.createdAt,
        cell: {
          sessionId,
          cellId: record.cellId,
        },
        status: getRestoredRunStatus(terminalEvent),
        ...(replayEvents && replayEvents.length > 0
          ? {}
          : { text: record.output.display ?? record.output.summary }),
      });

      for (const replayEvent of replayEvents ?? []) {
        session.events.publish(sessionId, replayEvent);
      }
    }
  }

  private persistSessionState(
    session: SessionState,
    options: { prompt?: string; preserveDefaultAcpSessionId?: boolean } = {},
  ): SessionMetadata {
    const existing = readSessionMetadata(session.store.sessionId, session.store.rootDir);
    const defaultAcpSessionId = session.defaultConversation.currentSessionId
      ?? (options.preserveDefaultAcpSessionId === false ? undefined : existing?.defaultAcpSessionId);

    return writeSessionMetadata({
      sessionId: session.store.sessionId,
      cwd: session.cwd,
      rootDir: session.store.rootDir,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      initialPrompt: existing?.initialPrompt ?? options.prompt,
      lastPrompt: options.prompt ?? existing?.lastPrompt,
      defaultAgentSelection: toDownstreamAgentSelection(session.defaultAgentConfig),
      defaultAcpSessionId,
      pendingProcedureContinuation: session.pendingProcedureContinuation,
    });
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
    session.defaultConversation.closeLiveSession();
    this.sessions.delete(sessionId);
  }

  private prepareDefaultPrompt(
    session: SessionState,
    prompt: string,
    runId: string,
    timingTrace?: RunTimingTrace,
  ): { prompt: string; markSubmitted: () => void } {
    appendTimingTraceEvent(timingTrace, "service", "prepare_default_prompt_started", {
      runId,
      promptLength: prompt.length,
    });
    const cards = collectUnsyncedProcedureMemoryCards(
      session.store,
      session.syncedProcedureMemoryCellIds,
    );
    const blocks: string[] = [];
    const memoryUpdate = renderProcedureMemoryCardsSection(cards);
    const includeRecoveryGuidance = shouldIncludeRecoveredProcedureGuidance(session);

    if (cards.length > 0) {
      session.events.publish(session.store.sessionId, {
        type: "memory_cards",
        runId,
        cards,
      });
    }

    if (memoryUpdate) {
      blocks.push(memoryUpdate);
    }

    if (memoryUpdate || includeRecoveryGuidance) {
      blocks.push(renderSessionToolGuidance());
    }

    if (blocks.length === 0) {
      appendTimingTraceEvent(timingTrace, "service", "prepare_default_prompt_completed", {
        runId,
        cardCount: cards.length,
        includedRecoveryGuidance: includeRecoveryGuidance,
        wrappedPrompt: false,
        promptLength: prompt.length,
      });
      return {
        prompt,
        markSubmitted() {},
      };
    }

    blocks.push(`User message:\n${prompt}`);

    const preparedPrompt = blocks.join("\n\n");
    appendTimingTraceEvent(timingTrace, "service", "prepare_default_prompt_completed", {
      runId,
      cardCount: cards.length,
      includedRecoveryGuidance: includeRecoveryGuidance,
      wrappedPrompt: true,
      promptLength: preparedPrompt.length,
    });

    return {
      prompt: preparedPrompt,
      markSubmitted: () => {
        for (const card of cards) {
          session.syncedProcedureMemoryCellIds.add(card.cell.cellId);
        }
      },
    };
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
  ): Promise<{ result: ProcedureExecutionResult; tokenUsage?: AgentTokenUsage }> {
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
      const promptResult = await session.defaultConversation.prompt(
        buildMcpProcedureDispatchPrompt(
          session.store.sessionId,
          procedureName,
          procedurePrompt,
          toDownstreamAgentSelection(session.defaultAgentConfig),
          dispatchCorrelationId,
        ),
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
        session.syncedProcedureMemoryCellIds.add(result.cell.cellId);
        return {
          result,
          tokenUsage: normalizeAgentTokenUsage(
            promptResult.tokenSnapshot ?? await session.defaultConversation.getCurrentTokenSnapshot(),
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
        session.syncedProcedureMemoryCellIds.add(dispatchStatus.result.cell.cellId);
        return {
          result: dispatchStatus.result,
          tokenUsage: normalizeAgentTokenUsage(
            promptResult.tokenSnapshot ?? await session.defaultConversation.getCurrentTokenSnapshot(),
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

      const recoveredCell = await waitForRecoveredProcedureDispatchCell(session.store, {
        procedureName,
        dispatchCorrelationId,
        signal: options.signal,
        softStopSignal: options.softStopSignal,
      });
      if (recoveredCell) {
        appendTimingTraceEvent(timingTrace, "service", "dispatch_result_recovered_from_store", {
          procedure: procedureName,
          cellId: recoveredCell.cellId,
        });
        return {
          result: procedureDispatchResultFromRecoveredCell(session.store.sessionId, recoveredCell),
          tokenUsage: normalizeAgentTokenUsage(
            promptResult.tokenSnapshot ?? await session.defaultConversation.getCurrentTokenSnapshot(),
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
    session.defaultConversation.updateConfig(nextConfig);
    this.persistSessionState(session, { preserveDefaultAcpSessionId: false });
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
    result: ProcedureExecutionResult;
    tokenUsage?: AgentTokenUsage;
    emitter: CompositeSessionUpdateEmitter;
    markRunActivity: () => void;
  }): void {
    this.applyDefaultAgentSelection(params.session, params.result.defaultAgentSelection);
    this.emitDisplayIfNeeded(params.emitter, params.result.display);
    publishStoredMemoryCard(params.session, params.sessionId, params.runId, params.result.cell);
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
    result: ProcedureExecutionResult;
    tokenUsage?: AgentTokenUsage;
    emitter: CompositeSessionUpdateEmitter;
    markRunActivity: () => void;
  }): void {
    this.applyDefaultAgentSelection(params.session, params.result.defaultAgentSelection);
    this.emitDisplayIfNeeded(
      params.emitter,
      params.result.display ?? params.result.pause?.question,
    );
    publishStoredMemoryCard(params.session, params.sessionId, params.runId, params.result.cell);
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
    cell?: { sessionId: string; cellId: string };
  }): void {
    params.session.events.publish(params.sessionId, {
      type: "run_failed",
      runId: params.runId,
      procedure: params.procedure,
      completedAt: new Date().toISOString(),
      error: params.error,
      cell: params.cell,
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
    cell?: { sessionId: string; cellId: string };
  }): void {
    params.session.events.publish(
      params.sessionId,
      buildRunCancelledEvent({
        runId: params.runId,
        procedure: params.procedure,
        message: params.message,
        cell: params.cell,
      }),
    );
    params.markRunActivity();
  }

  async prompt(
    sessionId: string,
    promptText: string,
    delegate?: SessionUpdateEmitter,
  ): Promise<{ stopReason: "end_turn"; runId: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    this.cancelActiveProcedureDispatches(sessionId, session, session.activeRun);
    session.activeRun?.abortController.abort();
    session.activeRun?.softStopController.abort();

    const text = promptText.trim();
    const { commandName, commandPrompt, continuation } = resolveCommand(
      text,
      session.pendingProcedureContinuation,
    );
    const procedure = commandName === DISMISS_CONTINUATION_COMMAND_NAME
      ? createDismissContinuationProcedure(session)
      : this.registry.get(commandName);
    const procedureName = procedure?.name ?? commandName;
    const activeRun: ActiveRunState = {
      runId: crypto.randomUUID(),
      abortController: new AbortController(),
      softStopController: new AbortController(),
      softStopRequested: false,
      dispatchCorrelationIds: new Set<string>(),
    };
    session.activeRun = activeRun;
    const runId = activeRun.runId;
    const directTimingTrace = procedure
      ? createRunTimingTrace(session.store.rootDir, runId)
      : undefined;
    appendTimingTraceEvent(directTimingTrace, "service", "submit_received", {
      runId,
      procedure: procedureName,
      promptLength: commandPrompt.length,
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
    let persistedTopLevelCell: { sessionId: string; cellId: string } | undefined;
    const replayEvents: PersistedFrontendEvent[] = [];
    const stopReplayCapture = session.events.subscribe((event) => {
      const replayEvent = toReplayableFrontendEvent(event, runId);
      if (replayEvent) {
        replayEvents.push(replayEvent);
      }
    });

    let lastRunActivityAt = Date.now();
    const markRunActivity = () => {
      lastRunActivityAt = Date.now();
    };
    const heartbeatMs = getRunHeartbeatMs();
    const heartbeatTimer = setInterval(() => {
      if (Date.now() - lastRunActivityAt < heartbeatMs) {
        return;
      }

      session.events.publish(sessionId, {
        type: "run_heartbeat",
        runId,
        procedure: procedureName,
        at: new Date().toISOString(),
      });
      markRunActivity();
    }, heartbeatMs);

    session.events.publish(sessionId, {
      type: "run_started",
      runId,
      procedure: procedureName,
      prompt: commandPrompt,
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
      if (!procedure) {
        const error = continuation
          ? `Pending continuation for /${commandName} is no longer available.`
          : `Unknown command: /${commandName}`;
        if (continuation) {
          this.setPendingProcedureContinuation(sessionId, session, undefined);
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
        this.setPendingProcedureContinuation(sessionId, session, undefined);
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
        const result = await executeTopLevelProcedure({
          cwd: session.cwd,
          sessionId,
          store: session.store,
          registry: this.registry,
          procedure,
          prompt: commandPrompt,
          emitter,
          signal: activeRun.abortController.signal,
          softStopSignal: activeRun.softStopController.signal,
          defaultConversation: session.defaultConversation,
          getDefaultAgentConfig: () => session.defaultAgentConfig,
          setDefaultAgentSelection: (selection) => {
            const nextConfig = this.resolveDefaultAgentConfig(session.cwd, selection);
            session.defaultAgentConfig = nextConfig;
            session.defaultConversation.updateConfig(nextConfig);
            return nextConfig;
          },
          prepareDefaultPrompt: (prompt) => this.prepareDefaultPrompt(session, prompt, runId, timingTrace),
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
          this.setPendingProcedureContinuation(
            sessionId,
            session,
            buildPendingProcedureContinuation(procedure.name, result),
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
            this.setPendingProcedureContinuation(sessionId, session, undefined);
          } else if (procedure.name === DISMISS_CONTINUATION_COMMAND_NAME) {
            this.setPendingProcedureContinuation(sessionId, session, undefined);
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
        persistedTopLevelCell = result.cell;
      } catch (error) {
        if (error instanceof TopLevelProcedureExecutionError) {
          this.publishRunFailed({
            session,
            sessionId,
            runId,
            procedure: procedure.name,
            error: error.message,
            cell: error.cell,
            markRunActivity,
          });
        } else if (error instanceof TopLevelProcedureCancelledError) {
          this.publishRunCancelled({
            session,
            sessionId,
            runId,
            procedure: procedure.name,
            message: error.message,
            cell: error.cell,
            markRunActivity,
          });
          persistedTopLevelCell = error.cell;
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
      clearInterval(heartbeatTimer);
      const availableCommands = buildAvailableCommands(this.registry);
      const commands = toFrontendCommands(availableCommands);
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
      stopReplayCapture();
      if (persistedTopLevelCell && replayEvents.length > 0) {
        session.store.patchCell(persistedTopLevelCell, {
          output: {
            replayEvents,
          },
        });
      }
      this.persistSessionState(session, { prompt: text });
      if (session.activeRun === activeRun) {
        session.activeRun = undefined;
      }
    }

    return { stopReason: "end_turn", runId };
  }
}

function shouldPrewarmDefaultConversation(): boolean {
  return process.env.NANOBOSS_PREWARM_DEFAULT_SESSION !== "0";
}

type RestoredRunTerminalEvent = Extract<
  PersistedFrontendEvent,
  { type: "run_completed" | "run_paused" | "run_failed" | "run_cancelled" }
>;

function getRestoredRunTerminalEvent(
  replayEvents: PersistedFrontendEvent[] | undefined,
): RestoredRunTerminalEvent | undefined {
  return [...(replayEvents ?? [])].reverse().find(isRestoredRunTerminalEvent);
}

function isRestoredRunTerminalEvent(event: PersistedFrontendEvent): event is RestoredRunTerminalEvent {
  return event.type === "run_completed"
    || event.type === "run_paused"
    || event.type === "run_failed"
    || event.type === "run_cancelled";
}

function getRestoredRunEndedAt(event: RestoredRunTerminalEvent | undefined): string | undefined {
  if (!event) {
    return undefined;
  }

  return event.type === "run_paused" ? event.pausedAt : event.completedAt;
}

function getRestoredRunStatus(
  event: RestoredRunTerminalEvent | undefined,
): "complete" | "failed" | "cancelled" | "paused" {
  switch (event?.type) {
    case "run_failed":
      return "failed";
    case "run_cancelled":
      return "cancelled";
    case "run_paused":
      return "paused";
    default:
      return "complete";
  }
}

function getRunHeartbeatMs(): number {
  const value = Number(process.env.NANOBOSS_RUN_HEARTBEAT_MS ?? "5000");
  return Number.isFinite(value) && value > 0 ? value : 5000;
}

function publishStoredMemoryCard(
  session: SessionState,
  sessionId: string,
  runId: string,
  cellRef?: { sessionId: string; cellId: string },
): void {
  if (!cellRef) {
    return;
  }

  const storedMemoryCard = materializeProcedureMemoryCard(session.store, cellRef);
  if (!storedMemoryCard) {
    return;
  }

  session.events.publish(sessionId, {
    type: "memory_card_stored",
    runId,
    card: storedMemoryCard,
  });
}

function shouldIncludeRecoveredProcedureGuidance(session: SessionState): boolean {
  if (!session.recentRecoverySyncAtMs) {
    return false;
  }

  return Date.now() - session.recentRecoverySyncAtMs <= getRecoveredProcedureGuidanceWindowMs();
}

function getRecoveredProcedureGuidanceWindowMs(): number {
  const value = Number(process.env.NANOBOSS_RECOVERED_PROCEDURE_GUIDANCE_WINDOW_MS ?? "300000");
  return Number.isFinite(value) && value > 0 ? value : 300000;
}

export function extractProcedureDispatchResult(updates: acp.SessionUpdate[]): ProcedureExecutionResult | undefined {
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

function parseProcedureDispatchResultCandidate(value: unknown): ProcedureExecutionResult | undefined {
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

function buildAvailableCommands(registry: ProcedureRegistryLike): acp.AvailableCommand[] {
  const commands = projectProcedureMetadata(registry.listMetadata()).map(toAvailableCommand);
  return commands.some((command) => command.name === DISMISS_CONTINUATION_COMMAND_NAME)
    ? commands
    : [...commands, DISMISS_CONTINUATION_COMMAND];
}

function toFrontendPendingProcedureContinuation(
  continuation?: PendingProcedureContinuation,
): FrontendPendingProcedureContinuation | undefined {
  if (!continuation) {
    return undefined;
  }

  return {
    procedure: continuation.procedure,
    question: continuation.question,
    inputHint: continuation.inputHint,
    suggestedReplies: continuation.suggestedReplies,
    continuationUi: continuation.continuationUi,
  };
}

function createDismissContinuationProcedure(session: SessionState): Procedure {
  return {
    name: DISMISS_CONTINUATION_COMMAND_NAME,
    description: DISMISS_CONTINUATION_COMMAND.description,
    executionMode: "harness",
    async execute() {
      const pending = session.pendingProcedureContinuation;
      session.pendingProcedureContinuation = undefined;
      return pending
        ? {
            display: `Cleared the pending continuation for /${pending.procedure}. Future plain-text replies will go to /default again.`,
            summary: `Cleared /${pending.procedure} continuation`,
          }
        : {
            display: "No pending continuation was active.",
            summary: "No continuation to clear",
          };
    },
  };
}

function buildPendingProcedureContinuation(
  procedure: string,
  result: ProcedureExecutionResult,
): PendingProcedureContinuation {
  if (!result.pause) {
    throw new Error("Cannot persist continuation without pause metadata.");
  }

  return {
    procedure,
    cell: result.cell,
    question: result.pause.question,
    state: result.pause.state,
    inputHint: result.pause.inputHint,
    suggestedReplies: result.pause.suggestedReplies,
    continuationUi: result.pause.continuationUi,
  };
}

function resolveCommand(
  text: string,
  pendingProcedureContinuation?: PendingProcedureContinuation,
): {
  commandName: string;
  commandPrompt: string;
  continuation?: PendingProcedureContinuation;
} {
  if (!text.startsWith("/")) {
    return pendingProcedureContinuation
      ? {
          commandName: pendingProcedureContinuation.procedure,
          commandPrompt: text,
          continuation: pendingProcedureContinuation,
        }
      : {
          commandName: "default",
          commandPrompt: text,
        };
  }

  const [name, ...rest] = text.slice(1).split(/\s+/);
  return {
    commandName: name || "default",
    commandPrompt: rest.join(" "),
  };
}

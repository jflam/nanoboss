import type * as acp from "@agentclientprotocol/sdk";

import { getBuildLabel } from "./build-info.ts";
import { RunCancelledError, defaultCancellationMessage, normalizeRunCancelledError } from "./cancellation.ts";
import { resolveDownstreamAgentConfig, toDownstreamAgentSelection } from "./config.ts";
import { type SessionUpdateEmitter } from "./context.ts";
import { DefaultConversationSession } from "../agent/default-session.ts";
import { normalizeAgentTokenUsage } from "../agent/token-usage.ts";
import {
  collectUnsyncedProcedureMemoryCards,
  materializeProcedureMemoryCard,
  renderProcedureMemoryPreamble,
  renderSessionToolGuidance,
} from "./memory-cards.ts";
import { estimateDefaultPromptDiagnostics, estimateProcedureMemoryCardTokens } from "./prompt-diagnostics.ts";
import {
  mapSessionUpdateToFrontendEvents,
  SessionEventLog,
  toFrontendCommands,
  type FrontendEvent,
  type FrontendEventEnvelope,
  type FrontendCommand,
} from "../http/frontend-events.ts";
import {
  sessionRepository,
  type SessionMetadata,
} from "../session/index.ts";
import { startProcedureDispatchProgressBridge } from "../procedure/dispatch-progress.ts";
import {
  procedureDispatchResultFromRecoveredCell,
  waitForRecoveredProcedureDispatchCell,
} from "../procedure/dispatch-recovery.ts";
import {
  buildRunCancelledEvent,
  buildRunCompletedEvent,
  executeTopLevelProcedure,
  TopLevelProcedureCancelledError,
  TopLevelProcedureExecutionError,
  type ProcedureExecutionResult,
} from "../procedure/runner.ts";
import { ProcedureRegistry } from "../procedure/registry.ts";
import { formatAgentBanner } from "./runtime-banner.ts";
import { shouldLoadDiskCommands } from "./runtime-mode.ts";
import { isProcedureDispatchResult, isProcedureDispatchStatusResult } from "../mcp/server.ts";
import type { SessionStore } from "../session/index.ts";
import type {
  AgentTokenUsage,
  CellRecord,
  DownstreamAgentConfig,
  DownstreamAgentSelection,
  PersistedFrontendEvent,
} from "./types.ts";

interface ActiveRunState {
  runId: string;
  abortController: AbortController;
  softStopController: AbortController;
  softStopRequested: boolean;
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
}

export interface SessionDescriptor {
  sessionId: string;
  cwd: string;
  commands: FrontendCommand[];
  buildLabel: string;
  agentLabel: string;
  defaultAgentSelection?: DownstreamAgentSelection;
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
    return this.registry.toAvailableCommands();
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
    this.touchCurrentSessionMetadata(this.persistSessionState(state));
    state.events.publish(sessionId, {
      type: "commands_updated",
      commands: state.commands,
    });

    return this.buildSessionDescriptor(sessionId, state);
  }

  resumeSession(params: {
    sessionId: string;
    cwd?: string;
    defaultAgentSelection?: DownstreamAgentSelection;
  }): SessionDescriptor {
    const existing = this.sessions.get(params.sessionId);
    if (existing) {
      this.touchCurrentSessionMetadata(this.persistSessionState(existing));
      return this.buildSessionDescriptor(params.sessionId, existing);
    }

    const stored = sessionRepository.readMetadata(params.sessionId);
    const cwd = stored?.cwd || params.cwd;
    if (!cwd) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }

    const state = this.createSessionState({
      sessionId: params.sessionId,
      cwd,
      defaultAgentSelection: params.defaultAgentSelection ?? stored?.defaultAgentSelection,
      defaultAcpSessionId: stored?.defaultAcpSessionId,
    });
    this.restorePersistedSessionHistory(params.sessionId, state);

    this.sessions.set(params.sessionId, state);
    this.touchCurrentSessionMetadata(this.persistSessionState(state));
    state.events.publish(params.sessionId, {
      type: "commands_updated",
      commands: state.commands,
    });

    return this.buildSessionDescriptor(params.sessionId, state);
  }

  getSession(sessionId: string): SessionDescriptor | undefined {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return undefined;
    }

    return this.buildSessionDescriptor(sessionId, state);
  }

  private createSessionState(params: {
    sessionId: string;
    cwd: string;
    defaultAgentSelection?: DownstreamAgentSelection;
    defaultAcpSessionId?: string;
  }): SessionState {
    const commands = toFrontendCommands(this.registry.toAvailableCommands());
    const defaultAgentConfig = this.resolveDefaultAgentConfig(params.cwd, params.defaultAgentSelection);
    const store = sessionRepository.openStore({
      sessionId: params.sessionId,
      cwd: params.cwd,
    });

    return {
      cwd: params.cwd,
      store,
      events: new SessionEventLog(),
      defaultAgentConfig,
      defaultConversation: new DefaultConversationSession({
        config: defaultAgentConfig,
        sessionId: params.sessionId,
        rootDir: store.rootDir,
        persistedSessionId: params.defaultAcpSessionId,
      }),
      syncedProcedureMemoryCellIds: new Set(),
      commands,
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

  private restorePersistedSessionHistory(sessionId: string, session: SessionState): void {
    const runs = session.store.topLevelRuns().reverse();
    for (const summary of runs) {
      const record = session.store.readCell(summary.cell);
      const replayEvents = record.output.replayEvents;
      const runId = replayEvents?.[0]?.runId ?? record.cellId;
      const status = replayEvents?.some((event) => event.type === "run_failed")
        ? "failed"
        : replayEvents?.some((event) => event.type === "run_cancelled")
          ? "cancelled"
          : "complete";

      session.events.publish(sessionId, {
        type: "run_restored",
        runId,
        procedure: record.procedure,
        prompt: record.input,
        completedAt: record.meta.createdAt,
        cell: {
          sessionId,
          cellId: record.cellId,
        },
        status,
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
    const existing = sessionRepository.readMetadata(session.store.sessionId, session.store.rootDir);
    const defaultAcpSessionId = session.defaultConversation.currentSessionId
      ?? (options.preserveDefaultAcpSessionId === false ? undefined : existing?.defaultAcpSessionId);

    return sessionRepository.writeMetadata({
      sessionId: session.store.sessionId,
      cwd: session.cwd,
      rootDir: session.store.rootDir,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      initialPrompt: existing?.initialPrompt ?? options.prompt,
      lastPrompt: options.prompt ?? existing?.lastPrompt,
      defaultAgentSelection: toDownstreamAgentSelection(session.defaultAgentConfig),
      defaultAcpSessionId,
    });
  }

  private touchCurrentSessionMetadata(metadata: SessionMetadata): void {
    sessionRepository.writeCurrentMetadata(metadata);
  }

  getSessionEvents(sessionId: string): SessionEventLog | undefined {
    return this.sessions.get(sessionId)?.events;
  }

  cancel(sessionId: string, runId?: string): void {
    const activeRun = this.sessions.get(sessionId)?.activeRun;
    if (!activeRun) {
      return;
    }

    if ((runId && activeRun.runId !== runId) || activeRun.softStopRequested) {
      return;
    }

    activeRun.softStopRequested = true;
    activeRun.softStopController.abort();
  }

  destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.activeRun?.abortController.abort();
    session.activeRun?.softStopController.abort();
    session.defaultConversation.closeLiveSession();
    this.sessions.delete(sessionId);
  }

  private prepareDefaultPrompt(
    session: SessionState,
    prompt: string,
    runId: string,
  ): { prompt: string; markSubmitted: () => void } {
    const cards = collectUnsyncedProcedureMemoryCards(
      session.store,
      session.syncedProcedureMemoryCellIds,
    );
    const blocks: string[] = [];
    const preamble = renderProcedureMemoryPreamble(cards);
    const includeRecoveryGuidance = shouldIncludeRecoveredProcedureGuidance(session);
    const includeGuidance = Boolean(preamble) || includeRecoveryGuidance;

    const promptDiagnostics = estimateDefaultPromptDiagnostics(session.defaultAgentConfig, {
      prompt,
      cards,
      includeGuidance,
      promptIncludesUserMessageLabel: includeGuidance,
    });

    if (cards.length > 0) {
      session.events.publish(session.store.sessionId, {
        type: "memory_cards",
        runId,
        cards: cards.map((card, index) => ({
          ...card,
          estimatedPromptTokens: promptDiagnostics?.cards[index]?.estimatedTokens,
        })),
      });
    }

    if (promptDiagnostics) {
      session.events.publish(session.store.sessionId, {
        type: "prompt_diagnostics",
        runId,
        diagnostics: promptDiagnostics,
      });
    }

    if (preamble) {
      blocks.push(preamble);
    } else if (includeRecoveryGuidance) {
      blocks.push(renderSessionToolGuidance());
    }

    if (blocks.length === 0) {
      return {
        prompt,
        markSubmitted() {},
      };
    }

    blocks.push(`User message:\n${prompt}`);

    return {
      prompt: blocks.join("\n\n"),
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
    options: {
      signal?: AbortSignal;
      softStopSignal?: AbortSignal;
      assertCanStartBoundary?: () => void;
    } = {},
  ): Promise<{ result: ProcedureExecutionResult; tokenUsage?: AgentTokenUsage }> {
    const dispatchCorrelationId = crypto.randomUUID();
    const stopProgressBridge = startProcedureDispatchProgressBridge(
      session.store.rootDir,
      dispatchCorrelationId,
      emitter,
    );

    try {
      options.assertCanStartBoundary?.();
      const promptResult = await session.defaultConversation.prompt(
        buildProcedureDispatchPrompt(
          session.store.sessionId,
          procedureName,
          procedurePrompt,
          toDownstreamAgentSelection(session.defaultAgentConfig),
          dispatchCorrelationId,
        ),
        {
          signal: options.signal,
          softStopSignal: options.softStopSignal,
          onUpdate: async (update) => {
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

      const result = extractProcedureDispatchResult(promptResult.updates);
      if (result) {
        session.syncedProcedureMemoryCellIds.add(result.cell.cellId);
        return {
          result,
          tokenUsage: normalizeAgentTokenUsage(
            promptResult.tokenSnapshot ?? await session.defaultConversation.getCurrentTokenSnapshot(),
            session.defaultAgentConfig,
          ),
        };
      }

      const recoveredCell = await waitForRecoveredProcedureDispatchCell(session.store, {
        procedureName,
        dispatchCorrelationId,
      });
      if (recoveredCell) {
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
    session.defaultConversation.updateConfig(nextConfig);
    this.touchCurrentSessionMetadata(
      this.persistSessionState(session, { preserveDefaultAcpSessionId: false }),
    );
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

    session.activeRun?.abortController.abort();
    session.activeRun?.softStopController.abort();

    const text = promptText.trim();
    const { commandName, commandPrompt } = resolveCommand(text);
    this.touchCurrentSessionMetadata(this.persistSessionState(session, { prompt: text }));
    const procedure = this.registry.get(commandName);
    const procedureName = procedure?.name ?? commandName;
    const activeRun: ActiveRunState = {
      runId: crypto.randomUUID(),
      abortController: new AbortController(),
      softStopController: new AbortController(),
      softStopRequested: false,
    };
    session.activeRun = activeRun;
    const runId = activeRun.runId;
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
      const replayEvent = toPersistedReplayEvent(event, runId);
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
        const error = `Unknown command: /${commandName}`;
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

      if (text.startsWith("/") && procedure.name !== "default") {
        const dispatched = await this.dispatchProcedureIntoDefaultConversation(
          session,
          procedure.name,
          commandPrompt,
          emitter,
          {
            signal: activeRun.abortController.signal,
            softStopSignal: activeRun.softStopController.signal,
            assertCanStartBoundary,
          },
        );

        this.publishRunCompleted({
          session,
          sessionId,
          runId,
          procedure: procedure.name,
          result: dispatched.result,
          tokenUsage: dispatched.tokenUsage,
          emitter,
          markRunActivity,
        });
        persistedTopLevelCell = dispatched.result.cell;
      } else {
        try {
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
            prepareDefaultPrompt: (prompt) => this.prepareDefaultPrompt(session, prompt, runId),
            onError: (ctx, errorText) => {
              ctx.print(errorText);
            },
            assertCanStartBoundary,
          });

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
      }
    } catch (error) {
      const cancelled = normalizeRunCancelledError(
        error,
        activeRun.softStopRequested ? "soft_stop" : "abort",
      );
      const message = cancelled?.message ?? (error instanceof Error ? error.message : String(error));
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
      const commands = toFrontendCommands(this.registry.toAvailableCommands());
      session.commands = commands;
      session.events.publish(sessionId, {
        type: "commands_updated",
        commands,
      });
      delegate?.emit({
        sessionUpdate: "available_commands_update",
        availableCommands: this.registry.toAvailableCommands(),
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
      this.touchCurrentSessionMetadata(this.persistSessionState(session));
      if (session.activeRun === activeRun) {
        session.activeRun = undefined;
      }
    }

    return { stopReason: "end_turn", runId };
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
  const storedMemoryCardEstimate = storedMemoryCard
    ? estimateProcedureMemoryCardTokens(session.defaultAgentConfig, storedMemoryCard)
    : undefined;
  if (!storedMemoryCard) {
    return;
  }

  session.events.publish(sessionId, {
    type: "memory_card_stored",
    runId,
    card: {
      ...storedMemoryCard,
      estimatedPromptTokens: storedMemoryCardEstimate?.estimatedTokens,
    },
    estimateMethod: storedMemoryCardEstimate?.method,
    estimateEncoding: storedMemoryCardEstimate?.encoding,
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

function buildProcedureDispatchPrompt(
  sessionId: string,
  procedureName: string,
  procedurePrompt: string,
  defaultAgentSelection?: DownstreamAgentSelection,
  dispatchCorrelationId?: string,
): string {
  return [
    "Nanoboss internal slash-command dispatch.",
    "Internal control message for the current persistent master conversation.",
    "Use the globally registered `nanoboss` MCP server.",
    "Do not inspect repo files, CLI wiring, session pointer files, or ~/.nanoboss.",
    "The client may expose the tools under bare names or namespaced handles such as `mcp__nanoboss__procedure_dispatch_start` or similar names that contain `procedure_dispatch_start` / `procedure_dispatch_wait`.",
    "Use the global nanoboss MCP handle that contains `procedure_dispatch_start` for step 1 and the matching `procedure_dispatch_wait` handle for step 2.",
    `Target session id: ${sessionId}`,
    "Step 1: call the chosen `procedure_dispatch_start` tool exactly once with this JSON:",
    JSON.stringify({
      sessionId,
      name: procedureName,
      prompt: procedurePrompt,
      defaultAgentSelection,
      dispatchCorrelationId,
    }),
    "Step 2: after start returns a dispatch id, repeatedly call the chosen `procedure_dispatch_wait` tool with that dispatch id until status is `completed` or `failed`.",
    "Use a short bounded wait on each poll.",
    "Do not answer from your own knowledge.",
    "If the final status is `completed`, reply with exactly the final tool result text and nothing else.",
    "If the final status is `failed`, reply with exactly the tool error text and nothing else.",
    "No prefatory explanation.",
  ].join("\n\n");
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

function toPersistedReplayEvent(
  event: FrontendEventEnvelope,
  runId: string,
): PersistedFrontendEvent | undefined {
  if (!("runId" in event.data) || event.data.runId !== runId) {
    return undefined;
  }

  switch (event.type) {
    case "text_delta":
      return {
        type: "text_delta",
        runId: event.data.runId,
        text: event.data.text,
        stream: event.data.stream,
      };
    case "tool_started":
      return {
        type: "tool_started",
        runId: event.data.runId,
        toolCallId: event.data.toolCallId,
        title: event.data.title,
        kind: event.data.kind,
        status: event.data.status,
        callPreview: event.data.callPreview,
        rawInput: event.data.rawInput,
      };
    case "tool_updated":
      return {
        type: "tool_updated",
        runId: event.data.runId,
        toolCallId: event.data.toolCallId,
        title: event.data.title,
        status: event.data.status,
        resultPreview: event.data.resultPreview,
        errorPreview: event.data.errorPreview,
        durationMs: event.data.durationMs,
        rawOutput: event.data.rawOutput,
      };
    case "token_usage":
      return {
        type: "token_usage",
        runId: event.data.runId,
        usage: event.data.usage,
        sourceUpdate: event.data.sourceUpdate,
        toolCallId: event.data.toolCallId,
        status: event.data.status,
      };
    case "run_completed":
      return {
        type: "run_completed",
        runId: event.data.runId,
        procedure: event.data.procedure,
        completedAt: event.data.completedAt,
        cell: event.data.cell,
        summary: event.data.summary,
        display: event.data.display,
        tokenUsage: event.data.tokenUsage,
      };
    case "run_failed":
      return {
        type: "run_failed",
        runId: event.data.runId,
        procedure: event.data.procedure,
        completedAt: event.data.completedAt,
        error: event.data.error,
        cell: event.data.cell,
      };
    case "run_cancelled":
      return {
        type: "run_cancelled",
        runId: event.data.runId,
        procedure: event.data.procedure,
        completedAt: event.data.completedAt,
        message: event.data.message,
        cell: event.data.cell,
      };
    default:
      return undefined;
  }
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

function resolveCommand(text: string): { commandName: string; commandPrompt: string } {
  if (!text.startsWith("/")) {
    return {
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

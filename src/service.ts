import type * as acp from "@agentclientprotocol/sdk";

import { getBuildLabel } from "./build-info.ts";
import { resolveDownstreamAgentConfig, toDownstreamAgentSelection } from "./config.ts";
import { type SessionUpdateEmitter } from "./context.ts";
import { DefaultConversationSession } from "./default-session.ts";
import { normalizeAgentTokenUsage } from "./token-usage.ts";
import { disposeSessionMcpTransport } from "./mcp-attachment.ts";
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
  type FrontendCommand,
} from "./frontend-events.ts";
import { writeCurrentSessionPointer } from "./current-session.ts";
import {
  readStoredSessionRecord,
  writeStoredSessionRecord,
} from "./stored-sessions.ts";
import { startProcedureDispatchProgressBridge } from "./procedure-dispatch-progress.ts";
import {
  procedureDispatchResultFromRecoveredCell,
  waitForRecoveredProcedureDispatchCell,
} from "./procedure-dispatch-recovery.ts";
import {
  buildRunCompletedEvent,
  executeTopLevelProcedure,
  TopLevelProcedureExecutionError,
  type ProcedureExecutionResult,
} from "./procedure-runner.ts";
import { ProcedureRegistry } from "./registry.ts";
import { formatAgentBanner } from "./runtime-banner.ts";
import { shouldLoadDiskCommands } from "./runtime-mode.ts";
import { isProcedureDispatchResult, isProcedureDispatchStatusResult } from "./session-mcp.ts";
import { SessionStore } from "./session-store.ts";
import type {
  AgentTokenUsage,
  DownstreamAgentConfig,
  DownstreamAgentSelection,
} from "./types.ts";

interface SessionState {
  cwd: string;
  store: SessionStore;
  events: SessionEventLog;
  defaultAgentConfig: DownstreamAgentConfig;
  defaultConversation: DefaultConversationSession;
  syncedProcedureMemoryCellIds: Set<string>;
  recentRecoverySyncAtMs?: number;
  abortController?: AbortController;
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
    this.touchCurrentSessionPointer(state);
    this.persistSessionState(state);
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
      this.touchCurrentSessionPointer(existing);
      return this.buildSessionDescriptor(params.sessionId, existing);
    }

    const stored = readStoredSessionRecord(params.sessionId);
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

    this.sessions.set(params.sessionId, state);
    this.touchCurrentSessionPointer(state);
    this.persistSessionState(state);
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
    const store = new SessionStore({
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

  private persistSessionState(
    session: SessionState,
    options: { prompt?: string; preserveDefaultAcpSessionId?: boolean } = {},
  ): void {
    const existing = readStoredSessionRecord(session.store.sessionId, session.store.rootDir);
    const defaultAcpSessionId = session.defaultConversation.currentSessionId
      ?? (options.preserveDefaultAcpSessionId === false ? undefined : existing?.defaultAcpSessionId);

    writeStoredSessionRecord({
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

  private touchCurrentSessionPointer(session: SessionState): void {
    writeCurrentSessionPointer({
      sessionId: session.store.sessionId,
      cwd: session.cwd,
      rootDir: session.store.rootDir,
    });
  }

  getSessionEvents(sessionId: string): SessionEventLog | undefined {
    return this.sessions.get(sessionId)?.events;
  }

  cancel(sessionId: string): void {
    this.sessions.get(sessionId)?.abortController?.abort();
  }

  destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.abortController?.abort();
    session.defaultConversation.closeLiveSession();
    disposeSessionMcpTransport(sessionId);
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
  ): Promise<{ result: ProcedureExecutionResult; tokenUsage?: AgentTokenUsage }> {
    const dispatchCorrelationId = crypto.randomUUID();
    const stopProgressBridge = startProcedureDispatchProgressBridge(
      session.store.rootDir,
      dispatchCorrelationId,
      emitter,
    );

    try {
      const promptResult = await session.defaultConversation.prompt(
        buildProcedureDispatchPrompt(
          procedureName,
          procedurePrompt,
          toDownstreamAgentSelection(session.defaultAgentConfig),
          dispatchCorrelationId,
        ),
        {
          signal: session.abortController?.signal,
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
    this.persistSessionState(session, { preserveDefaultAcpSessionId: false });
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

    session.abortController?.abort();
    session.abortController = new AbortController();
    this.touchCurrentSessionPointer(session);

    const text = promptText.trim();
    const { commandName, commandPrompt } = resolveCommand(text);
    this.persistSessionState(session, { prompt: text });
    const procedure = this.registry.get(commandName);
    const procedureName = procedure?.name ?? commandName;
    const runId = crypto.randomUUID();
    const startedAt = Date.now();

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

    if (!procedure) {
      const error = `Unknown command: /${commandName}`;
      delegate?.emit({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `${error}\n`,
        },
      });
      await (delegate?.flush() ?? Promise.resolve());

      session.events.publish(sessionId, {
        type: "run_failed",
        runId,
        procedure: procedureName,
        completedAt: new Date().toISOString(),
        error,
      });
      markRunActivity();
      clearInterval(heartbeatTimer);

      return { stopReason: "end_turn", runId };
    }

    const emitter = new CompositeSessionUpdateEmitter(
      sessionId,
      runId,
      session.events,
      markRunActivity,
      delegate,
    );

    try {
      if (text.startsWith("/") && procedure.name !== "default") {
        const dispatched = await this.dispatchProcedureIntoDefaultConversation(
          session,
          procedure.name,
          commandPrompt,
          emitter,
        );

        this.applyDefaultAgentSelection(session, dispatched.result.defaultAgentSelection);

        if (dispatched.result.display && !emitter.hasStreamedText(dispatched.result.display)) {
          emitter.emit({
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: dispatched.result.display,
            },
          });
        }

        publishStoredMemoryCard(session, sessionId, runId, dispatched.result.cell);
        session.events.publish(
          sessionId,
          buildRunCompletedEvent({
            runId,
            procedure: procedure.name,
            result: dispatched.result,
            tokenUsage: dispatched.tokenUsage,
          }),
        );
        markRunActivity();
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
            signal: session.abortController.signal,
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
          });

          this.applyDefaultAgentSelection(session, result.defaultAgentSelection);

          if (result.display && !emitter.hasStreamedText(result.display)) {
            emitter.emit({
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: result.display,
              },
            });
          }

          publishStoredMemoryCard(session, sessionId, runId, result.cell);
          session.events.publish(
            sessionId,
            buildRunCompletedEvent({
              runId,
              procedure: procedure.name,
              result,
              tokenUsage: result.tokenUsage,
            }),
          );
          markRunActivity();
        } catch (error) {
          if (error instanceof TopLevelProcedureExecutionError) {
            session.events.publish(sessionId, {
              type: "run_failed",
              runId,
              procedure: procedure.name,
              completedAt: new Date().toISOString(),
              error: error.message,
              cell: error.cell,
            });
            markRunActivity();
          }
          throw error;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!emitter.hasAnyStreamedText) {
        emitter.emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `Error: ${message}\n`,
          },
        });
      }

      if (!(error instanceof TopLevelProcedureExecutionError)) {
        session.events.publish(sessionId, {
          type: "run_failed",
          runId,
          procedure: procedure.name,
          completedAt: new Date().toISOString(),
          error: message,
        });
        markRunActivity();
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
      this.persistSessionState(session);
      this.touchCurrentSessionPointer(session);
      session.abortController = undefined;
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
  procedureName: string,
  procedurePrompt: string,
  defaultAgentSelection?: DownstreamAgentSelection,
  dispatchCorrelationId?: string,
): string {
  return [
    "Nanoboss internal slash-command dispatch.",
    "Internal control message for the current persistent master conversation.",
    "A nanoboss MCP surface is available for this conversation.",
    "Prefer the attached `nanoboss-session` MCP server when it is exposed. If the client does not expose the attached server tools, use the globally registered `nanoboss` MCP server instead.",
    "Do not inspect repo files, CLI wiring, session pointer files, or ~/.nanoboss.",
    "Do not try to discover a session id.",
    "The client may expose the tools under bare names or namespaced handles such as `mcp__nanoboss-session__procedure_dispatch_start`, `mcp__nanoboss__procedure_dispatch_start`, or similar names that contain `procedure_dispatch_start` / `procedure_dispatch_wait`.",
    "Use the available nanoboss MCP handle that contains `procedure_dispatch_start` for step 1 and the available nanoboss MCP handle that contains `procedure_dispatch_wait` for step 2.",
    "Step 1: call the chosen `procedure_dispatch_start` tool exactly once with this JSON:",
    JSON.stringify({
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

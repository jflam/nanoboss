import type * as acp from "@agentclientprotocol/sdk";

import { getBuildLabel } from "./build-info.ts";
import { resolveDownstreamAgentConfig, toDownstreamAgentSelection } from "./config.ts";
import { CommandContextImpl, type SessionUpdateEmitter } from "./context.ts";
import { DefaultConversationSession } from "./default-session.ts";
import { normalizeAgentTokenUsage } from "./token-usage.ts";
import { disposeSessionMcpTransport } from "./mcp-attachment.ts";
import {
  collectUnsyncedProcedureMemoryCards,
  hasTopLevelNonDefaultProcedureHistory,
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
import { RunLogger } from "./logger.ts";
import { ProcedureRegistry } from "./registry.ts";
import { formatAgentBanner } from "./runtime-banner.ts";
import { shouldLoadDiskCommands } from "./runtime-mode.ts";
import { isProcedureDispatchResult, type ProcedureDispatchResult } from "./session-mcp.ts";
import {
  SessionStore,
  normalizeProcedureResult,
  summarizeText,
} from "./session-store.ts";
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
    const commands = toFrontendCommands(this.registry.toAvailableCommands());
    const defaultAgentConfig = this.resolveDefaultAgentConfig(params.cwd, params.defaultAgentSelection);
    const store = new SessionStore({
      sessionId,
      cwd: params.cwd,
    });
    const state: SessionState = {
      cwd: params.cwd,
      store,
      events: new SessionEventLog(),
      defaultAgentConfig,
      defaultConversation: new DefaultConversationSession({
        config: defaultAgentConfig,
        sessionId,
        rootDir: store.rootDir,
      }),
      syncedProcedureMemoryCellIds: new Set(),
      commands,
    };

    this.sessions.set(sessionId, state);
    writeCurrentSessionPointer({
      sessionId,
      cwd: params.cwd,
      rootDir: store.rootDir,
    });
    state.events.publish(sessionId, {
      type: "commands_updated",
      commands,
    });

    return {
      sessionId,
      cwd: params.cwd,
      commands,
      buildLabel: getBuildLabel(),
      agentLabel: formatAgentBanner(defaultAgentConfig),
      defaultAgentSelection: toDownstreamAgentSelection(defaultAgentConfig),
    };
  }

  getSession(sessionId: string): SessionDescriptor | undefined {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return undefined;
    }

    return {
      sessionId,
      cwd: state.cwd,
      commands: state.commands,
      buildLabel: getBuildLabel(),
      agentLabel: formatAgentBanner(state.defaultAgentConfig),
      defaultAgentSelection: toDownstreamAgentSelection(state.defaultAgentConfig),
    };
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
    const includeGuidance = Boolean(preamble) || hasTopLevelNonDefaultProcedureHistory(session.store);

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
    } else if (includeGuidance) {
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
  ): Promise<{ result: ProcedureDispatchResult; tokenUsage?: AgentTokenUsage }> {
    const promptResult = await session.defaultConversation.prompt(
      buildProcedureDispatchPrompt(
        procedureName,
        procedurePrompt,
        toDownstreamAgentSelection(session.defaultAgentConfig),
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
    if (!result) {
      throw new Error(`Default session did not dispatch /${procedureName} through procedure_dispatch.`);
    }

    session.syncedProcedureMemoryCellIds.add(result.cell.cellId);

    return {
      result,
      tokenUsage: normalizeAgentTokenUsage(
        promptResult.tokenSnapshot ?? await session.defaultConversation.getCurrentTokenSnapshot(),
        session.defaultAgentConfig,
      ),
    };
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

    const text = promptText.trim();
    const { commandName, commandPrompt } = resolveCommand(text);
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

        if (dispatched.result.defaultAgentSelection) {
          const nextConfig = this.resolveDefaultAgentConfig(session.cwd, dispatched.result.defaultAgentSelection);
          session.defaultAgentConfig = nextConfig;
          session.defaultConversation.updateConfig(nextConfig);
        }

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
        session.events.publish(sessionId, {
          type: "run_completed",
          runId,
          procedure: procedure.name,
          completedAt: new Date().toISOString(),
          cell: dispatched.result.cell,
          summary: dispatched.result.summary,
          display: dispatched.result.display,
          tokenUsage: dispatched.tokenUsage,
        });
        markRunActivity();
      } else {
        const logger = new RunLogger();
        const rootSpanId = logger.newSpan();
        const rootCell = session.store.startCell({
          procedure: procedure.name,
          input: commandPrompt,
          kind: "top_level",
        });
        const ctx = new CommandContextImpl({
          cwd: session.cwd,
          sessionId,
          logger,
          registry: this.registry,
          procedureName: procedure.name,
          spanId: rootSpanId,
          emitter,
          store: session.store,
          cell: rootCell,
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
        });

        logger.write({
          spanId: rootSpanId,
          procedure: procedure.name,
          kind: "procedure_start",
          prompt: commandPrompt,
        });

        try {
          const rawResult = await procedure.execute(commandPrompt, ctx);
          const result = normalizeProcedureResult(rawResult);
          const finalized = session.store.finalizeCell(rootCell, result);

          logger.write({
            spanId: rootSpanId,
            procedure: procedure.name,
            kind: "procedure_end",
            durationMs: Date.now() - startedAt,
            result: result.data,
            raw: result.display,
          });

          if (result.display && !emitter.hasStreamedText(result.display)) {
            emitter.emit({
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: result.display,
              },
            });
          }

          publishStoredMemoryCard(session, sessionId, runId, finalized.cell);
          session.events.publish(sessionId, {
            type: "run_completed",
            runId,
            procedure: procedure.name,
            completedAt: new Date().toISOString(),
            cell: finalized.cell,
            summary: finalized.summary,
            display: result.display,
            tokenUsage: emitter.currentTokenUsage,
          });
          markRunActivity();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const errorText = `Error: ${message}\n`;

          logger.write({
            spanId: rootSpanId,
            procedure: procedure.name,
            kind: "procedure_end",
            durationMs: Date.now() - startedAt,
            error: message,
          });

          ctx.print(errorText);
          const finalized = session.store.finalizeCell(rootCell, {
            summary: summarizeText(errorText),
          });

          session.events.publish(sessionId, {
            type: "run_failed",
            runId,
            procedure: procedure.name,
            completedAt: new Date().toISOString(),
            error: message,
            cell: finalized.cell,
          });
          markRunActivity();
        } finally {
          logger.close();
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

      session.events.publish(sessionId, {
        type: "run_failed",
        runId,
        procedure: procedure.name,
        completedAt: new Date().toISOString(),
        error: message,
      });
      markRunActivity();
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

function buildProcedureDispatchPrompt(
  procedureName: string,
  procedurePrompt: string,
  defaultAgentSelection?: DownstreamAgentSelection,
): string {
  return [
    "Nanoboss internal slash-command dispatch.",
    "This is an internal control message for the current persistent master conversation.",
    "Use the attached `procedure_dispatch` tool exactly once with the following JSON arguments.",
    JSON.stringify({
      name: procedureName,
      prompt: procedurePrompt,
      defaultAgentSelection,
    }),
    "Do not answer from your own knowledge.",
    "After the tool completes, reply with exactly the tool result text and nothing else.",
  ].join("\n\n");
}

export function extractProcedureDispatchResult(updates: acp.SessionUpdate[]): ProcedureDispatchResult | undefined {
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

function parseProcedureDispatchResultCandidate(value: unknown): ProcedureDispatchResult | undefined {
  if (isProcedureDispatchResult(value)) {
    return value;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isProcedureDispatchResult(parsed) ? parsed : undefined;
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

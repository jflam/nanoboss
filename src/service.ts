import type * as acp from "@agentclientprotocol/sdk";

import { getBuildLabel } from "./build-info.ts";
import { resolveDownstreamAgentConfig, toDownstreamAgentSelection } from "./config.ts";
import { CommandContextImpl, type SessionUpdateEmitter } from "./context.ts";
import { DefaultConversationSession } from "./default-session.ts";
import { disposeSessionMcpTransport } from "./mcp-attachment.ts";
import {
  collectUnsyncedProcedureMemoryCards,
  hasTopLevelNonDefaultProcedureHistory,
  renderProcedureMemoryPreamble,
  renderSessionToolGuidance,
} from "./memory-cards.ts";
import {
  mapSessionUpdateToFrontendEvents,
  SessionEventLog,
  toFrontendCommands,
  type FrontendCommand,
} from "./frontend-events.ts";
import { RunLogger } from "./logger.ts";
import { ProcedureRegistry } from "./registry.ts";
import { formatAgentBanner } from "./runtime-banner.ts";
import { shouldLoadDiskCommands } from "./runtime-mode.ts";
import {
  SessionStore,
  normalizeProcedureResult,
  summarizeText,
} from "./session-store.ts";
import type { AgentTokenUsage, DownstreamAgentConfig, DownstreamAgentSelection } from "./types.ts";

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
  ): { prompt: string; markSubmitted: () => void } {
    const cards = collectUnsyncedProcedureMemoryCards(
      session.store,
      session.syncedProcedureMemoryCellIds,
    );
    const blocks: string[] = [];
    const preamble = renderProcedureMemoryPreamble(cards);

    if (preamble) {
      blocks.push(preamble);
    } else if (hasTopLevelNonDefaultProcedureHistory(session.store)) {
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
      prepareDefaultPrompt: (prompt) => this.prepareDefaultPrompt(session, prompt),
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
      logger.close();
      session.abortController = undefined;
    }

    return { stopReason: "end_turn", runId };
  }
}

function getRunHeartbeatMs(): number {
  const value = Number(process.env.NANOBOSS_RUN_HEARTBEAT_MS ?? "5000");
  return Number.isFinite(value) && value > 0 ? value : 5000;
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

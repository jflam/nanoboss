import type * as acp from "@agentclientprotocol/sdk";

import { CommandContextImpl, type SessionUpdateEmitter } from "./context.ts";
import {
  mapSessionUpdateToFrontendEvents,
  SessionEventLog,
  toFrontendCommands,
  type FrontendCommand,
} from "./frontend-events.ts";
import { RunLogger } from "./logger.ts";
import { ProcedureRegistry } from "./registry.ts";
import {
  SessionStore,
  normalizeProcedureResult,
  summarizeText,
} from "./session-store.ts";

interface SessionState {
  cwd: string;
  store: SessionStore;
  events: SessionEventLog;
  abortController?: AbortController;
  commands: FrontendCommand[];
}

export interface SessionDescriptor {
  sessionId: string;
  cwd: string;
  commands: FrontendCommand[];
}

class CompositeSessionUpdateEmitter implements SessionUpdateEmitter {
  constructor(
    private readonly sessionId: string,
    private readonly runId: string,
    private readonly eventLog: SessionEventLog,
    private readonly delegate?: SessionUpdateEmitter,
  ) {}

  emit(update: acp.SessionUpdate): void {
    for (const event of mapSessionUpdateToFrontendEvents(this.runId, update)) {
      this.eventLog.publish(this.sessionId, event);
    }

    this.delegate?.emit(update);
  }

  flush(): Promise<void> {
    return this.delegate?.flush() ?? Promise.resolve();
  }
}

export class NanoAgentBossService {
  private readonly sessions = new Map<acp.SessionId, SessionState>();

  constructor(private readonly registry: ProcedureRegistry) {}

  static async create(): Promise<NanoAgentBossService> {
    const registry = new ProcedureRegistry();
    registry.loadBuiltins();
    await registry.loadFromDisk();
    return new NanoAgentBossService(registry);
  }

  getAvailableCommands(): acp.AvailableCommand[] {
    return this.registry.toAvailableCommands();
  }

  createSession(params: { cwd: string }): SessionDescriptor {
    const sessionId = crypto.randomUUID();
    const commands = toFrontendCommands(this.registry.toAvailableCommands());
    const state: SessionState = {
      cwd: params.cwd,
      store: new SessionStore({
        sessionId,
        cwd: params.cwd,
      }),
      events: new SessionEventLog(),
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
    };
  }

  getSessionEvents(sessionId: string): SessionEventLog | undefined {
    return this.sessions.get(sessionId)?.events;
  }

  cancel(sessionId: string): void {
    this.sessions.get(sessionId)?.abortController?.abort();
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

    session.events.publish(sessionId, {
      type: "run_started",
      runId,
      procedure: procedureName,
      prompt: commandPrompt,
      startedAt: new Date(startedAt).toISOString(),
    });

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

      return { stopReason: "end_turn", runId };
    }

    const emitter = new CompositeSessionUpdateEmitter(
      sessionId,
      runId,
      session.events,
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
      logger,
      registry: this.registry,
      procedureName: procedure.name,
      spanId: rootSpanId,
      emitter,
      store: session.store,
      cell: rootCell,
      signal: session.abortController.signal,
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

      if (result.display) {
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
      });
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
    } finally {
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

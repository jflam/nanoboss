import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

import { CommandContextImpl, type SessionUpdateEmitter } from "./context.ts";
import { RunLogger } from "./logger.ts";
import { ProcedureRegistry } from "./registry.ts";

interface SessionState {
  cwd: string;
  abortController?: AbortController;
}

class QueuedSessionUpdateEmitter implements SessionUpdateEmitter {
  private queue = Promise.resolve();

  constructor(
    private readonly connection: acp.AgentSideConnection,
    private readonly sessionId: acp.SessionId,
  ) {}

  emit(update: acp.SessionUpdate): void {
    this.queue = this.queue
      .then(() =>
        this.connection.sessionUpdate({
          sessionId: this.sessionId,
          update,
        }),
      )
      .catch((error: unknown) => {
        console.error("failed to emit session update", error);
      });
  }

  flush(): Promise<void> {
    return this.queue;
  }
}

class NanoAgentBoss implements acp.Agent {
  private readonly sessions = new Map<acp.SessionId, SessionState>();

  constructor(
    private readonly connection: acp.AgentSideConnection,
    private readonly registry: ProcedureRegistry,
  ) {}

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: {
        name: "nano-agentboss",
        version: "0.1.0",
      },
      agentCapabilities: {
        loadSession: false,
      },
    };
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, {
      cwd: params.cwd,
    });

    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: this.registry.toAvailableCommands(),
      },
    });

    return { sessionId };
  }

  async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    return {};
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }

    session.abortController?.abort();
    session.abortController = new AbortController();

    const emitter = new QueuedSessionUpdateEmitter(this.connection, params.sessionId);
    const logger = new RunLogger();
    const text = extractPromptText(params.prompt).trim();
    const { commandName, commandPrompt } = resolveCommand(text);
    const procedure = this.registry.get(commandName);
    const procedureName = procedure?.name ?? "default";
    const rootSpanId = logger.newSpan();
    const startedAt = Date.now();

    if (!procedure) {
      emitter.emit({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `Unknown command: /${commandName}\n`,
        },
      });
      await emitter.flush();
      return { stopReason: "end_turn" };
    }

    const ctx = new CommandContextImpl({
      cwd: session.cwd,
      logger,
      registry: this.registry,
      procedureName,
      spanId: rootSpanId,
      emitter,
      signal: session.abortController.signal,
    });

    logger.write({
      spanId: rootSpanId,
      procedure: procedureName,
      kind: "procedure_start",
      prompt: commandPrompt,
    });

    try {
      const result = await procedure.execute(commandPrompt, ctx);

      if (typeof result === "string" && result && !ctx.hasOutput) {
        ctx.print(result);
      }

      logger.write({
        spanId: rootSpanId,
        procedure: procedureName,
        kind: "procedure_end",
        durationMs: Date.now() - startedAt,
        raw: typeof result === "string" ? result : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.write({
        spanId: rootSpanId,
        procedure: procedureName,
        kind: "procedure_end",
        durationMs: Date.now() - startedAt,
        error: message,
      });
      ctx.print(`Error: ${message}\n`);
    } finally {
      emitter.emit({
        sessionUpdate: "available_commands_update",
        availableCommands: this.registry.toAvailableCommands(),
      });
      await emitter.flush();
      logger.close();
      session.abortController = undefined;
    }

    return { stopReason: "end_turn" };
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    this.sessions.get(params.sessionId)?.abortController?.abort();
  }
}

function extractPromptText(prompt: acp.PromptRequest["prompt"]): string {
  return prompt
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
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

async function main(): Promise<void> {
  const registry = new ProcedureRegistry();
  registry.loadBuiltins();
  await registry.loadFromDisk();

  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin),
  );
  const connection = new acp.AgentSideConnection(
    (connection) => new NanoAgentBoss(connection, registry),
    stream,
  );
  await connection.closed;
}

void main();

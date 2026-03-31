import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

import { NanoAgentBossService } from "./service.ts";

class QueuedSessionUpdateEmitter {
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
        })
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
  constructor(
    private readonly connection: acp.AgentSideConnection,
    private readonly service: NanoAgentBossService,
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
    const session = this.service.createSession({ cwd: params.cwd });

    await this.connection.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: this.service.getAvailableCommands(),
      },
    });

    return { sessionId: session.sessionId };
  }

  async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    return {};
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const emitter = new QueuedSessionUpdateEmitter(this.connection, params.sessionId);
    await this.service.prompt(params.sessionId, extractPromptText(params.prompt), emitter);
    return { stopReason: "end_turn" };
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    this.service.cancel(params.sessionId);
  }
}

function extractPromptText(prompt: acp.PromptRequest["prompt"]): string {
  return prompt
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

export async function runAcpServerCommand(): Promise<void> {
  const service = await NanoAgentBossService.create();
  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin),
  );
  const connection = new acp.AgentSideConnection(
    (connection) => new NanoAgentBoss(connection, service),
    stream,
  );
  await connection.closed;
}

if (import.meta.main) {
  await runAcpServerCommand();
}

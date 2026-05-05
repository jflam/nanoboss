import * as acp from "@agentclientprotocol/sdk";
import { getBuildLabel } from "@nanoboss/app-support";
import {
  promptInputFromAcpBlocks,
  setAgentRuntimeSessionRuntimeFactory,
} from "@nanoboss/agent-acp";
import { buildGlobalMcpStdioServer } from "@nanoboss/adapters-mcp";
import { NanobossService } from "@nanoboss/app-runtime";
import {
  buildTopLevelSessionMeta,
  extractDefaultAgentSelection,
  extractNanobossSessionId,
} from "./session-metadata.ts";
import { QueuedSessionUpdateEmitter } from "./session-update-emitter.ts";
import { Readable, Writable } from "node:stream";

class Nanoboss implements acp.Agent {
  constructor(
    private readonly connection: acp.AgentSideConnection,
    private readonly service: NanobossService,
  ) {}

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: {
        name: "nanoboss",
        version: "0.1.0",
      },
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {
          image: true,
        },
      },
    };
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const requestedSessionId = extractNanobossSessionId(params);
    const session = await this.service.createSessionReady({
      cwd: params.cwd,
      defaultAgentSelection: extractDefaultAgentSelection(params),
      sessionId: requestedSessionId,
    });

    await this.connection.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: this.service.getAvailableCommands(),
      },
    });

    return {
      sessionId: session.sessionId,
      _meta: buildTopLevelSessionMeta(),
    };
  }

  async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    return {};
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const emitter = new QueuedSessionUpdateEmitter(this.connection, params.sessionId);
    await this.service.promptSession(params.sessionId, promptInputFromAcpBlocks(params.prompt), emitter);
    return { stopReason: "end_turn" };
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    this.service.cancel(params.sessionId);
  }
}

export async function runAcpServerCommand(): Promise<void> {
  console.error(`${getBuildLabel()} acp-server ready`);
  setAgentRuntimeSessionRuntimeFactory(() => ({
    mcpServers: [buildGlobalMcpStdioServer()],
  }));
  const service = await NanobossService.create();
  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin),
  );
  const connection = new acp.AgentSideConnection(
    (connection) => new Nanoboss(connection, service),
    stream,
  );
  await connection.closed;
}

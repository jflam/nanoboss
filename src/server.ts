import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

import { getBuildLabel } from "./build-info.ts";
import { SESSION_MCP_SERVER_NAME } from "./session-mcp.ts";
import { sessionToolProcedures } from "./session-tool-procedures.ts";
import { NanobossService } from "./service.ts";
import type { DownstreamAgentSelection } from "./types.ts";

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
      },
    };
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const requestedSessionId = extractNanobossSessionId(params);
    const topLevelMcpAttached = hasTopLevelSessionMcp(params);
    const session = this.service.createSession({
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
      _meta: buildTopLevelSessionMeta({ topLevelMcpAttached }),
    };
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

export function buildTopLevelSessionMeta(
  params: { topLevelMcpAttached: boolean },
): NonNullable<acp.NewSessionResponse["_meta"]> {
  return {
    nanoboss: {
      sessionInspection: {
        topLevelMcpAttached: params.topLevelMcpAttached,
        surface: params.topLevelMcpAttached ? "mcp+commands" : "commands",
        commandNames: sessionToolProcedures.map((procedure) => procedure.name),
        note: params.topLevelMcpAttached
          ? "Session inspection is available through both top-level MCP tools and slash commands."
          : "ACP top-level sessions can advertise availableCommands, but session MCP must be attached by the creating client through mcpServers.",
      },
    },
  };
}

export function hasTopLevelSessionMcp(params: acp.NewSessionRequest): boolean {
  return params.mcpServers.some((server) => server.name === SESSION_MCP_SERVER_NAME);
}

export function extractNanobossSessionId(params: acp.NewSessionRequest): string | undefined {
  const record = params._meta;
  if (!record || typeof record !== "object") {
    return undefined;
  }

  const candidate = (record as Record<string, unknown>).nanobossSessionId;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function extractDefaultAgentSelection(params: acp.NewSessionRequest): DownstreamAgentSelection | undefined {
  const record = params._meta;
  if (!record || typeof record !== "object") {
    return undefined;
  }

  const candidate = (record as Record<string, unknown>).defaultAgentSelection;
  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }

  const provider = (candidate as Record<string, unknown>).provider;
  const model = (candidate as Record<string, unknown>).model;
  if (provider !== "claude" && provider !== "gemini" && provider !== "codex" && provider !== "copilot") {
    return undefined;
  }

  return {
    provider,
    model: typeof model === "string" ? model : undefined,
  };
}

function extractPromptText(prompt: acp.PromptRequest["prompt"]): string {
  return prompt
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

export async function runAcpServerCommand(): Promise<void> {
  console.error(`${getBuildLabel()} acp-server ready`);
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

if (import.meta.main) {
  await runAcpServerCommand();
}

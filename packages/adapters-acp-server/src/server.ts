import * as acp from "@agentclientprotocol/sdk";
import { getBuildLabel } from "@nanoboss/app-support";
import {
  promptInputFromAcpBlocks,
  setAgentRuntimeSessionRuntimeFactory,
} from "@nanoboss/agent-acp";
import { buildGlobalMcpStdioServer } from "@nanoboss/adapters-mcp";
import { NanobossService } from "@nanoboss/app-runtime";
import type {
  DownstreamAgentProvider,
  DownstreamAgentSelection,
} from "@nanoboss/contracts";
import {
  toProcedureUiSessionUpdate,
  type ProcedureUiEvent,
  type SessionUpdateEmitter,
} from "@nanoboss/procedure-engine";
import { Readable, Writable } from "node:stream";

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
        })
      )
      .catch((error: unknown) => {
        console.error("failed to emit session update", error);
      });
  }

  emitUiEvent(event: ProcedureUiEvent): void {
    this.emit(toProcedureUiSessionUpdate(event));
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

export function buildTopLevelSessionMeta(): NonNullable<acp.NewSessionResponse["_meta"]> {
  return {
    nanoboss: {
      sessionInspection: {
        surface: "global-mcp",
        note: "Session inspection is available through the globally registered `nanoboss` MCP server.",
      },
    },
  };
}

export function extractNanobossSessionId(params: acp.NewSessionRequest): string | undefined {
  const record = params._meta;
  if (!record || typeof record !== "object") {
    return undefined;
  }

  const candidate = (record as Record<string, unknown>).nanobossSessionId;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

export function extractDefaultAgentSelection(params: acp.NewSessionRequest): DownstreamAgentSelection | undefined {
  const record = params._meta;
  if (!record || typeof record !== "object") {
    return undefined;
  }

  return parseDownstreamAgentSelection((record as Record<string, unknown>).defaultAgentSelection);
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

const DOWNSTREAM_AGENT_PROVIDERS: DownstreamAgentProvider[] = ["claude", "gemini", "codex", "copilot"];

function parseDownstreamAgentSelection(value: unknown): DownstreamAgentSelection | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const provider = typeof record.provider === "string" && DOWNSTREAM_AGENT_PROVIDERS.includes(record.provider as DownstreamAgentProvider)
    ? record.provider as DownstreamAgentProvider
    : undefined;
  if (!provider) {
    return undefined;
  }

  const model = typeof record.model === "string" && record.model.trim().length > 0 ? record.model : undefined;
  return model === undefined ? { provider } : { provider, model };
}

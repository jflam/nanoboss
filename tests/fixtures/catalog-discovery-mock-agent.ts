import * as acp from "@agentclientprotocol/sdk";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Readable, Writable } from "node:stream";

const LOG_PATH = process.env.DISCOVERY_AGENT_LOG?.trim() || undefined;

class CatalogDiscoveryMockAgent implements acp.Agent {
  private readonly sessions = new Set<string>();

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: {
        name: "catalog-discovery-mock-agent",
        version: "0.1.0",
      },
      agentCapabilities: {
        sessionCapabilities: {
          close: {},
        },
      },
    };
  }

  async newSession(_params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = crypto.randomUUID();
    this.sessions.add(sessionId);
    writeLog({ kind: "new_session", sessionId });

    return {
      sessionId,
      models: {
        availableModels: [
          {
            modelId: "gpt-5.4-mini",
            name: "GPT-5.4 Mini",
            description: "Fast frontier mini",
          },
          {
            modelId: "claude-opus-4.7",
            name: "Claude Opus 4.7",
          },
        ],
        currentModelId: "gpt-5.4",
      },
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "gpt-5.4",
          options: [
            {
              group: "openai",
              name: "OpenAI",
              options: [
                {
                  value: "gpt-5.4",
                  name: "GPT-5.4",
                  description: "Primary frontier model",
                },
                {
                  value: "gpt-5.4-mini",
                  name: "GPT-5.4 Mini",
                },
              ],
            },
            {
              group: "anthropic",
              name: "Anthropic",
              options: [
                {
                  value: "claude-opus-4.7",
                  name: "Claude Opus 4.7",
                  description: "Premium reasoning model",
                },
              ],
            },
          ],
        },
        {
          id: "tools",
          name: "Tools",
          type: "boolean",
          currentValue: true,
        },
      ],
    };
  }

  async unstable_closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
    this.assertSession(params.sessionId);
    this.sessions.delete(params.sessionId);
    writeLog({ kind: "close_session", sessionId: params.sessionId });
    return {};
  }

  async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    return {};
  }

  async prompt(_params: acp.PromptRequest): Promise<acp.PromptResponse> {
    return { stopReason: "end_turn" };
  }

  async cancel(_params: acp.CancelNotification): Promise<void> {
    // no-op
  }

  private assertSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
  }
}

function writeLog(entry: Record<string, unknown>): void {
  if (!LOG_PATH) {
    return;
  }

  mkdirSync(dirname(LOG_PATH), { recursive: true });
  appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
}

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);
const connection = new acp.AgentSideConnection(
  () => new CatalogDiscoveryMockAgent(),
  stream,
);
await connection.closed;

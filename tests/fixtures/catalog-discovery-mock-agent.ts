import * as acp from "@agentclientprotocol/sdk";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Readable, Writable } from "node:stream";

const LOG_PATH = process.env.DISCOVERY_AGENT_LOG?.trim() || undefined;
const PROVIDER = process.env.DISCOVERY_AGENT_PROVIDER?.trim() || "copilot";
const FAIL_PHASE = process.env.DISCOVERY_AGENT_FAIL?.trim() || undefined;

class CatalogDiscoveryMockAgent implements acp.Agent {
  private readonly sessions = new Map<string, { currentModel?: string }>();

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
    maybeFail("new-session");
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, { currentModel: getInitialModel() });
    writeLog({ kind: "new_session", sessionId });

    return {
      sessionId,
      models: getAvailableModels(),
      configOptions: getConfigOptions(getInitialModel()),
    };
  }

  async setSessionConfigOption(
    params: acp.SetSessionConfigOptionRequest,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    maybeFail("set-config");
    this.assertSession(params.sessionId);
    const value = "value" in params && typeof params.value === "string" ? params.value : undefined;
    if (params.configId === "model" && value) {
      this.sessions.get(params.sessionId)!.currentModel = value;
    }

    writeLog({
      kind: "set_config",
      sessionId: params.sessionId,
      configId: params.configId,
      value,
    });

    return {
      configOptions: getConfigOptions(this.sessions.get(params.sessionId)?.currentModel ?? getInitialModel()),
    };
  }

  async unstable_closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
    this.assertSession(params.sessionId);
    writeLog({ kind: "close_session", sessionId: params.sessionId });
    this.sessions.delete(params.sessionId);
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

function maybeFail(phase: "new-session" | "set-config"): void {
  if (FAIL_PHASE === phase) {
    throw new Error(`Mock catalog discovery failed during ${phase}.`);
  }
}

function getInitialModel(): string {
  switch (PROVIDER) {
    case "copilot":
      return "gpt-5.4";
    case "codex":
      return "gpt-5.4";
    case "claude":
      return "opusplan";
    case "gemini":
      return "gemini-3-pro-preview";
    default:
      throw new Error(`Unsupported discovery provider fixture: ${PROVIDER}`);
  }
}

function getAvailableModels(): acp.SessionModelState {
  switch (PROVIDER) {
    case "copilot":
      return {
        availableModels: [
          {
            modelId: "gpt-4.1",
            name: "GPT-4.1",
            description: "Fast chat model",
          },
          {
            modelId: "gpt-5.4",
            name: "GPT-5.4",
          },
          {
            modelId: "claude-opus-4.7",
            name: "Claude Opus 4.7",
          },
        ],
        currentModelId: "gpt-5.4",
      };
    case "codex":
      return {
        availableModels: [
          {
            modelId: "gpt-5.4/xhigh",
            name: "GPT-5.4 (Max reasoning)",
          },
          {
            modelId: "gpt-5.4/high",
            name: "GPT-5.4 (High reasoning)",
          },
          {
            modelId: "gpt-5.4/medium",
            name: "GPT-5.4 (Balanced)",
          },
          {
            modelId: "gpt-5.2-codex/high",
            name: "GPT-5.2 Codex (High)",
          },
          {
            modelId: "gpt-5.2-codex/medium",
            name: "GPT-5.2 Codex (Medium)",
          },
          {
            modelId: "gpt-5.2-codex/low",
            name: "GPT-5.2 Codex (Low)",
          },
        ],
        currentModelId: "gpt-5.4/medium",
      };
    case "claude":
      return {
        availableModels: [
          {
            modelId: "default",
            name: "Default",
            description: "Account-dependent default model",
          },
          {
            modelId: "sonnet",
            name: "Sonnet",
            description: "Everyday Claude model",
          },
          {
            modelId: "auto",
            name: "Auto",
            description: "Let Claude choose",
          },
        ],
        currentModelId: "sonnet",
      };
    case "gemini":
      return {
        availableModels: [
          {
            modelId: "auto",
            name: "Auto",
            description: "Let Gemini choose",
          },
          { modelId: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
          { modelId: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
        ],
        currentModelId: "auto",
      };
    default:
      throw new Error(`Unsupported discovery provider fixture: ${PROVIDER}`);
  }
}

function getConfigOptions(currentModel: string): acp.SessionConfigOption[] {
  switch (PROVIDER) {
    case "copilot":
      return [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: currentModel,
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
                  value: "gpt-4.1",
                  name: "GPT-4.1",
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
        ...getCopilotReasoningOption(currentModel),
      ];
    case "codex":
      return [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: currentModel,
          options: [
            {
              value: "gpt-5.4",
              name: "GPT-5.4",
              description: "Latest frontier model",
            },
            {
              value: "gpt-5.2-codex",
              name: "GPT-5.2 Codex",
            },
          ],
        },
      ];
    case "claude":
      return [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: currentModel,
          options: [
            {
              value: "default",
              name: "Default",
              description: "Account-dependent default model",
            },
            {
              value: "sonnet",
              name: "Sonnet",
            },
            {
              value: "opusplan",
              name: "Opus Plan",
              description: "Hidden config-only model",
            },
          ],
        },
      ];
    case "gemini":
      return [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: currentModel,
          options: [
            {
              value: "auto",
              name: "Auto",
            },
            {
              value: "gemini-2.5-pro",
              name: "Gemini 2.5 Pro",
            },
            {
              value: "gemini-2.5-flash",
              name: "Gemini 2.5 Flash",
            },
            {
              value: "gemini-3-pro-preview",
              name: "Gemini 3 Pro Preview",
            },
          ],
        },
      ];
    default:
      throw new Error(`Unsupported discovery provider fixture: ${PROVIDER}`);
  }
}

function getCopilotReasoningOption(currentModel: string): acp.SessionConfigOption[] {
  if (currentModel === "gpt-5.4") {
    return [{
      id: "reasoning_effort",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
        { value: "xhigh", name: "Extra High" },
      ],
    }];
  }

  if (currentModel === "claude-opus-4.7") {
    return [{
      id: "reasoning_effort",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: "high",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    }];
  }

  return [];
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

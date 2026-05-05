import type * as acp from "@agentclientprotocol/sdk";
import type {
  DownstreamAgentProvider,
  DownstreamAgentSelection,
} from "@nanoboss/contracts";

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

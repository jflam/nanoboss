import type {
  AgentTokenSnapshot,
  AgentTokenUsage,
  DownstreamAgentConfig,
} from "./types.ts";

export function normalizeAgentTokenUsage(
  snapshot: AgentTokenSnapshot | undefined,
  fallbackConfig?: Pick<DownstreamAgentConfig, "provider" | "model">,
): AgentTokenUsage | undefined {
  if (!snapshot) {
    return undefined;
  }

  return {
    provider: snapshot.provider ?? fallbackConfig?.provider,
    model: snapshot.model ?? fallbackConfig?.model,
    sessionId: snapshot.sessionId,
    source: snapshot.source,
    capturedAt: snapshot.capturedAt,
    currentContextTokens: snapshot.usedContextTokens,
    maxContextTokens: snapshot.contextWindowTokens,
    systemTokens: snapshot.systemTokens,
    conversationTokens: snapshot.conversationTokens,
    toolDefinitionsTokens: snapshot.toolDefinitionsTokens,
    inputTokens: snapshot.inputTokens,
    outputTokens: snapshot.outputTokens,
    cacheReadTokens: snapshot.cacheReadTokens,
    cacheWriteTokens: snapshot.cacheWriteTokens,
    totalTrackedTokens: snapshot.totalTokens,
  };
}

export function getAgentTokenUsagePercent(usage: Pick<AgentTokenUsage, "currentContextTokens" | "maxContextTokens">): number | undefined {
  if (usage.currentContextTokens === undefined || usage.maxContextTokens === undefined || usage.maxContextTokens <= 0) {
    return undefined;
  }

  return (usage.currentContextTokens / usage.maxContextTokens) * 100;
}

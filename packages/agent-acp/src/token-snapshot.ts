import type * as acp from "@agentclientprotocol/sdk";

import { normalizeAgentTokenUsage } from "./token-usage.ts";
import type { AgentTokenSnapshot, DownstreamAgentConfig } from "./types.ts";

export function snapshotFromUsageUpdate(
  config: DownstreamAgentConfig,
  sessionId: acp.SessionId,
  updates: acp.SessionUpdate[],
): AgentTokenSnapshot | undefined {
  const last = [...updates].reverse().find(isUsageUpdate);
  if (!last) {
    return undefined;
  }

  return {
    provider: config.provider,
    model: config.model,
    sessionId,
    source: "acp_usage_update",
    contextWindowTokens: last.size,
    usedContextTokens: last.used,
  };
}

export function snapshotFromPromptResponse(
  config: DownstreamAgentConfig,
  sessionId: acp.SessionId,
  promptResponse?: acp.PromptResponse,
): AgentTokenSnapshot | undefined {
  const usage = promptResponse?.usage;
  if (!usage) {
    return undefined;
  }

  const cacheReadTokens = usage.cachedReadTokens ?? 0;
  const cacheWriteTokens = usage.cachedWriteTokens ?? 0;
  const inputTokens = Math.max(0, usage.inputTokens - cacheReadTokens);

  return {
    provider: config.provider,
    model: config.model,
    sessionId,
    source: "acp_prompt_response",
    inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: usage.totalTokens,
  };
}

export function mergeTokenSnapshots(
  ...snapshots: Array<AgentTokenSnapshot | undefined>
): AgentTokenSnapshot | undefined {
  const primary = snapshots.find((snapshot) => snapshot !== undefined);
  if (!primary) {
    return undefined;
  }

  return {
    provider: pickSnapshotField(snapshots, (snapshot) => snapshot.provider),
    model: pickSnapshotField(snapshots, (snapshot) => snapshot.model),
    sessionId: pickSnapshotField(snapshots, (snapshot) => snapshot.sessionId),
    source: primary.source,
    capturedAt: pickSnapshotField(snapshots, (snapshot) => snapshot.capturedAt),
    contextWindowTokens: pickSnapshotField(snapshots, (snapshot) => snapshot.contextWindowTokens),
    usedContextTokens: pickSnapshotField(snapshots, (snapshot) => snapshot.usedContextTokens),
    systemTokens: pickSnapshotField(snapshots, (snapshot) => snapshot.systemTokens),
    conversationTokens: pickSnapshotField(snapshots, (snapshot) => snapshot.conversationTokens),
    toolDefinitionsTokens: pickSnapshotField(snapshots, (snapshot) => snapshot.toolDefinitionsTokens),
    inputTokens: pickSnapshotField(snapshots, (snapshot) => snapshot.inputTokens),
    outputTokens: pickSnapshotField(snapshots, (snapshot) => snapshot.outputTokens),
    cacheReadTokens: pickSnapshotField(snapshots, (snapshot) => snapshot.cacheReadTokens),
    cacheWriteTokens: pickSnapshotField(snapshots, (snapshot) => snapshot.cacheWriteTokens),
    totalTokens: pickSnapshotField(snapshots, (snapshot) => snapshot.totalTokens),
  };
}

export function isTerminalToolCallUpdate(
  update: acp.SessionUpdate,
): update is Extract<acp.SessionUpdate, { sessionUpdate: "tool_call_update" }> {
  const status = update.sessionUpdate === "tool_call_update"
    ? update.status as string | null | undefined
    : undefined;
  return (
    update.sessionUpdate === "tool_call_update"
    && (
      status === "completed"
      || status === "failed"
      || status === "cancelled"
    )
  );
}

export function attachTokenUsageToRawOutput(
  rawOutput: unknown,
  tokenSnapshot: AgentTokenSnapshot,
  config: DownstreamAgentConfig,
): Record<string, unknown> | undefined {
  const tokenUsage = normalizeAgentTokenUsage(tokenSnapshot, config);
  if (!tokenUsage) {
    return undefined;
  }

  if (rawOutput === undefined) {
    return {
      tokenSnapshot,
      tokenUsage,
    };
  }

  if (!isRecord(rawOutput)) {
    return undefined;
  }

  return {
    ...rawOutput,
    tokenSnapshot,
    tokenUsage,
  };
}

function pickSnapshotField<T>(
  snapshots: Array<AgentTokenSnapshot | undefined>,
  picker: (snapshot: AgentTokenSnapshot) => T | undefined,
): T | undefined {
  for (const snapshot of snapshots) {
    if (!snapshot) {
      continue;
    }

    const value = picker(snapshot);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function isUsageUpdate(
  update: acp.SessionUpdate,
): update is Extract<acp.SessionUpdate, { sessionUpdate: "usage_update" }> {
  return update.sessionUpdate === "usage_update";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

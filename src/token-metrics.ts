import type * as acp from "@agentclientprotocol/sdk";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentTokenSnapshot, DownstreamAgentConfig } from "./types.ts";

interface CollectTokenSnapshotParams {
  childPid?: number | undefined;
  config: DownstreamAgentConfig;
  promptResponse?: acp.PromptResponse;
  sessionId: acp.SessionId;
  updates: acp.SessionUpdate[];
}

export async function collectTokenSnapshot(
  params: CollectTokenSnapshotParams,
): Promise<AgentTokenSnapshot | undefined> {
  const { config } = params;

  if (config.provider === "codex") {
    const codex = snapshotFromUsageUpdate(config, params.sessionId, params.updates);
    if (codex) {
      return codex;
    }
  }

  if (config.provider === "copilot") {
    const copilot = await collectCopilotTokenSnapshot(params);
    if (copilot) {
      return copilot;
    }
  }

  if (config.provider === "claude") {
    const claude = await collectClaudeTokenSnapshot(params);
    if (claude) {
      return claude;
    }
  }

  return snapshotFromPromptResponse(config, params.sessionId, params.promptResponse);
}

function snapshotFromUsageUpdate(
  config: DownstreamAgentConfig,
  sessionId: acp.SessionId,
  updates: acp.SessionUpdate[],
): AgentTokenSnapshot | undefined {
  const last = [...updates].reverse().find((update) => update.sessionUpdate === "usage_update");
  if (!last || last.sessionUpdate !== "usage_update") {
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

function snapshotFromPromptResponse(
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

async function collectClaudeTokenSnapshot(
  params: CollectTokenSnapshotParams,
): Promise<AgentTokenSnapshot | undefined> {
  const path = join(homedir(), ".claude", "debug", `${params.sessionId}.txt`);

  return await retryRead(() => {
    if (!existsSync(path)) {
      return undefined;
    }

    return parseClaudeDebugMetrics(readFileSync(path, "utf8"), params.config, params.sessionId);
  });
}

async function collectCopilotTokenSnapshot(
  params: CollectTokenSnapshotParams,
): Promise<AgentTokenSnapshot | undefined> {
  const sessionStateDir = join(homedir(), ".copilot", "session-state", params.sessionId);
  const processLogPath = findCopilotProcessLog(params.childPid);

  const fromLog = await retryRead(() => {
    if (!processLogPath || !existsSync(processLogPath)) {
      return undefined;
    }

    return parseCopilotLogMetrics(readFileSync(processLogPath, "utf8"), params.config, params.sessionId);
  });
  if (fromLog) {
    return fromLog;
  }

  return await retryRead(() => {
    const eventsPath = join(sessionStateDir, "events.jsonl");
    if (!existsSync(eventsPath)) {
      return undefined;
    }

    return parseCopilotSessionState(readFileSync(eventsPath, "utf8"), params.config, params.sessionId);
  });
}

async function retryRead<T>(reader: () => T | undefined): Promise<T | undefined> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const value = reader();
    if (value !== undefined) {
      return value;
    }
    await Bun.sleep(100);
  }

  return undefined;
}

function findCopilotProcessLog(childPid: number | undefined): string | undefined {
  if (!childPid) {
    return undefined;
  }

  const dir = join(homedir(), ".copilot", "logs");
  if (!existsSync(dir)) {
    return undefined;
  }

  const suffix = `-${childPid}.log`;
  const entries = readdirSync(dir)
    .filter((entry) => entry.endsWith(suffix))
    .map((entry) => join(dir, entry))
    .sort((left, right) => right.localeCompare(left));

  return entries[0];
}

export function parseClaudeDebugMetrics(
  text: string,
  config: DownstreamAgentConfig,
  sessionId: acp.SessionId,
): AgentTokenSnapshot | undefined {
  const matches = [...text.matchAll(/^(\S+) \[DEBUG\] autocompact: tokens=(\d+) threshold=(\d+) effectiveWindow=(\d+)$/gm)];
  const last = matches.at(-1);
  if (!last) {
    return undefined;
  }

  return {
    provider: config.provider,
    model: config.model,
    sessionId,
    source: "claude_debug",
    capturedAt: last[1],
    usedContextTokens: Number(last[2]),
    contextWindowTokens: Number(last[4]),
  };
}

export function parseCopilotLogMetrics(
  text: string,
  config: DownstreamAgentConfig,
  sessionId: acp.SessionId,
): AgentTokenSnapshot | undefined {
  const telemetryBlocks = extractPrettyJsonBlocks(text, "[INFO] [Telemetry] cli.telemetry:\n");
  const sessionUsage = [...telemetryBlocks].reverse().find((block) => {
    return isCopilotTelemetryBlock(block, sessionId, "session_usage_info");
  }) as CopilotSessionUsageBlock | undefined;
  const assistantUsage = [...telemetryBlocks].reverse().find((block) => {
    return isCopilotTelemetryBlock(block, sessionId, "assistant_usage");
  }) as CopilotAssistantUsageBlock | undefined;

  if (!sessionUsage && !assistantUsage) {
    return undefined;
  }

  const cacheReadTokens = assistantUsage?.metrics?.cache_read_tokens ?? 0;
  const cacheWriteTokens = assistantUsage?.metrics?.cache_write_tokens ?? 0;
  const inputTokens = assistantUsage
    ? assistantUsage.metrics.input_tokens_uncached ?? Math.max(0, assistantUsage.metrics.input_tokens - cacheReadTokens)
    : undefined;
  const outputTokens = assistantUsage?.metrics?.output_tokens;

  return {
    provider: config.provider,
    model: config.model,
    sessionId,
    source: "copilot_log",
    capturedAt: sessionUsage?.created_at ?? assistantUsage?.created_at,
    contextWindowTokens: sessionUsage?.metrics?.token_limit,
    usedContextTokens: sessionUsage?.metrics?.current_tokens,
    systemTokens: sessionUsage?.metrics?.system_tokens,
    conversationTokens: sessionUsage?.metrics?.conversation_tokens,
    toolDefinitionsTokens: sessionUsage?.metrics?.tool_definitions_tokens,
    inputTokens,
    outputTokens,
    cacheReadTokens: assistantUsage ? cacheReadTokens : undefined,
    cacheWriteTokens: assistantUsage ? cacheWriteTokens : undefined,
    totalTokens:
      inputTokens !== undefined && outputTokens !== undefined
        ? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
        : undefined,
  };
}

export function parseCopilotSessionState(
  text: string,
  config: DownstreamAgentConfig,
  sessionId: acp.SessionId,
): AgentTokenSnapshot | undefined {
  const lines = text.split(/\n+/).filter(Boolean);
  let shutdown: CopilotShutdownEvent["data"] | undefined;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as CopilotShutdownEvent;
      if (parsed.type === "session.shutdown") {
        shutdown = parsed.data;
      }
    } catch {
      // ignore malformed lines
    }
  }

  if (!shutdown) {
    return undefined;
  }

  const model = shutdown.currentModel;
  const usage = model ? shutdown.modelMetrics?.[model]?.usage : undefined;

  return {
    provider: config.provider,
    model: config.model,
    sessionId,
    source: "copilot_session_state",
    contextWindowTokens: undefined,
    usedContextTokens: shutdown.currentTokens,
    systemTokens: shutdown.systemTokens,
    conversationTokens: shutdown.conversationTokens,
    toolDefinitionsTokens: shutdown.toolDefinitionsTokens,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    cacheReadTokens: usage?.cacheReadTokens,
    cacheWriteTokens: usage?.cacheWriteTokens,
    totalTokens: usage
      ? usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
      : undefined,
  };
}

function extractPrettyJsonBlocks(text: string, marker: string): unknown[] {
  const results: unknown[] = [];
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const markerIndex = text.indexOf(marker, searchFrom);
    if (markerIndex < 0) {
      break;
    }

    const start = text.indexOf("{", markerIndex + marker.length);
    if (start < 0) {
      break;
    }

    const end = findJsonObjectEnd(text, start);
    if (end < 0) {
      break;
    }

    const raw = text.slice(start, end + 1);
    try {
      results.push(JSON.parse(raw));
    } catch {
      // ignore malformed block
    }

    searchFrom = end + 1;
  }

  return results;
}

function findJsonObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === undefined) {
      break;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function isCopilotTelemetryBlock(
  value: unknown,
  sessionId: acp.SessionId,
  kind: string,
): value is CopilotSessionUsageBlock | CopilotAssistantUsageBlock {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { kind?: unknown; session_id?: unknown };
  return candidate.kind === kind && candidate.session_id === sessionId;
}

interface CopilotSessionUsageBlock {
  kind: "session_usage_info";
  created_at?: string;
  session_id: string;
  metrics: {
    token_limit: number;
    current_tokens: number;
    system_tokens: number;
    conversation_tokens: number;
    tool_definitions_tokens: number;
  };
}

interface CopilotAssistantUsageBlock {
  kind: "assistant_usage";
  created_at?: string;
  session_id: string;
  metrics: {
    input_tokens: number;
    input_tokens_uncached?: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
  };
}

interface CopilotShutdownEvent {
  type: string;
  data?: {
    currentModel?: string;
    currentTokens?: number;
    systemTokens?: number;
    conversationTokens?: number;
    toolDefinitionsTokens?: number;
    modelMetrics?: Record<string, {
      usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
      };
    }>;
  };
}

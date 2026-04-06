import type * as acp from "@agentclientprotocol/sdk";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { normalizeAgentTokenUsage } from "./token-usage.ts";
import type { AgentTokenSnapshot, DownstreamAgentConfig } from "../core/types.ts";

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
  const usageSnapshot = snapshotFromUsageUpdate(config, params.sessionId, params.updates);
  const promptResponseSnapshot = snapshotFromPromptResponse(config, params.sessionId, params.promptResponse);

  if (config.provider === "codex") {
    return mergeTokenSnapshots(usageSnapshot, promptResponseSnapshot);
  }

  if (config.provider === "copilot") {
    return mergeTokenSnapshots(
      await collectCopilotTokenSnapshot(params),
      usageSnapshot,
      promptResponseSnapshot,
    );
  }

  if (config.provider === "claude") {
    return mergeTokenSnapshots(
      await collectClaudeTokenSnapshot(params),
      usageSnapshot,
      promptResponseSnapshot,
    );
  }

  return mergeTokenSnapshots(usageSnapshot, promptResponseSnapshot);
}

export async function enrichToolCallUpdateWithTokenUsage(
  params: {
    childPid?: number | undefined;
    config: DownstreamAgentConfig;
    sessionId: acp.SessionId;
    update: acp.SessionUpdate;
    updates: acp.SessionUpdate[];
  },
): Promise<{ update: acp.SessionUpdate; tokenSnapshot?: AgentTokenSnapshot }> {
  if (!isTerminalToolCallUpdate(params.update)) {
    return { update: params.update };
  }

  const tokenSnapshot = await collectTokenSnapshot({
    childPid: params.childPid,
    config: params.config,
    sessionId: params.sessionId,
    updates: params.updates,
  });
  if (!tokenSnapshot) {
    return { update: params.update };
  }

  const rawOutput = attachTokenUsageToRawOutput(params.update.rawOutput, tokenSnapshot, params.config);
  if (!rawOutput) {
    return {
      update: params.update,
      tokenSnapshot,
    };
  }

  return {
    update: {
      ...params.update,
      rawOutput,
    },
    tokenSnapshot,
  };
}

function snapshotFromUsageUpdate(
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

function mergeTokenSnapshots(
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

function isTerminalToolCallUpdate(
  update: acp.SessionUpdate,
): update is Extract<acp.SessionUpdate, { sessionUpdate: "tool_call_update" }> {
  return (
    update.sessionUpdate === "tool_call_update"
    && (
      update.status === "completed"
      || update.status === "failed"
      || update.status === "cancelled"
    )
  );
}

function attachTokenUsageToRawOutput(
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveHomeDir(): string {
  return process.env.HOME?.trim() || homedir();
}

async function collectClaudeTokenSnapshot(
  params: CollectTokenSnapshotParams,
): Promise<AgentTokenSnapshot | undefined> {
  const path = join(resolveHomeDir(), ".claude", "debug", `${params.sessionId}.txt`);

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
  const sessionStateDir = join(resolveHomeDir(), ".copilot", "session-state", params.sessionId);

  const fromLog = await retryRead(() => {
    for (const processLogPath of findCopilotProcessLogs(params.childPid)) {
      if (!existsSync(processLogPath)) {
        continue;
      }

      const snapshot = parseCopilotLogMetrics(readFileSync(processLogPath, "utf8"), params.config, params.sessionId);
      if (snapshot) {
        return snapshot;
      }
    }

    return undefined;
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

function findCopilotProcessLogs(childPid: number | undefined): string[] {
  if (!childPid) {
    return [];
  }

  const dir = join(resolveHomeDir(), ".copilot", "logs");
  if (!existsSync(dir)) {
    return [];
  }

  const entries = readdirSync(dir);
  const candidatePids = collectCopilotProcessFamilyPids(childPid);
  const exactMatches = findCopilotLogsForPids(dir, candidatePids, entries);
  if (exactMatches.length > 0) {
    return exactMatches;
  }

  return findMostRecentCopilotLogs(dir, entries, 8);
}

export function findCopilotLogsForPids(
  dir: string,
  pids: number[],
  entries: string[] = readdirSync(dir),
): string[] {
  const suffixes = new Set(pids.map((pid) => `-${pid}.log`));
  return entries
    .filter((entry) => {
      for (const suffix of suffixes) {
        if (entry.endsWith(suffix)) {
          return true;
        }
      }
      return false;
    })
    .map((entry) => join(dir, entry))
    .sort((left, right) => right.localeCompare(left));
}

export function parseDescendantPidsFromPsOutput(psOutput: string, rootPid: number): number[] {
  const children = new Map<number, number[]>();

  for (const line of psOutput.split(/\n+/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+/);
    if (!match) {
      continue;
    }

    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }

  const descendants: number[] = [];
  const queue = [...(children.get(rootPid) ?? [])];
  const seen = new Set<number>();

  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined || seen.has(pid)) {
      continue;
    }

    seen.add(pid);
    descendants.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }

  return descendants;
}

function collectCopilotProcessFamilyPids(rootPid: number): number[] {
  const psOutput = readPsOutput();
  return psOutput ? [rootPid, ...parseDescendantPidsFromPsOutput(psOutput, rootPid)] : [rootPid];
}

function readPsOutput(): string | undefined {
  const result = Bun.spawnSync({
    cmd: ["ps", "-ax", "-o", "pid=,ppid=,command="],
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    return undefined;
  }

  return new TextDecoder().decode(result.stdout);
}

function findMostRecentCopilotLogs(dir: string, entries: string[], limit: number): string[] {
  return entries
    .filter((entry) => entry.startsWith("process-") && entry.endsWith(".log"))
    .sort((left, right) => right.localeCompare(left))
    .slice(0, limit)
    .map((entry) => join(dir, entry));
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

  const cacheReadTokens = assistantUsage ? assistantUsage.metrics.cache_read_tokens : 0;
  const cacheWriteTokens = assistantUsage ? assistantUsage.metrics.cache_write_tokens : 0;
  const inputTokens = assistantUsage
    ? assistantUsage.metrics.input_tokens_uncached ?? Math.max(0, assistantUsage.metrics.input_tokens - cacheReadTokens)
    : undefined;
  const outputTokens = assistantUsage?.metrics.output_tokens;

  return {
    provider: config.provider,
    model: config.model,
    sessionId,
    source: "copilot_log",
    capturedAt: sessionUsage?.created_at ?? assistantUsage?.created_at,
    contextWindowTokens: sessionUsage?.metrics.token_limit,
    usedContextTokens: sessionUsage?.metrics.current_tokens,
    systemTokens: sessionUsage?.metrics.system_tokens,
    conversationTokens: sessionUsage?.metrics.conversation_tokens,
    toolDefinitionsTokens: sessionUsage?.metrics.tool_definitions_tokens,
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

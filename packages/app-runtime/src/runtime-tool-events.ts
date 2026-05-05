import type * as acp from "@agentclientprotocol/sdk";

import { normalizeAgentTokenUsage } from "@nanoboss/agent-acp";
import type { AgentTokenUsage } from "@nanoboss/contracts";
import { normalizeToolName } from "@nanoboss/procedure-sdk";

import type { RuntimeEvent } from "./runtime-events.ts";
import {
  summarizeToolCallStart,
  summarizeToolCallUpdate,
} from "./tool-call-preview.ts";

interface NanobossToolMeta {
  toolKind?: string;
  parentToolCallId?: string;
  transcriptVisible?: boolean;
  removeOnTerminal?: boolean;
}

export function mapToolCallToRuntimeEvent(
  runId: string,
  update: Extract<acp.SessionUpdate, { sessionUpdate: "tool_call" }>,
): RuntimeEvent {
  const toolMeta = getNanobossToolMeta(update);
  const toolKind = toolMeta.toolKind ?? String(update.kind);
  const toolName = normalizeToolName({ title: update.title, kind: toolKind });
  const preview = summarizeToolCallStart({
    toolName,
    title: update.title,
    kind: toolKind,
  }, update.rawInput);

  return {
    type: "tool_started",
    runId,
    toolCallId: update.toolCallId,
    ...(toolMeta.parentToolCallId ? { parentToolCallId: toolMeta.parentToolCallId } : {}),
    ...(toolMeta.transcriptVisible !== undefined ? { transcriptVisible: toolMeta.transcriptVisible } : {}),
    ...(toolMeta.removeOnTerminal !== undefined ? { removeOnTerminal: toolMeta.removeOnTerminal } : {}),
    title: update.title,
    kind: toolKind,
    ...(toolName ? { toolName } : {}),
    status: update.status ?? undefined,
    callPreview: preview.callPreview,
    rawInput: update.rawInput,
  };
}

export function mapToolCallUpdateToRuntimeEvents(
  runId: string,
  update: Extract<acp.SessionUpdate, { sessionUpdate: "tool_call_update" }>,
): RuntimeEvent[] {
  const toolMeta = getNanobossToolMeta(update);
  const status = normalizeToolUpdateStatus(update);
  const toolName = update.title ? normalizeToolName({ title: update.title }) : undefined;
  const preview = summarizeToolCallUpdate({
    toolName,
    title: update.title ?? undefined,
  }, update.rawOutput);
  const events: RuntimeEvent[] = [
    {
      type: "tool_updated",
      runId,
      toolCallId: update.toolCallId,
      ...(toolMeta.parentToolCallId ? { parentToolCallId: toolMeta.parentToolCallId } : {}),
      ...(toolMeta.transcriptVisible !== undefined ? { transcriptVisible: toolMeta.transcriptVisible } : {}),
      ...(toolMeta.removeOnTerminal !== undefined ? { removeOnTerminal: toolMeta.removeOnTerminal } : {}),
      title: update.title ?? undefined,
      ...(toolName ? { toolName } : {}),
      status,
      resultPreview: preview.resultPreview,
      errorPreview: preview.errorPreview,
      durationMs: preview.durationMs,
      rawOutput: update.rawOutput,
    },
  ];

  const usage = extractTokenUsage(update.rawOutput);
  if (usage) {
    events.push({
      type: "token_usage",
      runId,
      usage,
      sourceUpdate: "tool_call_update",
      toolCallId: update.toolCallId,
      status,
    });
  }

  return events;
}

function getNanobossToolMeta(
  update: Extract<acp.SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
): NanobossToolMeta {
  const meta = update._meta;
  if (!meta || typeof meta !== "object") {
    return {};
  }

  const nanoboss = "nanoboss" in meta ? meta.nanoboss : undefined;
  if (!nanoboss || typeof nanoboss !== "object") {
    return {};
  }

  const toolMeta: NanobossToolMeta = {};
  if ("toolKind" in nanoboss && typeof nanoboss.toolKind === "string") {
    toolMeta.toolKind = nanoboss.toolKind;
  }
  if ("parentToolCallId" in nanoboss && typeof nanoboss.parentToolCallId === "string") {
    toolMeta.parentToolCallId = nanoboss.parentToolCallId;
  }
  if ("transcriptVisible" in nanoboss && typeof nanoboss.transcriptVisible === "boolean") {
    toolMeta.transcriptVisible = nanoboss.transcriptVisible;
  }
  if ("removeOnTerminal" in nanoboss && typeof nanoboss.removeOnTerminal === "boolean") {
    toolMeta.removeOnTerminal = nanoboss.removeOnTerminal;
  }
  return toolMeta;
}

function normalizeToolUpdateStatus(
  update: Extract<acp.SessionUpdate, { sessionUpdate: "tool_call_update" }>,
): string {
  const status = update.status ?? "pending";
  return status === "failed" && isCancelledToolOutput(update.rawOutput)
    ? "cancelled"
    : status;
}

function isCancelledToolOutput(rawOutput: unknown): boolean {
  return Boolean(
    rawOutput
    && typeof rawOutput === "object"
    && "cancelled" in rawOutput
    && rawOutput.cancelled === true,
  );
}

function extractTokenUsage(rawOutput: unknown): AgentTokenUsage | undefined {
  if (!rawOutput || typeof rawOutput !== "object") {
    return undefined;
  }

  if ("tokenUsage" in rawOutput) {
    const usage = (rawOutput as { tokenUsage?: unknown }).tokenUsage;
    if (usage && typeof usage === "object" && "source" in usage && typeof usage.source === "string") {
      return usage as AgentTokenUsage;
    }
  }

  if (!("tokenSnapshot" in rawOutput)) {
    return undefined;
  }

  const snapshot = (rawOutput as { tokenSnapshot?: Parameters<typeof normalizeAgentTokenUsage>[0] }).tokenSnapshot;
  return normalizeAgentTokenUsage(snapshot);
}

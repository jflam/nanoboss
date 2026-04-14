import type * as acp from "@agentclientprotocol/sdk";

import { parseAssistantNoticeText } from "../agent/acp-updates.ts";
import type { ProcedureUiEvent } from "../core/context-shared.ts";
import type { ProcedureMemoryCard } from "../core/memory-cards.ts";
import { normalizeAgentTokenUsage } from "../agent/token-usage.ts";
import {
  summarizeToolCallStart,
  summarizeToolCallUpdate,
  type ToolPreviewBlock,
} from "../core/tool-call-preview.ts";
import { normalizeToolName } from "../core/tool-payload-normalizer.ts";
import type {
  AgentTokenUsage,
  ContinuationUi,
  FrontendContinuation,
  RunRef,
} from "../core/types.ts";

export interface FrontendCommand {
  name: string;
  description: string;
  inputHint?: string;
}

export type FrontendEvent =
  | {
      type: "commands_updated";
      commands: FrontendCommand[];
    }
  | {
      type: "run_restored";
      runId: string;
      procedure: string;
      prompt: string;
      completedAt: string;
      run: RunRef;
      status: "complete" | "failed" | "cancelled" | "paused";
      text?: string;
    }
  | {
      type: "run_started";
      runId: string;
      procedure: string;
      prompt: string;
      startedAt: string;
    }
  | {
      type: "continuation_updated";
      continuation?: FrontendContinuation;
    }
  | {
      type: "memory_cards";
      runId: string;
      cards: ProcedureMemoryCard[];
    }
  | {
      type: "memory_card_stored";
      runId: string;
      card: ProcedureMemoryCard;
    }
  | {
      type: "text_delta";
      runId: string;
      text: string;
      stream: "agent";
    }
  | {
      type: "assistant_notice";
      runId: string;
      text: string;
      tone: "info" | "warning" | "error";
    }
  | {
      type: "procedure_status";
      runId: string;
      status: Extract<ProcedureUiEvent, { type: "status" }>;
    }
  | {
      type: "procedure_card";
      runId: string;
      card: Extract<ProcedureUiEvent, { type: "card" }>;
    }
  | {
      type: "token_usage";
      runId: string;
      usage: AgentTokenUsage;
      sourceUpdate: "usage_update" | "tool_call_update" | "run_completed" | "run_paused";
      toolCallId?: string;
      status?: string;
    }
  | {
      type: "run_heartbeat";
      runId: string;
      procedure: string;
      at: string;
    }
  | {
      type: "tool_started";
      runId: string;
      toolCallId: string;
      parentToolCallId?: string;
      transcriptVisible?: boolean;
      removeOnTerminal?: boolean;
      title: string;
      kind: string;
      toolName?: string;
      status?: string;
      callPreview?: ToolPreviewBlock;
      rawInput?: unknown;
    }
  | {
      type: "tool_updated";
      runId: string;
      toolCallId: string;
      parentToolCallId?: string;
      transcriptVisible?: boolean;
      removeOnTerminal?: boolean;
      title?: string;
      toolName?: string;
      status: string;
      resultPreview?: ToolPreviewBlock;
      errorPreview?: ToolPreviewBlock;
      durationMs?: number;
      rawOutput?: unknown;
    }
  | {
      type: "run_completed";
      runId: string;
      procedure: string;
      completedAt: string;
      run: RunRef;
      summary?: string;
      display?: string;
      tokenUsage?: AgentTokenUsage;
    }
  | {
      type: "run_paused";
      runId: string;
      procedure: string;
      pausedAt: string;
      run: RunRef;
      question: string;
      display?: string;
      inputHint?: string;
      suggestedReplies?: string[];
      ui?: ContinuationUi;
      tokenUsage?: AgentTokenUsage;
    }
  | {
      type: "run_failed";
      runId: string;
      procedure: string;
      completedAt: string;
      error: string;
      run?: RunRef;
    }
  | {
      type: "run_cancelled";
      runId: string;
      procedure: string;
      completedAt: string;
      message: string;
      run?: RunRef;
    };

export type MemorySyncFrontendEvent = Extract<FrontendEvent, { type: "memory_cards" | "memory_card_stored" }>;
export type RenderedFrontendEvent = Exclude<FrontendEvent, MemorySyncFrontendEvent>;
export type ReplayableFrontendEvent = Exclude<
  Extract<RenderedFrontendEvent, { runId: string }>,
  { type: "run_started" | "run_restored" | "run_heartbeat" }
>;

export type FrontendEventEnvelope = {
  [EventType in FrontendEvent["type"]]: {
    sessionId: string;
    seq: number;
    type: EventType;
    data: Omit<Extract<FrontendEvent, { type: EventType }>, "type">;
  };
}[FrontendEvent["type"]];

export type MemorySyncFrontendEventEnvelope = {
  [EventType in MemorySyncFrontendEvent["type"]]: {
    sessionId: string;
    seq: number;
    type: EventType;
    data: Omit<Extract<MemorySyncFrontendEvent, { type: EventType }>, "type">;
  };
}[MemorySyncFrontendEvent["type"]];

export type RenderedFrontendEventEnvelope = {
  [EventType in RenderedFrontendEvent["type"]]: {
    sessionId: string;
    seq: number;
    type: EventType;
    data: Omit<Extract<RenderedFrontendEvent, { type: EventType }>, "type">;
  };
}[RenderedFrontendEvent["type"]];

export type CommandsUpdatedEventEnvelope = Extract<FrontendEventEnvelope, { type: "commands_updated" }>;
export type TextDeltaEventEnvelope = Extract<FrontendEventEnvelope, { type: "text_delta" }>;
export type ToolStartedEventEnvelope = Extract<FrontendEventEnvelope, { type: "tool_started" }>;
export type ToolUpdatedEventEnvelope = Extract<FrontendEventEnvelope, { type: "tool_updated" }>;
export type TokenUsageEventEnvelope = Extract<FrontendEventEnvelope, { type: "token_usage" }>;
export type RunFailedEventEnvelope = Extract<FrontendEventEnvelope, { type: "run_failed" }>;

const REPLAYABLE_FRONTEND_EVENT_TYPES = new Set<ReplayableFrontendEvent["type"]>([
  "text_delta",
  "assistant_notice",
  "procedure_status",
  "procedure_card",
  "tool_started",
  "tool_updated",
  "token_usage",
  "run_completed",
  "run_paused",
  "run_failed",
  "run_cancelled",
]);

export class SessionEventLog {
  private readonly listeners = new Set<(event: FrontendEventEnvelope) => void>();
  private readonly history: FrontendEventEnvelope[] = [];
  private nextSeq = 1;

  constructor(private readonly maxHistory = 5_000) {}

  publish(sessionId: string, event: FrontendEvent): FrontendEventEnvelope {
    const envelope = {
      sessionId,
      seq: this.nextSeq,
      type: event.type,
      data: withoutType(event),
    } as FrontendEventEnvelope;

    this.nextSeq += 1;
    this.history.push(envelope);

    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }

    for (const listener of this.listeners) {
      listener(envelope);
    }

    return envelope;
  }

  after(afterSeq = -1): FrontendEventEnvelope[] {
    return this.history.filter((event) => event.seq > afterSeq);
  }

  subscribe(listener: (event: FrontendEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export function isCommandsUpdatedEvent(event: FrontendEventEnvelope): event is CommandsUpdatedEventEnvelope {
  return event.type === "commands_updated";
}

export function isTextDeltaEvent(event: FrontendEventEnvelope): event is TextDeltaEventEnvelope {
  return event.type === "text_delta";
}

interface NanobossToolMeta {
  toolKind?: string;
  parentToolCallId?: string;
  transcriptVisible?: boolean;
  removeOnTerminal?: boolean;
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

export function isToolStartedEvent(event: FrontendEventEnvelope): event is ToolStartedEventEnvelope {
  return event.type === "tool_started";
}

export function isToolUpdatedEvent(event: FrontendEventEnvelope): event is ToolUpdatedEventEnvelope {
  return event.type === "tool_updated";
}

export function isTokenUsageEvent(event: FrontendEventEnvelope): event is TokenUsageEventEnvelope {
  return event.type === "token_usage";
}

export function isRunFailedEvent(event: FrontendEventEnvelope): event is RunFailedEventEnvelope {
  return event.type === "run_failed";
}

export function isMemorySyncFrontendEvent(
  event: FrontendEventEnvelope,
): event is MemorySyncFrontendEventEnvelope {
  return event.type === "memory_cards" || event.type === "memory_card_stored";
}

export function isRenderedFrontendEvent(event: FrontendEventEnvelope): event is RenderedFrontendEventEnvelope {
  return !isMemorySyncFrontendEvent(event);
}

export function toReplayableFrontendEvent(
  event: FrontendEventEnvelope,
  runId: string,
): ReplayableFrontendEvent | undefined {
  if (!("runId" in event.data) || event.data.runId !== runId) {
    return undefined;
  }

  if (!REPLAYABLE_FRONTEND_EVENT_TYPES.has(event.type as ReplayableFrontendEvent["type"])) {
    return undefined;
  }

  return {
    type: event.type,
    ...event.data,
  } as ReplayableFrontendEvent;
}

export function toFrontendCommands(commands: acp.AvailableCommand[]): FrontendCommand[] {
  return commands.map((command) => ({
    name: command.name,
    description: command.description,
    inputHint: command.input?.hint,
  }));
}

export function mapSessionUpdateToFrontendEvents(
  runId: string,
  update: acp.SessionUpdate,
): FrontendEvent[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      if (update.content.type !== "text") {
        return [];
      }

      const notice = parseAssistantNoticeText(update.content.text);
      if (notice) {
        return [
          {
            type: "assistant_notice",
            runId,
            text: notice.text,
            tone: notice.tone,
          },
        ];
      }

      return [
        {
          type: "text_delta",
          runId,
          text: update.content.text,
          stream: "agent",
        },
      ];
    }
    case "tool_call": {
      const toolMeta = getNanobossToolMeta(update);
      const toolKind = toolMeta.toolKind ?? String(update.kind);
      const toolName = normalizeToolName({ title: update.title, kind: toolKind });
      const preview = summarizeToolCallStart({
        toolName,
        title: update.title,
        kind: toolKind,
      }, update.rawInput);

      return [
        {
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
        },
      ];
    }
    case "tool_call_update": {
      const toolMeta = getNanobossToolMeta(update);
      const status = normalizeToolUpdateStatus(update);
      const toolName = update.title ? normalizeToolName({ title: update.title }) : undefined;
      const preview = summarizeToolCallUpdate({
        toolName,
        title: update.title ?? undefined,
      }, update.rawOutput);
      const events: FrontendEvent[] = [
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
    case "available_commands_update":
      return [
        {
          type: "commands_updated",
          commands: toFrontendCommands(update.availableCommands),
        },
      ];
    case "usage_update":
      {
        const usage = normalizeAgentTokenUsage({
          source: "acp_usage_update",
          contextWindowTokens: update.size,
          usedContextTokens: update.used,
        });
        return usage
          ? [
              {
                type: "token_usage",
                runId,
                usage,
                sourceUpdate: "usage_update",
              },
            ]
          : [];
      }
    default:
      return [];
  }
}

export function mapProcedureUiEventToFrontendEvent(
  runId: string,
  event: ProcedureUiEvent,
): Extract<FrontendEvent, { type: "procedure_status" | "procedure_card" }> {
  switch (event.type) {
    case "status":
      return {
        type: "procedure_status",
        runId,
        status: event,
      };
    case "card":
      return {
        type: "procedure_card",
        runId,
        card: event,
      };
  }
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

function withoutType(event: FrontendEvent): Omit<FrontendEvent, "type"> {
  const { type, ...data } = event;
  void type;
  return data;
}

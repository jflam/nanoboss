import type * as acp from "@agentclientprotocol/sdk";

import { parseAssistantNoticeText } from "../agent/acp-updates.ts";
import type { ProcedureMemoryCard } from "../core/memory-cards.ts";
import { normalizeAgentTokenUsage } from "../agent/token-usage.ts";
import {
  summarizeToolCallStart,
  summarizeToolCallUpdate,
  type ToolPreviewBlock,
} from "../core/tool-call-preview.ts";
import type {
  AgentTokenUsage,
  CellRef,
  FrontendPendingProcedureContinuation,
  ProcedureContinuationUi,
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
      cell: CellRef;
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
      continuation?: FrontendPendingProcedureContinuation;
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
      title: string;
      kind: string;
      status?: string;
      callPreview?: ToolPreviewBlock;
      rawInput?: unknown;
    }
  | {
      type: "tool_updated";
      runId: string;
      toolCallId: string;
      title?: string;
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
      cell: CellRef;
      summary?: string;
      display?: string;
      tokenUsage?: AgentTokenUsage;
    }
  | {
      type: "run_paused";
      runId: string;
      procedure: string;
      pausedAt: string;
      cell: CellRef;
      question: string;
      display?: string;
      inputHint?: string;
      suggestedReplies?: string[];
      continuationUi?: ProcedureContinuationUi;
      tokenUsage?: AgentTokenUsage;
    }
  | {
      type: "run_failed";
      runId: string;
      procedure: string;
      completedAt: string;
      error: string;
      cell?: CellRef;
    }
  | {
      type: "run_cancelled";
      runId: string;
      procedure: string;
      completedAt: string;
      message: string;
      cell?: CellRef;
    };

export type FrontendEventEnvelope = {
  [EventType in FrontendEvent["type"]]: {
    sessionId: string;
    seq: number;
    type: EventType;
    data: Omit<Extract<FrontendEvent, { type: EventType }>, "type">;
  };
}[FrontendEvent["type"]];

export type CommandsUpdatedEventEnvelope = Extract<FrontendEventEnvelope, { type: "commands_updated" }>;
export type TextDeltaEventEnvelope = Extract<FrontendEventEnvelope, { type: "text_delta" }>;
export type ToolStartedEventEnvelope = Extract<FrontendEventEnvelope, { type: "tool_started" }>;
export type ToolUpdatedEventEnvelope = Extract<FrontendEventEnvelope, { type: "tool_updated" }>;
export type TokenUsageEventEnvelope = Extract<FrontendEventEnvelope, { type: "token_usage" }>;
export type RunFailedEventEnvelope = Extract<FrontendEventEnvelope, { type: "run_failed" }>;

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
      const preview = summarizeToolCallStart({
        title: update.title,
        kind: String(update.kind),
      }, update.rawInput);

      return [
        {
          type: "tool_started",
          runId,
          toolCallId: update.toolCallId,
          title: update.title,
          kind: String(update.kind),
          status: update.status ?? undefined,
          callPreview: preview.callPreview,
          rawInput: update.rawInput,
        },
      ];
    }
    case "tool_call_update": {
      const preview = summarizeToolCallUpdate({
        title: update.title ?? undefined,
      }, update.rawOutput);
      const events: FrontendEvent[] = [
        {
          type: "tool_updated",
          runId,
          toolCallId: update.toolCallId,
          title: update.title ?? undefined,
          status: update.status ?? "pending",
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
          status: update.status ?? undefined,
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

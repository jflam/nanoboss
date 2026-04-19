import type * as acp from "@agentclientprotocol/sdk";

import { normalizeAgentTokenUsage, parseAssistantNoticeText } from "@nanoboss/agent-acp";
import { UiApiImpl, type ProcedureUiEvent } from "@nanoboss/procedure-engine";
import type {
  AgentTokenUsage,
  ContinuationUi,
  RunRef,
} from "@nanoboss/contracts";

import type { ProcedureMemoryCard } from "./memory-cards.ts";
import {
  summarizeToolCallStart,
  summarizeToolCallUpdate,
  type ToolPreviewBlock,
} from "./tool-call-preview.ts";
import { normalizeToolName } from "./tool-payload-normalizer.ts";

export { UiApiImpl };

export interface RuntimeCommand {
  name: string;
  description: string;
  inputHint?: string;
}

export interface RuntimeContinuation {
  procedure: string;
  question: string;
  inputHint?: string;
  suggestedReplies?: string[];
  ui?: ContinuationUi;
}

export type RuntimeEvent =
  | {
      type: "commands_updated";
      commands: RuntimeCommand[];
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
      continuation?: RuntimeContinuation;
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
      type: "ui_panel";
      runId: string;
      procedure: string;
      rendererId: string;
      slot: string;
      key?: string;
      payload: unknown;
      lifetime: "turn" | "run" | "session";
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

export type MemorySyncRuntimeEvent = Extract<RuntimeEvent, { type: "memory_cards" | "memory_card_stored" }>;
export type RenderedRuntimeEvent = Exclude<RuntimeEvent, MemorySyncRuntimeEvent>;
export type PersistedRuntimeEvent = Exclude<
  Extract<RenderedRuntimeEvent, { runId: string }>,
  { type: "run_started" | "run_restored" | "run_heartbeat" }
>;

export type RuntimeEventEnvelope = {
  [EventType in RuntimeEvent["type"]]: {
    sessionId: string;
    seq: number;
    type: EventType;
    data: Omit<Extract<RuntimeEvent, { type: EventType }>, "type">;
  };
}[RuntimeEvent["type"]];

export type MemorySyncRuntimeEventEnvelope = {
  [EventType in MemorySyncRuntimeEvent["type"]]: {
    sessionId: string;
    seq: number;
    type: EventType;
    data: Omit<Extract<MemorySyncRuntimeEvent, { type: EventType }>, "type">;
  };
}[MemorySyncRuntimeEvent["type"]];

export type RenderedRuntimeEventEnvelope = {
  [EventType in RenderedRuntimeEvent["type"]]: {
    sessionId: string;
    seq: number;
    type: EventType;
    data: Omit<Extract<RenderedRuntimeEvent, { type: EventType }>, "type">;
  };
}[RenderedRuntimeEvent["type"]];

export type CommandsUpdatedEventEnvelope = Extract<RuntimeEventEnvelope, { type: "commands_updated" }>;
export type TextDeltaEventEnvelope = Extract<RuntimeEventEnvelope, { type: "text_delta" }>;
export type ToolStartedEventEnvelope = Extract<RuntimeEventEnvelope, { type: "tool_started" }>;
export type ToolUpdatedEventEnvelope = Extract<RuntimeEventEnvelope, { type: "tool_updated" }>;
export type TokenUsageEventEnvelope = Extract<RuntimeEventEnvelope, { type: "token_usage" }>;
export type RunFailedEventEnvelope = Extract<RuntimeEventEnvelope, { type: "run_failed" }>;

const PERSISTED_RUNTIME_EVENT_TYPES = new Set<PersistedRuntimeEvent["type"]>([
  "text_delta",
  "assistant_notice",
  "procedure_status",
  "procedure_card",
  "ui_panel",
  "tool_started",
  "tool_updated",
  "token_usage",
  "run_completed",
  "run_paused",
  "run_failed",
  "run_cancelled",
]);

export class SessionEventLog {
  private readonly listeners = new Set<(event: RuntimeEventEnvelope) => void>();
  private readonly history: RuntimeEventEnvelope[] = [];
  private nextSeq = 1;

  constructor(private readonly maxHistory = 5_000) {}

  publish(sessionId: string, event: RuntimeEvent): RuntimeEventEnvelope {
    const envelope = {
      sessionId,
      seq: this.nextSeq,
      type: event.type,
      data: withoutType(event),
    } as RuntimeEventEnvelope;

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

  after(afterSeq = -1): RuntimeEventEnvelope[] {
    return this.history.filter((event) => event.seq > afterSeq);
  }

  subscribe(listener: (event: RuntimeEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export function isCommandsUpdatedEvent(event: RuntimeEventEnvelope): event is CommandsUpdatedEventEnvelope {
  return event.type === "commands_updated";
}

export function isTextDeltaEvent(event: RuntimeEventEnvelope): event is TextDeltaEventEnvelope {
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

export function isToolStartedEvent(event: RuntimeEventEnvelope): event is ToolStartedEventEnvelope {
  return event.type === "tool_started";
}

export function isToolUpdatedEvent(event: RuntimeEventEnvelope): event is ToolUpdatedEventEnvelope {
  return event.type === "tool_updated";
}

export function isTokenUsageEvent(event: RuntimeEventEnvelope): event is TokenUsageEventEnvelope {
  return event.type === "token_usage";
}

export function isRunFailedEvent(event: RuntimeEventEnvelope): event is RunFailedEventEnvelope {
  return event.type === "run_failed";
}

export function isMemorySyncRuntimeEvent(
  event: RuntimeEventEnvelope,
): event is MemorySyncRuntimeEventEnvelope {
  return event.type === "memory_cards" || event.type === "memory_card_stored";
}

export function isRenderedRuntimeEvent(event: RuntimeEventEnvelope): event is RenderedRuntimeEventEnvelope {
  return !isMemorySyncRuntimeEvent(event);
}

export function isPersistedRuntimeEvent(event: unknown): event is PersistedRuntimeEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    "type" in event &&
    PERSISTED_RUNTIME_EVENT_TYPES.has((event as { type: PersistedRuntimeEvent["type"] }).type) &&
    "runId" in event &&
    typeof (event as { runId?: unknown }).runId === "string"
  );
}

export function toPersistedRuntimeEvent(
  event: RuntimeEventEnvelope,
  runId: string,
): PersistedRuntimeEvent | undefined {
  if (!("runId" in event.data) || event.data.runId !== runId) {
    return undefined;
  }

  if (!PERSISTED_RUNTIME_EVENT_TYPES.has(event.type as PersistedRuntimeEvent["type"])) {
    return undefined;
  }

  return {
    type: event.type,
    ...event.data,
  } as PersistedRuntimeEvent;
}

export function toRuntimeCommands(commands: acp.AvailableCommand[]): RuntimeCommand[] {
  return commands.map((command) => ({
    name: command.name,
    description: command.description,
    inputHint: command.input?.hint,
  }));
}

export function mapSessionUpdateToRuntimeEvents(
  runId: string,
  update: acp.SessionUpdate,
): RuntimeEvent[] {
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
    case "available_commands_update":
      return [
        {
          type: "commands_updated",
          commands: toRuntimeCommands(update.availableCommands),
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

export function mapProcedureUiEventToRuntimeEvent(
  runId: string,
  event: ProcedureUiEvent,
): Extract<RuntimeEvent, { type: "procedure_status" | "procedure_card" | "ui_panel" }> {
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
    case "ui_panel":
      return {
        type: "ui_panel",
        runId,
        procedure: event.procedure,
        rendererId: event.rendererId,
        slot: event.slot,
        ...(event.key !== undefined ? { key: event.key } : {}),
        payload: event.payload,
        lifetime: event.lifetime,
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

function withoutType(event: RuntimeEvent): Omit<RuntimeEvent, "type"> {
  const { type, ...data } = event;
  void type;
  return data;
}

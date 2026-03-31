import type * as acp from "@agentclientprotocol/sdk";

import type { CellRef } from "./types.ts";

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
      type: "run_started";
      runId: string;
      procedure: string;
      prompt: string;
      startedAt: string;
    }
  | {
      type: "text_delta";
      runId: string;
      text: string;
      stream: "agent";
    }
  | {
      type: "tool_started";
      runId: string;
      toolCallId: string;
      title: string;
      kind: string;
      status?: string;
    }
  | {
      type: "tool_updated";
      runId: string;
      toolCallId: string;
      title?: string;
      status: string;
    }
  | {
      type: "run_completed";
      runId: string;
      procedure: string;
      completedAt: string;
      cell: CellRef;
      summary?: string;
      display?: string;
    }
  | {
      type: "run_failed";
      runId: string;
      procedure: string;
      completedAt: string;
      error: string;
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
    case "agent_message_chunk":
      if (update.content.type !== "text") {
        return [];
      }

      return [
        {
          type: "text_delta",
          runId,
          text: update.content.text,
          stream: "agent",
        },
      ];
    case "tool_call":
      return [
        {
          type: "tool_started",
          runId,
          toolCallId: update.toolCallId,
          title: update.title,
          kind: String(update.kind),
          status: update.status ?? undefined,
        },
      ];
    case "tool_call_update":
      return [
        {
          type: "tool_updated",
          runId,
          toolCallId: update.toolCallId,
          title: update.title ?? undefined,
          status: update.status ?? "pending",
        },
      ];
    case "available_commands_update":
      return [
        {
          type: "commands_updated",
          commands: toFrontendCommands(update.availableCommands),
        },
      ];
    default:
      return [];
  }
}

function withoutType(event: FrontendEvent): Omit<FrontendEvent, "type"> {
  const { type, ...data } = event;
  void type;
  return data;
}

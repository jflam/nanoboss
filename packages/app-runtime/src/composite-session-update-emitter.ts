import type * as acp from "@agentclientprotocol/sdk";
import type { AgentTokenUsage } from "@nanoboss/contracts";
import type {
  ProcedureUiEvent,
  SessionUpdateEmitter,
} from "@nanoboss/procedure-engine";

import {
  mapProcedureUiEventToRuntimeEvent,
  mapSessionUpdateToRuntimeEvents,
  SessionEventLog,
} from "./runtime-events.ts";

export class CompositeSessionUpdateEmitter implements SessionUpdateEmitter {
  private streamedText = "";
  private latestTokenUsage?: AgentTokenUsage;

  constructor(
    private readonly sessionId: string,
    private readonly runId: string,
    private readonly procedure: string,
    private readonly eventLog: SessionEventLog,
    private readonly onActivity: () => void,
    private readonly delegate?: SessionUpdateEmitter,
  ) {}

  emit(update: acp.SessionUpdate): void {
    this.onActivity();

    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      this.streamedText += update.content.text;
    } else if (update.sessionUpdate === "tool_call") {
      this.streamedText = "";
    }

    for (const event of mapSessionUpdateToRuntimeEvents(this.runId, this.procedure, update)) {
      if (event.type === "token_usage") {
        this.latestTokenUsage = event.usage;
      }
      this.eventLog.publish(this.sessionId, event);
    }

    this.delegate?.emit(update);
  }

  emitUiEvent(event: ProcedureUiEvent): void {
    this.onActivity();
    this.eventLog.publish(this.sessionId, mapProcedureUiEventToRuntimeEvent(this.runId, event));
  }

  get currentTokenUsage(): AgentTokenUsage | undefined {
    return this.latestTokenUsage;
  }

  hasStreamedText(text: string): boolean {
    return this.streamedText === text;
  }

  get hasAnyStreamedText(): boolean {
    return this.streamedText.length > 0;
  }

  flush(): Promise<void> {
    return this.delegate?.flush() ?? Promise.resolve();
  }
}

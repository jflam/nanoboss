import type * as acp from "@agentclientprotocol/sdk";
import { parseAssistantNoticeText } from "@nanoboss/agent-acp";
import {
  parseProcedureUiMarker,
  toProcedureUiSessionUpdate,
  type ProcedureUiEvent,
  type SessionUpdateEmitter,
} from "@nanoboss/procedure-engine";

export class QueuedSessionUpdateEmitter implements SessionUpdateEmitter {
  private queue = Promise.resolve();
  private pendingAssistantMessageChunks: Array<Extract<acp.SessionUpdate, { sessionUpdate: "agent_message_chunk" }>> = [];

  constructor(
    private readonly connection: acp.AgentSideConnection,
    private readonly sessionId: acp.SessionId,
  ) {}

  emit(update: acp.SessionUpdate): void {
    this.queue = this.queue
      .then(() =>
        this.forwardUpdate(update)
      )
      .catch((error: unknown) => {
        console.error("failed to emit session update", error);
      });
  }

  emitUiEvent(event: ProcedureUiEvent): void {
    this.emit(toProcedureUiSessionUpdate(event));
  }

  flush(): Promise<void> {
    this.queue = this.queue
      .then(() => this.flushPendingAssistantMessageChunks("message"))
      .catch((error: unknown) => {
        console.error("failed to flush session updates", error);
      });
    return this.queue;
  }

  private async forwardUpdate(update: acp.SessionUpdate): Promise<void> {
    if (shouldBufferClientFacingAssistantMessageChunk(update)) {
      this.pendingAssistantMessageChunks.push(update);
      return;
    }

    if (update.sessionUpdate === "tool_call" && this.pendingAssistantMessageChunks.length > 0) {
      await this.flushPendingAssistantMessageChunks("thought");
    }

    await this.connection.sessionUpdate({
      sessionId: this.sessionId,
      update,
    });
  }

  private async flushPendingAssistantMessageChunks(mode: "message" | "thought"): Promise<void> {
    const pending = this.pendingAssistantMessageChunks;
    if (pending.length === 0) {
      return;
    }

    this.pendingAssistantMessageChunks = [];
    for (const update of pending) {
      await this.connection.sessionUpdate({
        sessionId: this.sessionId,
        update: mode === "message" ? update : toThoughtChunk(update),
      });
    }
  }
}

function shouldBufferClientFacingAssistantMessageChunk(
  update: acp.SessionUpdate,
): update is Extract<acp.SessionUpdate, { sessionUpdate: "agent_message_chunk" }> {
  return update.sessionUpdate === "agent_message_chunk"
    && update.content.type === "text"
    && !parseAssistantNoticeText(update.content.text)
    && !parseProcedureUiMarker(update.content.text);
}

function toThoughtChunk(
  update: Extract<acp.SessionUpdate, { sessionUpdate: "agent_message_chunk" }>,
): Extract<acp.SessionUpdate, { sessionUpdate: "agent_thought_chunk" }> {
  return {
    ...update,
    sessionUpdate: "agent_thought_chunk",
  };
}

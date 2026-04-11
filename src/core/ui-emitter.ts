import type * as acp from "@agentclientprotocol/sdk";

import type { RunLogger } from "./logger.ts";
import type { SessionUpdateEmitter } from "./context-shared.ts";
import type { UiApi } from "./ui-api.ts";
import type { SessionStore } from "../session/index.ts";

type ActiveCell = ReturnType<SessionStore["startCell"]>;

export class UiApiImpl implements UiApi {
  constructor(
    private readonly store: SessionStore,
    private readonly cell: ActiveCell,
    private readonly logger: RunLogger,
    private readonly spanId: string,
    private readonly procedureName: string,
    private readonly emitter: SessionUpdateEmitter,
  ) {}

  text(text: string): void {
    this.store.appendStream(this.cell, text);
    this.logger.write({
      spanId: this.spanId,
      parentSpanId: undefined,
      procedure: this.procedureName,
      kind: "print",
      raw: text,
    });
    this.emitter.emit({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text,
      },
    } satisfies acp.SessionUpdate);
  }
}

import type * as acp from "@agentclientprotocol/sdk";

import type { PromptInput } from "./types.ts";
import type { UiCardParams, UiStatusParams } from "./types.ts";

export type ProcedureUiEvent =
  | {
      type: "status";
      procedure: string;
    } & Omit<UiStatusParams, "procedure">
  | {
      type: "card";
      procedure: string;
    } & UiCardParams;

export interface SessionUpdateEmitter {
  emit(update: acp.SessionUpdate): void;
  emitUiEvent?(event: ProcedureUiEvent): void;
  flush(): Promise<void>;
}

export interface PreparedDefaultPrompt {
  promptInput: PromptInput;
  markSubmitted?: () => void;
}

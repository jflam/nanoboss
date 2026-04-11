import type * as acp from "@agentclientprotocol/sdk";

export interface SessionUpdateEmitter {
  emit(update: acp.SessionUpdate): void;
  flush(): Promise<void>;
}

export interface PreparedDefaultPrompt {
  prompt: string;
  markSubmitted?: () => void;
}

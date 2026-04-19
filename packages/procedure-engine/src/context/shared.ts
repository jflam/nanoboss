import type * as acp from "@agentclientprotocol/sdk";
import type { AgentSession } from "@nanoboss/agent-acp";

import type {
  PromptInput,
  UiCardParams,
  UiPanelLifetime,
  UiStatusParams,
} from "@nanoboss/procedure-sdk";
import type {
  AgentTokenUsage,
  DownstreamAgentConfig,
  DownstreamAgentSelection,
} from "@nanoboss/contracts";

export type ProcedureUiEvent =
  | {
      type: "status";
      procedure: string;
    } & Omit<UiStatusParams, "procedure">
  | {
      type: "card";
      procedure: string;
    } & UiCardParams
  | {
      type: "ui_panel";
      procedure: string;
      rendererId: string;
      slot: string;
      key?: string;
      payload: unknown;
      lifetime: UiPanelLifetime;
    };

export interface SessionUpdateEmitter {
  emit(update: acp.SessionUpdate): void;
  emitUiEvent?(event: ProcedureUiEvent): void;
  flush(): Promise<void>;
  readonly currentTokenUsage?: AgentTokenUsage;
}

export interface PreparedDefaultPrompt {
  promptInput: PromptInput;
  markSubmitted?: () => void;
}

export interface RuntimeBindings {
  agentSession?: AgentSession;
  getDefaultAgentConfig: () => DownstreamAgentConfig;
  setDefaultAgentSelection: (selection: DownstreamAgentSelection) => DownstreamAgentConfig;
  prepareDefaultPrompt?: (promptInput: PromptInput) => PreparedDefaultPrompt;
}

import type * as acp from "@agentclientprotocol/sdk";

import type {
  AgentSession as ContractAgentSession,
  AgentSessionPromptOptions as ContractAgentSessionPromptOptions,
  AgentSessionPromptResult as ContractAgentSessionPromptResult,
  AgentTokenSnapshot,
  PromptInput,
} from "@nanoboss/contracts";
import type {
  AgentRunResult,
  AgentTokenUsage,
  DownstreamAgentConfig,
  KernelValue,
  TypeDescriptor,
} from "@nanoboss/procedure-sdk";

import type { RunTimingTrace } from "@nanoboss/app-support";

export type {
  AgentRunResult,
  AgentTokenSnapshot,
  AgentTokenUsage,
  DownstreamAgentConfig,
  KernelValue,
  PromptInput,
  TypeDescriptor,
};

export interface AgentSessionPromptOptions extends ContractAgentSessionPromptOptions {
  onUpdate?: (update: acp.SessionUpdate) => Promise<void> | void;
  timingTrace?: RunTimingTrace;
}

export interface AgentSessionPromptResult extends ContractAgentSessionPromptResult {
  updates: acp.SessionUpdate[];
}

export interface AgentSession extends Omit<ContractAgentSession, "prompt"> {
  prompt(prompt: string | PromptInput, options?: AgentSessionPromptOptions): Promise<AgentSessionPromptResult>;
}

export interface CallAgentOptions {
  config?: DownstreamAgentConfig;
  persistedSessionId?: string;
  namedRefs?: Record<string, unknown>;
  onUpdate?: (update: acp.SessionUpdate) => Promise<void> | void;
  signal?: AbortSignal;
  softStopSignal?: AbortSignal;
  promptInput?: PromptInput;
}

export interface CallAgentTransport {
  invoke(prompt: string, options: CallAgentOptions): Promise<{
    agentSessionId?: string;
    raw: string;
    logFile?: string;
    updates: acp.SessionUpdate[];
    tokenSnapshot?: AgentTokenSnapshot;
  }>;
}

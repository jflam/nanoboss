import type { DownstreamAgentSelection } from "../types.ts";

export interface UiTurn {
  id: string;
  role: "user" | "assistant" | "system";
  markdown: string;
  status?: "streaming" | "complete" | "failed";
  meta?: {
    procedure?: string;
    tokenUsageLine?: string;
    failureMessage?: string;
  };
}

export interface UiToolCall {
  id: string;
  title: string;
  status: string;
  depth: number;
  isWrapper: boolean;
}

export interface UiState {
  cwd: string;
  sessionId: string;
  buildLabel: string;
  agentLabel: string;
  defaultAgentSelection?: DownstreamAgentSelection;
  availableCommands: string[];
  turns: UiTurn[];
  toolCalls: UiToolCall[];
  activeWrapperToolCallIds: string[];
  hiddenToolCallIds: string[];
  runtimeNotes: string[];
  activeRunId?: string;
  activeAssistantTurnId?: string;
  runStartedAtMs?: number;
  statusLine?: string;
  promptDiagnosticsLine?: string;
  tokenUsageLine?: string;
  inputDisabled: boolean;
  showToolCalls: boolean;
}

export function createInitialUiState(params: {
  cwd?: string;
  buildLabel?: string;
  agentLabel?: string;
  showToolCalls?: boolean;
} = {}): UiState {
  return {
    cwd: params.cwd ?? process.cwd(),
    sessionId: "",
    buildLabel: params.buildLabel ?? "nanoboss",
    agentLabel: params.agentLabel ?? "connecting",
    availableCommands: [],
    turns: [],
    toolCalls: [],
    activeWrapperToolCallIds: [],
    hiddenToolCallIds: [],
    runtimeNotes: [],
    inputDisabled: false,
    showToolCalls: params.showToolCalls ?? true,
  };
}

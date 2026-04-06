import type { ToolPreviewBlock } from "../core/tool-call-preview.ts";
import type { DownstreamAgentSelection } from "../core/types.ts";

export interface UiTurn {
  id: string;
  role: "user" | "assistant" | "system";
  markdown: string;
  status?: "streaming" | "complete" | "failed" | "cancelled";
  runId?: string;
  meta?: {
    procedure?: string;
    tokenUsageLine?: string;
    failureMessage?: string;
  };
}

export interface UiToolCall {
  id: string;
  runId: string;
  title: string;
  kind: string;
  status: string;
  depth: number;
  isWrapper: boolean;
  callPreview?: ToolPreviewBlock;
  resultPreview?: ToolPreviewBlock;
  errorPreview?: ToolPreviewBlock;
  rawInput?: unknown;
  rawOutput?: unknown;
  durationMs?: number;
}

export type UiTranscriptItem =
  | { type: "turn"; id: string }
  | { type: "tool_call"; id: string };

export interface UiState {
  cwd: string;
  sessionId: string;
  buildLabel: string;
  agentLabel: string;
  defaultAgentSelection?: DownstreamAgentSelection;
  availableCommands: string[];
  turns: UiTurn[];
  toolCalls: UiToolCall[];
  transcriptItems: UiTranscriptItem[];
  activeWrapperToolCallIds: string[];
  hiddenToolCallIds: string[];
  runtimeNotes: string[];
  activeRunId?: string;
  activeProcedure?: string;
  activeAssistantTurnId?: string;
  assistantParagraphBreakPending?: boolean;
  runStartedAtMs?: number;
  pendingStopRequest: boolean;
  stopRequestedRunId?: string;
  statusLine?: string;
  promptDiagnosticsLine?: string;
  tokenUsageLine?: string;
  inputDisabled: boolean;
  showToolCalls: boolean;
  expandedToolOutput: boolean;
}

export function createInitialUiState(params: {
  cwd?: string;
  buildLabel?: string;
  agentLabel?: string;
  showToolCalls?: boolean;
  expandedToolOutput?: boolean;
} = {}): UiState {
  return {
    cwd: params.cwd ?? process.cwd(),
    sessionId: "",
    buildLabel: params.buildLabel ?? "nanoboss",
    agentLabel: params.agentLabel ?? "connecting",
    availableCommands: [],
    turns: [],
    toolCalls: [],
    transcriptItems: [],
    activeWrapperToolCallIds: [],
    hiddenToolCallIds: [],
    runtimeNotes: [],
    pendingStopRequest: false,
    inputDisabled: false,
    showToolCalls: params.showToolCalls ?? true,
    expandedToolOutput: params.expandedToolOutput ?? false,
  };
}

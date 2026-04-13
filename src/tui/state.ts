import type { ToolPreviewBlock } from "../core/tool-call-preview.ts";
import type {
  DownstreamAgentSelection,
  FrontendPendingProcedureContinuation,
} from "../core/types.ts";

export type ToolCardThemeMode = "dark" | "light";

export interface UiPendingPrompt {
  id: string;
  text: string;
  kind: "steering" | "queued";
}

export interface UiTurn {
  id: string;
  role: "user" | "assistant" | "system";
  markdown: string;
  status?: "streaming" | "complete" | "failed" | "cancelled";
  runId?: string;
  displayStyle?: "inline" | "card";
  cardTone?: "info" | "success" | "warning" | "error";
  meta?: {
    procedure?: string;
    tokenUsageLine?: string;
    failureMessage?: string;
    completionNote?: string;
    statusMessage?: string;
  };
}

export interface UiToolCall {
  id: string;
  runId: string;
  parentToolCallId?: string;
  transcriptVisible?: boolean;
  removeOnTerminal?: boolean;
  title: string;
  kind: string;
  toolName?: string;
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
  pendingPrompts: UiPendingPrompt[];
  transcriptItems: UiTranscriptItem[];
  activeRunId?: string;
  activeProcedure?: string;
  activeAssistantTurnId?: string;
  assistantParagraphBreakPending?: boolean;
  runStartedAtMs?: number;
  activeRunAttemptedToolCallIds: string[];
  activeRunSucceededToolCallIds: string[];
  pendingStopRequest: boolean;
  stopRequestedRunId?: string;
  statusLine?: string;
  tokenUsageLine?: string;
  pendingProcedureContinuation?: FrontendPendingProcedureContinuation;
  inputDisabled: boolean;
  showToolCalls: boolean;
  expandedToolOutput: boolean;
  toolCardThemeMode: ToolCardThemeMode;
  simplify2AutoApprove: boolean;
}

export function createInitialUiState(params: {
  cwd?: string;
  buildLabel?: string;
  agentLabel?: string;
  showToolCalls?: boolean;
  expandedToolOutput?: boolean;
  toolCardThemeMode?: ToolCardThemeMode;
  simplify2AutoApprove?: boolean;
} = {}): UiState {
  return {
    cwd: params.cwd ?? process.cwd(),
    sessionId: "",
    buildLabel: params.buildLabel ?? "nanoboss",
    agentLabel: params.agentLabel ?? "connecting",
    availableCommands: [],
    turns: [],
    toolCalls: [],
    pendingPrompts: [],
    transcriptItems: [],
    activeRunAttemptedToolCallIds: [],
    activeRunSucceededToolCallIds: [],
    pendingStopRequest: false,
    inputDisabled: false,
    showToolCalls: params.showToolCalls ?? true,
    expandedToolOutput: params.expandedToolOutput ?? false,
    toolCardThemeMode: params.toolCardThemeMode ?? "dark",
    simplify2AutoApprove: params.simplify2AutoApprove ?? false,
  };
}

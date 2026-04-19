import type { RenderedFrontendEventEnvelope, TurnDisplayBlock } from "@nanoboss/adapters-http";
import type { DownstreamAgentSelection, PromptInput } from "@nanoboss/contracts";
import type { TokenUsageSummary } from "./format.ts";
import type { ToolCardThemeMode } from "./theme.ts";
import type { ToolPreviewBlock } from "./tool-preview.ts";

export type FrontendContinuation = Extract<
  RenderedFrontendEventEnvelope,
  { type: "continuation_updated" }
>["data"]["continuation"];

export interface UiPendingPrompt {
  id: string;
  text: string;
  kind: "steering" | "queued";
  promptInput?: PromptInput;
}

export interface UiTurn {
  id: string;
  role: "user" | "assistant" | "system";
  markdown: string;
  /**
   * Structured block-list projection for assistant turns. Consumed by the
   * view layer to preserve text/tool_call boundaries without re-deriving
   * them from `markdown`. Kept in sync with `markdown` so existing code
   * paths that still reference `markdown` keep working during rollout.
   */
  blocks?: TurnDisplayBlock[];
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

/**
 * A panel entry produced by a ui_panel event for any slot other than the
 * transcript (transcript-slot panels are materialized into UiTurn card
 * entries by the reducer so existing transcript rendering paths apply).
 * Keyed by (rendererId, key|undefined); lifetime controls when the reducer
 * evicts the entry.
 */
export interface UiPanel {
  rendererId: string;
  slot: string;
  key?: string;
  payload: unknown;
  lifetime: "turn" | "run" | "session";
  runId?: string;
  turnId?: string;
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
  tokenUsage?: TokenUsageSummary;
  pendingContinuation?: FrontendContinuation;
  inputDisabled: boolean;
  showToolCalls: boolean;
  expandedToolOutput: boolean;
  toolCardThemeMode: ToolCardThemeMode;
  simplify2AutoApprove: boolean;
  liveUpdatesPaused?: boolean;
  toolCardsHidden?: boolean;
  keybindingOverlayVisible: boolean;
  /**
   * Panels registered via ui.panel events for non-transcript slots.
   * Transcript-slot panels are materialized directly into turns.
   */
  panels: UiPanel[];
}

export function createInitialUiState(params: {
  cwd?: string;
  buildLabel?: string;
  agentLabel?: string;
  showToolCalls?: boolean;
  expandedToolOutput?: boolean;
  toolCardThemeMode?: ToolCardThemeMode;
  simplify2AutoApprove?: boolean;
  toolCardsHidden?: boolean;
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
    toolCardsHidden: params.toolCardsHidden ?? false,
    keybindingOverlayVisible: false,
    panels: [],
  };
}

import type { RenderedFrontendEventEnvelope, TurnDisplayBlock } from "@nanoboss/adapters-http";
import type { DownstreamAgentSelection, PromptInput } from "@nanoboss/contracts";
import type { TokenUsageSummary } from "./format.ts";
import type { ToolCardThemeMode } from "./theme.ts";
import type { ToolPreviewBlock } from "./tool-preview.ts";

export { createInitialUiState } from "./state-initial.ts";

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

export type UiInputDisabledReason = "run" | "local";

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
  | { type: "tool_call"; id: string }
  | { type: "procedure_panel"; id: string };

/**
 * A procedure panel entry rendered as a dedicated transcript block that is
 * always visible regardless of the tool-card toggle. Keyed by (rendererId,
 * key) for in-place replacement.
 */
export interface UiProcedurePanel {
  panelId: string;
  rendererId: string;
  payload: unknown;
  severity: "info" | "warn" | "error";
  dismissible: boolean;
  key?: string;
  runId?: string;
  turnId?: string;
  procedure?: string;
}

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
  inputDisabledReason?: UiInputDisabledReason;
  showToolCalls: boolean;
  expandedToolOutput: boolean;
  toolCardThemeMode: ToolCardThemeMode;
  simplify2AutoApprove: boolean;
  liveUpdatesPaused?: boolean;
  toolCardsHidden?: boolean;
  /**
   * Panels registered via ui.panel events for non-transcript slots.
   * Transcript-slot panels are materialized directly into turns.
   */
  panels: UiPanel[];
  /**
   * Procedure panels rendered as dedicated always-visible transcript
   * blocks. Unlike `panels`, these are not gated by the tool-card
   * toggle.
   */
  procedurePanels: UiProcedurePanel[];
}

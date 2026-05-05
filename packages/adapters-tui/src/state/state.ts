import type { RenderedFrontendEventEnvelope } from "@nanoboss/adapters-http";
import type { DownstreamAgentSelection, PromptInput } from "@nanoboss/contracts";
import type { TokenUsageSummary } from "../shared/format.ts";
import type { ToolCardThemeMode } from "../theme/theme.ts";
import type {
  UiTranscriptItem,
  UiTurn,
} from "./state-transcript.ts";
import type { UiToolCall } from "./state-tools.ts";
import type {
  UiPanel,
  UiProcedurePanel,
} from "./state-panels.ts";

export { createInitialUiState } from "./state-initial.ts";
export type {
  UiTranscriptItem,
  UiTurn,
} from "./state-transcript.ts";
export type { UiToolCall } from "./state-tools.ts";
export type {
  UiPanel,
  UiProcedurePanel,
} from "./state-panels.ts";

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

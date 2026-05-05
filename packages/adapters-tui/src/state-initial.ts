import type { ToolCardThemeMode } from "./theme.ts";
import type { UiState } from "./state.ts";

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
    panels: [],
    procedurePanels: [],
  };
}

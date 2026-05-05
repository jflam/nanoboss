import type { TokenUsageSummary } from "../shared/format.ts";
import type { UiPanel, UiState, UiTurn } from "../state/state.ts";
import { finalizeAssistantTurn } from "./reducer-run-finalize-turn.ts";
import { buildTurnCompletionNote } from "./reducer-run-completion-note.ts";

export function buildContinuationStatusLine(procedure: string): string {
  return `[continuation] /${procedure} active - waiting for your reply`;
}

export function buildDismissContinuationStatusLine(display?: string): string {
  const clearedMatch = display?.match(/\/([A-Za-z0-9/_-]+)/);
  return clearedMatch
    ? `[continuation] cleared /${clearedMatch[1]}`
    : "[continuation] nothing to clear";
}

export function finishRun(
  state: UiState,
  params: {
    turnStatus: UiTurn["status"];
    completionText?: string;
    tokenUsageLine?: string;
    tokenUsage?: TokenUsageSummary;
    failureMessage?: string;
    statusMessage?: string;
    completedAt?: string;
    statusLine: string;
  },
): UiState {
  const completionNote = buildTurnCompletionNote(state, params.turnStatus, params.completedAt);
  const nextState = finalizeAssistantTurn(state, {
    status: params.turnStatus,
    completionText: params.completionText,
    tokenUsageLine: params.tokenUsageLine,
    failureMessage: params.failureMessage,
    statusMessage: params.statusMessage,
    completionNote,
  });

  return {
    ...nextState,
    activeRunId: undefined,
    activeProcedure: undefined,
    activeAssistantTurnId: undefined,
    assistantParagraphBreakPending: undefined,
    runStartedAtMs: undefined,
    activeRunAttemptedToolCallIds: [],
    activeRunSucceededToolCallIds: [],
    pendingStopRequest: false,
    stopRequestedRunId: undefined,
    tokenUsageLine: params.tokenUsageLine ?? nextState.tokenUsageLine,
    tokenUsage: params.tokenUsage ?? nextState.tokenUsage,
    statusLine: params.statusLine,
    inputDisabled: false,
    inputDisabledReason: undefined,
    panels: evictPanelsByLifetime(nextState.panels, {
      runId: state.activeRunId,
      scopes: ["turn", "run"],
    }),
  };
}

export function evictPanelsByLifetime(
  panels: UiPanel[],
  params: { runId?: string; turnId?: string; scopes: ReadonlyArray<UiPanel["lifetime"]> },
): UiPanel[] {
  return panels.filter((panel) => {
    if (!params.scopes.includes(panel.lifetime)) {
      return true;
    }
    if (panel.lifetime === "turn") {
      if (params.turnId !== undefined) {
        return panel.turnId !== params.turnId;
      }
      return false;
    }
    if (panel.lifetime === "run") {
      if (params.runId !== undefined) {
        return panel.runId !== params.runId;
      }
      return false;
    }
    // session lifetime entries are never evicted here.
    return true;
  });
}

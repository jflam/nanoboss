import type { UiState } from "../state/state.ts";
import { appendTranscriptItem } from "./reducer-transcript-items.ts";
import {
  createTurn,
  nextTurnId,
} from "./reducer-turn-factory.ts";
import { evictPanelsByLifetime } from "./reducer-run-completion.ts";
import type { UiLocalAction } from "./reducer-actions.ts";

export function reduceLocalUserSubmitted(
  state: UiState,
  action: Extract<UiLocalAction, { type: "local_user_submitted" }>,
): UiState {
  const nextTurn = createTurn({
    id: nextTurnId("user", state.turns.length),
    role: "user",
    markdown: action.text,
    status: "complete",
  });

  return {
    ...state,
    turns: [...state.turns, nextTurn],
    transcriptItems: appendTranscriptItem(state.transcriptItems, { type: "turn", id: nextTurn.id }),
    activeRunId: undefined,
    activeProcedure: undefined,
    activeAssistantTurnId: undefined,
    assistantParagraphBreakPending: undefined,
    runStartedAtMs: Date.now(),
    activeRunAttemptedToolCallIds: [],
    activeRunSucceededToolCallIds: [],
    pendingStopRequest: false,
    stopRequestedRunId: undefined,
    statusLine: "[run] waiting for response",
    inputDisabled: true,
    inputDisabledReason: "run",
    panels: evictPanelsByLifetime(state.panels, {
      scopes: ["turn"],
    }),
  };
}

export function reduceLocalSendFailed(
  state: UiState,
  action: Extract<UiLocalAction, { type: "local_send_failed" }>,
): UiState {
  const nextTurn = createTurn({
    id: nextTurnId("system", state.turns.length),
    role: "system",
    markdown: action.error,
    status: "failed",
    displayStyle: "card",
    cardTone: "error",
  });

  return {
    ...state,
    turns: [...state.turns, nextTurn],
    transcriptItems: appendTranscriptItem(state.transcriptItems, { type: "turn", id: nextTurn.id }),
    activeRunId: undefined,
    activeProcedure: undefined,
    activeAssistantTurnId: undefined,
    assistantParagraphBreakPending: undefined,
    runStartedAtMs: undefined,
    activeRunAttemptedToolCallIds: [],
    activeRunSucceededToolCallIds: [],
    pendingStopRequest: false,
    stopRequestedRunId: undefined,
    statusLine: `[run] ${action.error}`,
    inputDisabled: false,
    inputDisabledReason: undefined,
  };
}

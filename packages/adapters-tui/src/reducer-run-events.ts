import type { RenderedFrontendEventEnvelope } from "@nanoboss/adapters-http";

import { formatTokenUsageLine, toTokenUsageSummary } from "./format.ts";
import { type UiState } from "./state.ts";
import { STOP_REQUESTED_STATUS } from "./reducer-local-actions.ts";
import {
  buildContinuationStatusLine,
  buildDismissContinuationStatusLine,
  finishRun,
} from "./reducer-run-completion.ts";
import {
  appendAssistantText,
} from "./reducer-turns.ts";

type FrontendEventOf<Type extends RenderedFrontendEventEnvelope["type"]> = Extract<
  RenderedFrontendEventEnvelope,
  { type: Type }
>;

export function reduceRunStartedEvent(
  state: UiState,
  event: FrontendEventOf<"run_started">,
): UiState {
  const stopRequestedRunId = state.pendingStopRequest || state.stopRequestedRunId === event.data.runId
    ? event.data.runId
    : undefined;
  const parsedStartedAtMs = Date.parse(event.data.startedAt);
  const runStartedAtMs = Number.isFinite(parsedStartedAtMs)
    ? state.runStartedAtMs !== undefined
      ? Math.min(state.runStartedAtMs, parsedStartedAtMs)
      : parsedStartedAtMs
    : state.runStartedAtMs ?? Date.now();
  return {
    ...state,
    activeRunId: event.data.runId,
    activeProcedure: event.data.procedure,
    activeAssistantTurnId: undefined,
    assistantParagraphBreakPending: undefined,
    runStartedAtMs,
    activeRunAttemptedToolCallIds: [],
    activeRunSucceededToolCallIds: [],
    pendingStopRequest: false,
    stopRequestedRunId,
    statusLine: stopRequestedRunId ? STOP_REQUESTED_STATUS : `[run] invoking /${event.data.procedure}…`,
    inputDisabled: true,
    inputDisabledReason: "run",
  };
}

export function reduceTextDeltaEvent(
  state: UiState,
  event: FrontendEventOf<"text_delta">,
): UiState {
  return appendAssistantText(state, event.data.text);
}

export function reduceTokenUsageEvent(
  state: UiState,
  event: FrontendEventOf<"token_usage">,
): UiState {
  return {
    ...state,
    tokenUsageLine: formatTokenUsageLine(event.data.usage),
    tokenUsage: toTokenUsageSummary(event.data.usage),
  };
}

export function reduceRunHeartbeatEvent(
  state: UiState,
  event: FrontendEventOf<"run_heartbeat">,
): UiState {
  if (state.stopRequestedRunId === event.data.runId) {
    return state;
  }

  const now = Date.parse(event.data.at) || Date.now();
  const startedAt = state.runStartedAtMs ?? now;
  const elapsedSeconds = Math.max(1, Math.round((now - startedAt) / 1_000));
  return {
    ...state,
    statusLine: `[run] /${event.data.procedure} still working (${elapsedSeconds}s)`,
  };
}

export function reduceRunCompletedEvent(
  state: UiState,
  event: FrontendEventOf<"run_completed">,
): UiState {
  const tokenUsageLine = event.data.tokenUsage ? formatTokenUsageLine(event.data.tokenUsage) : state.tokenUsageLine;
  const tokenUsage = event.data.tokenUsage ? toTokenUsageSummary(event.data.tokenUsage) : state.tokenUsage;
  const statusLine = event.data.procedure === "dismiss"
    ? buildDismissContinuationStatusLine(event.data.display)
    : `[run] ${event.data.procedure} completed`;
  return finishRun(state, {
    turnStatus: "complete",
    completionText: event.data.display,
    tokenUsageLine,
    tokenUsage,
    completedAt: event.data.completedAt,
    statusLine,
  });
}

export function reduceRunPausedEvent(
  state: UiState,
  event: FrontendEventOf<"run_paused">,
): UiState {
  const tokenUsageLine = event.data.tokenUsage ? formatTokenUsageLine(event.data.tokenUsage) : state.tokenUsageLine;
  const tokenUsage = event.data.tokenUsage ? toTokenUsageSummary(event.data.tokenUsage) : state.tokenUsage;
  const nextState = finishRun(state, {
    turnStatus: "complete",
    completionText: event.data.display ?? event.data.question,
    tokenUsageLine,
    tokenUsage,
    completedAt: event.data.pausedAt,
    statusLine: buildContinuationStatusLine(event.data.procedure),
  });
  return {
    ...nextState,
    pendingContinuation: {
      procedure: event.data.procedure,
      question: event.data.question,
      inputHint: event.data.inputHint,
      suggestedReplies: event.data.suggestedReplies,
      form: event.data.form,
    },
  };
}

export function reduceRunFailedEvent(
  state: UiState,
  event: FrontendEventOf<"run_failed">,
): UiState {
  const nextState = finishRun(state, {
    turnStatus: "failed",
    completionText: event.data.error,
    failureMessage: event.data.error,
    completedAt: event.data.completedAt,
    statusLine: `[run] ${event.data.error}`,
  });
  return { ...nextState, pendingContinuation: undefined };
}

export function reduceRunCancelledEvent(
  state: UiState,
  event: FrontendEventOf<"run_cancelled">,
): UiState {
  const nextState = finishRun(state, {
    turnStatus: "cancelled",
    completionText: event.data.message,
    statusMessage: event.data.message,
    completedAt: event.data.completedAt,
    statusLine: `[run] ${event.data.procedure} stopped`,
  });
  return { ...nextState, pendingContinuation: undefined };
}

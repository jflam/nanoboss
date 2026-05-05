import type { RenderedFrontendEventEnvelope } from "@nanoboss/adapters-http";

import { formatTokenUsageLine, toTokenUsageSummary } from "../shared/format.ts";
import { type UiState } from "../state/state.ts";
import { STOP_REQUESTED_STATUS } from "./reducer-local-status.ts";
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

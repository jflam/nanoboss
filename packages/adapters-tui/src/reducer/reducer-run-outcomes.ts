import type { RenderedFrontendEventEnvelope } from "@nanoboss/adapters-http";

import { formatTokenUsageLine, toTokenUsageSummary } from "../shared/format.ts";
import {
  buildContinuationStatusLine,
  buildDismissContinuationStatusLine,
  finishRun,
} from "./reducer-run-completion.ts";
import type { UiState } from "../state/state.ts";

type FrontendEventOf<Type extends RenderedFrontendEventEnvelope["type"]> = Extract<
  RenderedFrontendEventEnvelope,
  { type: Type }
>;

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

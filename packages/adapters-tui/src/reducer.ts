import {
  type RenderedFrontendEventEnvelope,
} from "@nanoboss/adapters-http";
import { formatProcedureStatusText } from "@nanoboss/procedure-engine";

import { formatTokenUsageLine, toTokenUsageSummary } from "./format.ts";
import {
  type UiState,
  type UiTranscriptItem,
  type UiTurn,
} from "./state.ts";
import {
  appendAssistantText,
  appendTranscriptItem,
  buildAssistantTurnMeta,
  createTurn,
  nextTurnId,
} from "./reducer-turns.ts";
import {
  buildContinuationStatusLine,
  buildDismissContinuationStatusLine,
  finishRun,
} from "./reducer-run-completion.ts";
import {
  appendProcedureCard,
  applyProcedurePanel,
  applyUiPanel,
} from "./reducer-panels.ts";
import {
  mergeAvailableCommands,
  reduceLocalUiAction,
  STOP_REQUESTED_STATUS,
} from "./reducer-local-actions.ts";
import {
  reduceToolStartedEvent,
  reduceToolUpdatedEvent,
} from "./reducer-tool-events.ts";
export type { UiAction } from "./reducer-actions.ts";
import type { UiAction } from "./reducer-actions.ts";

export function reduceUiState(state: UiState, action: UiAction): UiState {
  if (action.type === "frontend_event") {
    return reduceFrontendEvent(state, action.event);
  }

  return reduceLocalUiAction(state, action);
}

function reduceFrontendEvent(state: UiState, event: RenderedFrontendEventEnvelope): UiState {
  switch (event.type) {
    case "commands_updated":
      return {
        ...state,
        availableCommands: mergeAvailableCommands(event.data.commands),
      };
    case "run_restored": {
      const pendingContinuation = event.data.status === "paused"
        ? {
            procedure: event.data.procedure,
            question: "",
          }
        : state.pendingContinuation;
      const userTurn = createTurn({
        id: nextTurnId("user", state.turns.length),
        role: "user",
        markdown: event.data.prompt,
        status: "complete",
      });
      const nextTurns: UiTurn[] = [...state.turns, userTurn];
      const nextTranscriptItems: UiTranscriptItem[] = appendTranscriptItem(
        state.transcriptItems,
        { type: "turn", id: userTurn.id },
      );
      if (!event.data.text) {
        return {
          ...state,
          turns: nextTurns,
          transcriptItems: nextTranscriptItems,
          activeRunId: event.data.runId,
          activeProcedure: event.data.procedure,
          activeAssistantTurnId: undefined,
          assistantParagraphBreakPending: undefined,
          pendingContinuation,
        };
      }

      const assistantTurn = createTurn({
        id: nextTurnId("assistant", nextTurns.length),
        role: "assistant",
        markdown: event.data.text,
        blocks: event.data.text.length > 0
          ? [{ kind: "text", text: event.data.text, origin: "replay" }]
          : [],
        status: event.data.status === "paused" ? "complete" : event.data.status,
        runId: event.data.runId,
        meta: buildAssistantTurnMeta({
          procedure: event.data.procedure,
        }),
      });

      return {
        ...state,
        turns: [...nextTurns, assistantTurn],
        transcriptItems: appendTranscriptItem(nextTranscriptItems, { type: "turn", id: assistantTurn.id }),
        pendingContinuation,
      };
    }
    case "run_started": {
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
    case "continuation_updated":
      return {
        ...state,
        pendingContinuation: event.data.continuation,
      };
    case "procedure_status":
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      return {
        ...state,
        statusLine: formatProcedureStatusText(event.data.status),
      };
    case "procedure_card":
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      return appendProcedureCard(state, event.data);
    case "ui_panel":
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      return applyUiPanel(state, event.data);
    case "procedure_panel":
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      return applyProcedurePanel(state, event.data);
    case "text_delta":
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      return appendAssistantText(state, event.data.text);
    case "token_usage":
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      return {
        ...state,
        tokenUsageLine: formatTokenUsageLine(event.data.usage),
        tokenUsage: toTokenUsageSummary(event.data.usage),
      };
    case "run_heartbeat": {
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      if (isStopRequestedForRun(state, event.data.runId)) {
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
    case "tool_started": {
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      return reduceToolStartedEvent(state, event);
    }
    case "tool_updated": {
      return reduceToolUpdatedEvent(state, event);
    }
    case "run_completed": {
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
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
    case "run_paused": {
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
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
    case "run_failed": {
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      const nextState = finishRun(state, {
        turnStatus: "failed",
        completionText: event.data.error,
        failureMessage: event.data.error,
        completedAt: event.data.completedAt,
        statusLine: `[run] ${event.data.error}`,
      });
      return { ...nextState, pendingContinuation: undefined };
    }
    case "run_cancelled": {
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      const nextState = finishRun(state, {
        turnStatus: "cancelled",
        completionText: event.data.message,
        statusMessage: event.data.message,
        completedAt: event.data.completedAt,
        statusLine: `[run] ${event.data.procedure} stopped`,
      });
      return { ...nextState, pendingContinuation: undefined };
    }
  }
}

function shouldIgnoreMismatchedRunEvent(state: UiState, runId: string): boolean {
  return state.activeRunId !== undefined && state.activeRunId !== runId;
}

function isStopRequestedForRun(state: UiState, runId: string): boolean {
  return state.stopRequestedRunId === runId;
}

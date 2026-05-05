import type { RenderedFrontendEventEnvelope } from "@nanoboss/adapters-http";
import { formatProcedureStatusText } from "@nanoboss/procedure-engine";

import type { UiState } from "../state/state.ts";
import {
  appendProcedureCard,
  applyUiPanel,
} from "./reducer-panels.ts";
import { applyProcedurePanel } from "./reducer-procedure-panels.ts";
import { mergeAvailableCommands } from "./reducer-session-ready.ts";
import {
  reduceRunHeartbeatEvent,
  reduceRunStartedEvent,
  reduceTextDeltaEvent,
  reduceTokenUsageEvent,
} from "./reducer-run-events.ts";
import {
  reduceRunCancelledEvent,
  reduceRunCompletedEvent,
  reduceRunFailedEvent,
  reduceRunPausedEvent,
} from "./reducer-run-outcomes.ts";
import { reduceRunRestoredEvent } from "./reducer-run-restore.ts";
import {
  reduceToolStartedEvent,
  reduceToolUpdatedEvent,
} from "./reducer-tool-events.ts";

export function reduceFrontendEvent(state: UiState, event: RenderedFrontendEventEnvelope): UiState {
  switch (event.type) {
    case "commands_updated":
      return {
        ...state,
        availableCommands: mergeAvailableCommands(event.data.commands),
      };
    case "run_restored":
      return reduceRunRestoredEvent(state, event);
    case "run_started":
      return reduceRunStartedEvent(state, event);
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
      return reduceTextDeltaEvent(state, event);
    case "token_usage":
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      return reduceTokenUsageEvent(state, event);
    case "run_heartbeat":
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      return reduceRunHeartbeatEvent(state, event);
    case "tool_started":
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      return reduceToolStartedEvent(state, event);
    case "tool_updated":
      return reduceToolUpdatedEvent(state, event);
    case "run_completed":
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      return reduceRunCompletedEvent(state, event);
    case "run_paused":
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      return reduceRunPausedEvent(state, event);
    case "run_failed":
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      return reduceRunFailedEvent(state, event);
    case "run_cancelled":
      if (shouldIgnoreMismatchedRunEvent(state, event.data.runId)) {
        return state;
      }
      return reduceRunCancelledEvent(state, event);
  }
}

function shouldIgnoreMismatchedRunEvent(state: UiState, runId: string): boolean {
  return state.activeRunId !== undefined && state.activeRunId !== runId;
}

import type { UiState } from "../state/state.ts";
import type { UiLocalAction } from "./reducer-actions.ts";

export const STOP_REQUESTED_STATUS = "[run] ESC received - stopping at next tool boundary...";

type LocalStatusAction = Extract<UiLocalAction, {
  type:
    | "local_status"
    | "local_busy_started"
    | "local_busy_finished"
    | "local_stop_requested"
    | "local_stop_request_failed";
}>;

export function reduceLocalStatusAction(state: UiState, action: LocalStatusAction): UiState {
  switch (action.type) {
    case "local_status":
      return {
        ...state,
        statusLine: action.text,
      };
    case "local_busy_started":
      return {
        ...state,
        statusLine: action.text,
        inputDisabled: true,
        inputDisabledReason: "local",
      };
    case "local_busy_finished":
      if (state.inputDisabledReason !== "local") {
        return state;
      }
      return {
        ...state,
        statusLine: undefined,
        inputDisabled: false,
        inputDisabledReason: undefined,
      };
    case "local_stop_requested":
      return {
        ...state,
        pendingStopRequest: !action.runId,
        stopRequestedRunId: action.runId,
        statusLine: STOP_REQUESTED_STATUS,
      };
    case "local_stop_request_failed":
      if (action.runId) {
        if (state.stopRequestedRunId !== action.runId) {
          return state;
        }
      } else if (!state.pendingStopRequest) {
        return state;
      }

      return {
        ...state,
        pendingStopRequest: false,
        stopRequestedRunId: undefined,
        statusLine: action.text,
      };
  }
}

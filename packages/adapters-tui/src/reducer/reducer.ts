import { type UiState } from "../state/state.ts";
import {
  reduceLocalUiAction,
} from "./reducer-local-actions.ts";
import { reduceFrontendEvent } from "./reducer-frontend-events.ts";
export type { UiAction } from "./reducer-actions.ts";
import type { UiAction } from "./reducer-actions.ts";

export function reduceUiState(state: UiState, action: UiAction): UiState {
  if (action.type === "frontend_event") {
    return reduceFrontendEvent(state, action.event);
  }

  return reduceLocalUiAction(state, action);
}

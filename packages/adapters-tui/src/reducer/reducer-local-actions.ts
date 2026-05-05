import type { UiState } from "../state/state.ts";
import { applyLocalProcedurePanel } from "./reducer-local-procedure-panels.ts";
import {
  reduceLocalSendFailed,
  reduceLocalUserSubmitted,
} from "./reducer-local-turns.ts";
import type { UiLocalAction } from "./reducer-actions.ts";
import { reduceSessionReady } from "./reducer-session-ready.ts";
import { reduceLocalStatusAction } from "./reducer-local-status.ts";

export function reduceLocalUiAction(state: UiState, action: UiLocalAction): UiState {
  switch (action.type) {
    case "session_ready":
      return reduceSessionReady(state, action);
    case "local_user_submitted":
      return reduceLocalUserSubmitted(state, action);
    case "local_send_failed":
      return reduceLocalSendFailed(state, action);
    case "local_status":
    case "local_busy_started":
    case "local_busy_finished":
    case "local_stop_requested":
    case "local_stop_request_failed":
      return reduceLocalStatusAction(state, action);
    case "local_pending_prompt_added":
      return {
        ...state,
        pendingPrompts: [...state.pendingPrompts, action.prompt],
      };
    case "local_pending_prompt_removed":
      return {
        ...state,
        pendingPrompts: state.pendingPrompts.filter((prompt) => prompt.id !== action.promptId),
      };
    case "local_pending_prompts_cleared":
      return {
        ...state,
        pendingPrompts: [],
        statusLine: action.text,
      };
    case "local_agent_selection":
      return {
        ...state,
        agentLabel: action.agentLabel,
        defaultAgentSelection: action.selection,
      };
    case "local_tool_card_theme_mode":
      return {
        ...state,
        toolCardThemeMode: action.mode,
      };
    case "local_simplify2_auto_approve":
      return {
        ...state,
        simplify2AutoApprove: action.enabled,
        statusLine: `[simplify2] auto-approve ${action.enabled ? "on" : "off"}`,
      };
    case "session_auto_approve":
      return {
        ...state,
        simplify2AutoApprove: action.enabled,
        statusLine: `[session] auto-approve ${action.enabled ? "on" : "off"}`,
      };
    case "toggle_tool_output":
      return {
        ...state,
        expandedToolOutput: !state.expandedToolOutput,
      };
    case "toggle_tool_cards_hidden":
      return {
        ...state,
        toolCardsHidden: !state.toolCardsHidden,
      };
    case "local_procedure_panel":
      return applyLocalProcedurePanel(state, action);
  }

  const _exhaustive: never = action;
  return _exhaustive;
}

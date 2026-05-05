import type { FrontendCommand } from "@nanoboss/adapters-http";

import { LOCAL_TUI_COMMANDS } from "./commands.ts";
import {
  createInitialUiState,
  type UiState,
} from "./state.ts";
import {
  appendTranscriptItem,
  createTurn,
  nextTurnId,
} from "./reducer-turns.ts";
import { evictPanelsByLifetime } from "./reducer-run-completion.ts";
import { applyLocalProcedurePanel } from "./reducer-procedure-panels.ts";
import type { UiLocalAction } from "./reducer-actions.ts";

export const STOP_REQUESTED_STATUS = "[run] ESC received - stopping at next tool boundary...";

export function reduceLocalUiAction(state: UiState, action: UiLocalAction): UiState {
  switch (action.type) {
    case "session_ready":
      return {
        ...createInitialUiState({
          cwd: action.cwd,
          buildLabel: action.buildLabel,
          agentLabel: action.agentLabel,
          showToolCalls: state.showToolCalls,
          expandedToolOutput: state.expandedToolOutput,
          toolCardThemeMode: state.toolCardThemeMode,
          simplify2AutoApprove: action.autoApprove,
          toolCardsHidden: state.toolCardsHidden,
        }),
        sessionId: action.sessionId,
        buildLabel: action.buildLabel,
        agentLabel: action.agentLabel,
        simplify2AutoApprove: action.autoApprove,
        defaultAgentSelection: action.defaultAgentSelection,
        availableCommands: mergeAvailableCommands(action.commands),
      };
    case "local_user_submitted": {
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
    case "local_send_failed": {
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

export function mergeAvailableCommands(commands: FrontendCommand[]): string[] {
  return uniqueStrings([
    ...commands.map((command) => `/${command.name}`),
    ...LOCAL_TUI_COMMANDS.map((command) => command.name),
  ]);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

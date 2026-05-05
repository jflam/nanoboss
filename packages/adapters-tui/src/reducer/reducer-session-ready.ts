import type { FrontendCommand } from "@nanoboss/adapters-http";

import { LOCAL_TUI_COMMANDS } from "../app/commands.ts";
import {
  createInitialUiState,
  type UiState,
} from "../state/state.ts";
import type { UiLocalAction } from "./reducer-actions.ts";

export function reduceSessionReady(
  state: UiState,
  action: Extract<UiLocalAction, { type: "session_ready" }>,
): UiState {
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

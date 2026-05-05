import type { Component } from "../shared/pi-tui.ts";
import type { UiProcedurePanel, UiState, UiToolCall, UiTranscriptItem, UiTurn } from "../state/state.ts";
import type { NanobossTuiTheme } from "../theme/theme.ts";
import { ProcedurePanelTranscriptComponent } from "./views-procedure-panels.ts";
import { ToolTranscriptEntryComponent } from "./views-tool-transcript.ts";
import { TurnTranscriptComponent } from "./views-turns.ts";

export function createTranscriptEntryComponents(theme: NanobossTuiTheme, state: UiState): Component[] {
  if (state.transcriptItems.length === 0) {
    return [];
  }

  const turnById = new Map(state.turns.map((turn): [string, UiTurn] => [turn.id, turn]));
  const toolById = new Map(state.toolCalls.map((toolCall): [string, UiToolCall] => [toolCall.id, toolCall]));
  const panelById = new Map(state.procedurePanels.map((panel): [string, UiProcedurePanel] => [panel.panelId, panel]));
  const components: Component[] = [];

  for (const item of state.transcriptItems) {
    if (item.type === "tool_call" && state.toolCardsHidden) {
      continue;
    }

    const component = createTranscriptEntryComponent(theme, item, turnById, toolById, panelById, state, state.expandedToolOutput);
    if (component) {
      components.push(component);
    }
  }

  return components;
}

function createTranscriptEntryComponent(
  theme: NanobossTuiTheme,
  item: UiTranscriptItem,
  turnById: Map<string, UiTurn>,
  toolById: Map<string, UiToolCall>,
  panelById: Map<string, UiProcedurePanel>,
  state: UiState,
  expandedToolOutput: boolean,
): Component | undefined {
  if (item.type === "turn") {
    const turn = turnById.get(item.id);
    return turn ? new TurnTranscriptComponent(theme, turn) : undefined;
  }

  if (item.type === "procedure_panel") {
    const panel = panelById.get(item.id);
    return panel ? new ProcedurePanelTranscriptComponent(theme, panel, state) : undefined;
  }

  const toolCall = toolById.get(item.id);
  return toolCall ? new ToolTranscriptEntryComponent(theme, toolCall, expandedToolOutput) : undefined;
}

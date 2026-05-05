import { Container, Spacer, type Component } from "./pi-tui.ts";
import type { UiProcedurePanel, UiState, UiToolCall, UiTranscriptItem, UiTurn } from "./state.ts";
import type { NanobossTuiTheme } from "./theme.ts";
import { registerChromeContribution } from "./chrome.ts";
import { ToolCardComponent } from "./components/tool-card.ts";
import { ProcedurePanelTranscriptComponent } from "./views-procedure-panels.ts";
import { TurnTranscriptComponent } from "./views-turns.ts";

/**
 * Transcript component used by the core "transcript" chrome contribution.
 * Keeps its own children in sync with state.transcriptItems via setState,
 * matching the pre-migration incremental rebuild behavior.
 */
class TranscriptComponent implements Component {
  private readonly container = new Container();

  constructor(
    private readonly theme: NanobossTuiTheme,
    initialState: UiState,
  ) {
    this.setState(initialState);
  }

  setState(state: UiState): void {
    this.container.clear();

    if (state.transcriptItems.length === 0) {
      return;
    }

    const turnById = new Map(state.turns.map((turn): [string, UiTurn] => [turn.id, turn]));
    const toolById = new Map(state.toolCalls.map((toolCall): [string, UiToolCall] => [toolCall.id, toolCall]));
    const panelById = new Map(state.procedurePanels.map((panel): [string, UiProcedurePanel] => [panel.panelId, panel]));
    for (const item of state.transcriptItems) {
      if (item.type === "tool_call" && state.toolCardsHidden) {
        continue;
      }
      const component = createTranscriptEntryComponent(this.theme, item, turnById, toolById, panelById, state, state.expandedToolOutput);
      if (component) {
        this.container.addChild(component);
      }
    }
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  invalidate(): void {
    this.container.invalidate();
  }
}

class ToolTranscriptEntryComponent implements Component {
  private readonly container = new Container();

  constructor(
    private readonly theme: NanobossTuiTheme,
    private toolCall: UiToolCall,
    private expanded: boolean,
  ) {
    this.rebuild();
  }

  setToolCall(toolCall: UiToolCall, expanded: boolean, forceRefresh = false): void {
    if (!forceRefresh && this.toolCall === toolCall && this.expanded === expanded) {
      return;
    }

    this.toolCall = toolCall;
    this.expanded = expanded;
    this.rebuild();
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  invalidate(): void {
    this.container.invalidate();
    this.rebuild();
  }

  private rebuild(): void {
    this.container.clear();
    this.container.addChild(new ToolCardComponent(this.theme, this.toolCall, this.expanded));
    this.container.addChild(new Spacer(1));
  }
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

registerChromeContribution({
  id: "core.transcript",
  slot: "transcript",
  order: 0,
  render: ({ getState, theme }) => new TranscriptComponent(theme, getState()),
});

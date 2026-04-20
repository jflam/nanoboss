import { Container, Markdown, Spacer, Text, TruncatedText, type Component } from "./pi-tui.ts";
import type { UiProcedurePanel, UiState, UiToolCall, UiTranscriptItem, UiTurn } from "./state.ts";
import type { NanobossTuiTheme } from "./theme.ts";
import {
  getChromeContributions,
  registerChromeContribution,
  type ChromeContribution,
  type ChromeRenderContext,
  type ChromeSlotId,
} from "./chrome.ts";
import { getPanelRenderer } from "./panel-renderers.ts";

// Side-effect imports: register every core chrome contribution and
// activity-bar segment into the module-level registries before any
// NanobossAppView instance iterates them.
import "./core-chrome.ts";
import "./core-activity-bar.ts";
import "./core-panels.ts";

import { MessageCardComponent } from "./components/message-card.ts";
import { ToolCardComponent } from "./components/tool-card.ts";

/**
 * Ordered list of chrome slots rendered by NanobossAppView. The composer
 * slot is rendered by the view itself (using the per-instance editor /
 * overlay composer); every other slot is driven by the registered
 * contributions in chrome.ts.
 */
const SLOT_ORDER: ChromeSlotId[] = [
  "header",
  "session",
  "status",
  "transcriptAbove",
  "transcript",
  "transcriptBelow",
  "composerAbove",
  "composer",
  "composerBelow",
  "activityBar",
  "overlay",
  "footer",
];

interface StatefulChild {
  setState(state: UiState): void;
}

class GatedComponent implements Component {
  constructor(
    private readonly inner: Component,
    private readonly gate: () => boolean,
  ) {}

  render(width: number): string[] {
    if (!this.gate()) {
      return [];
    }
    return this.inner.render(width);
  }

  invalidate(): void {
    this.inner.invalidate();
  }
}

export class NanobossAppView implements Component {
  private readonly container = new Container();
  private readonly composerContainer = new Container();
  private readonly statefulChildren: StatefulChild[] = [];
  private state: UiState;

  constructor(
    private readonly editor: Component,
    private readonly theme: NanobossTuiTheme,
    initialState: UiState,
    private readonly nowProvider: () => number = Date.now,
  ) {
    this.state = initialState;
    this.composerContainer.addChild(this.editor);

    const ctx: ChromeRenderContext = {
      state: this.state,
      theme: this.theme,
      getState: () => this.state,
      getNowMs: () => this.nowProvider(),
    };

    for (const slot of SLOT_ORDER) {
      if (slot === "composer") {
        this.container.addChild(this.composerContainer);
        continue;
      }
      for (const contribution of getChromeContributions(slot)) {
        this.mountContribution(contribution, ctx);
      }
    }

    // Give every stateful child the initial state snapshot so their
    // internal layout matches the constructor-time state exactly (this
    // mirrors the pre-migration behavior where TranscriptComponent was
    // seeded with the initial state during construction).
    for (const child of this.statefulChildren) {
      child.setState(this.state);
    }
  }

  private mountContribution(contribution: ChromeContribution, ctx: ChromeRenderContext): void {
    const component = contribution.render(ctx);
    const gated = contribution.shouldRender
      ? new GatedComponent(component, () => contribution.shouldRender!(this.state))
      : component;
    this.container.addChild(gated);
    const candidate = component as unknown as { setState?: (state: UiState) => void };
    if (typeof candidate.setState === "function") {
      const setState = candidate.setState.bind(component);
      this.statefulChildren.push({ setState: (state) => setState(state) });
    }
  }

  setState(state: UiState): void {
    this.state = state;
    for (const child of this.statefulChildren) {
      child.setState(state);
    }
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  invalidate(): void {
    for (const child of this.statefulChildren) {
      child.setState(this.state);
    }
    this.container.invalidate();
  }

  showComposer(component: Component): void {
    this.composerContainer.clear();
    this.composerContainer.addChild(component);
    this.container.invalidate();
  }

  showEditor(): void {
    this.showComposer(this.editor);
  }
}

/**
 * Transcript component used by the core "transcript" chrome contribution.
 * Keeps its own children in sync with state.transcriptItems via setState,
 * matching the pre-migration incremental rebuild behavior.
 */
export class TranscriptComponent implements Component {
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

class TurnTranscriptComponent implements Component {
  private readonly container = new Container();

  constructor(
    private readonly theme: NanobossTuiTheme,
    private turn: UiTurn,
  ) {
    this.rebuild();
  }

  setTurn(turn: UiTurn, forceRefresh = false): void {
    if (!forceRefresh && this.turn === turn) {
      return;
    }

    this.turn = turn;
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
    this.container.addChild(new TruncatedText(renderTurnLabel(this.theme, this.turn)));
    this.container.addChild(renderTurnBody(this.theme, this.turn));
    this.container.addChild(new Spacer(1));
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

class ProcedurePanelTranscriptComponent implements Component {
  private readonly container = new Container();

  constructor(
    private readonly theme: NanobossTuiTheme,
    private readonly panel: UiProcedurePanel,
    private readonly state: UiState,
  ) {
    this.rebuild();
  }

  private rebuild(): void {
    this.container.clear();
    const rendererEntry = getPanelRenderer(this.panel.rendererId);
    let body: Component | undefined;
    if (rendererEntry && rendererEntry.schema.validate(this.panel.payload)) {
      body = rendererEntry.render({
        payload: this.panel.payload,
        state: this.state,
        theme: this.theme,
      });
    }
    if (!body) {
      const tone = procedurePanelTone(this.panel.severity);
      const text = formatProcedurePanelFallback(this.panel);
      body = new MessageCardComponent(this.theme, text.split("\n"), tone);
    }
    this.container.addChild(body);
    this.container.addChild(new Spacer(1));
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  invalidate(): void {
    this.container.invalidate();
  }
}

function procedurePanelTone(severity: UiProcedurePanel["severity"]): NonNullable<UiTurn["cardTone"]> {
  switch (severity) {
    case "error":
      return "error";
    case "warn":
      return "warning";
    default:
      return "info";
  }
}

function formatProcedurePanelFallback(panel: UiProcedurePanel): string {
  const payload = panel.payload;
  if (payload && typeof payload === "object") {
    const message = (payload as { message?: unknown }).message;
    const procedure = (payload as { procedure?: unknown }).procedure;
    if (typeof message === "string") {
      return typeof procedure === "string"
        ? `/${procedure}: ${message}`
        : message;
    }
  }
  return `[panel ${panel.rendererId}]`;
}

function renderTurnLabel(theme: NanobossTuiTheme, turn: UiTurn): string {
  switch (turn.role) {
    case "user":
      return theme.accent("you");
    case "assistant":
      return turn.status === "failed"
        ? theme.error("nanoboss")
        : turn.status === "cancelled"
          ? theme.warning("nanoboss")
          : theme.success("nanoboss");
    case "system":
      return theme.warning("system");
  }
}

function renderTurnBody(theme: NanobossTuiTheme, turn: UiTurn): Component {
  if (turn.role === "assistant") {
    if (turn.displayStyle === "card") {
      return renderMessageCard(theme, turn.markdown, turn.cardTone ?? inferTurnCardTone(turn));
    }

    const container = new Container();
    const textBlocks = (turn.blocks ?? []).filter(
      (block): block is Extract<NonNullable<UiTurn["blocks"]>[number], { kind: "text" }> =>
        block.kind === "text",
    );
    const bodyText = textBlocks.length > 0
      ? textBlocks.map((block) => block.text).join("")
      : turn.markdown;
    container.addChild(bodyText.length === 0
      ? new Text(theme.dim("…"))
      : new Markdown(bodyText, 0, 0, theme.markdown, {
          color: theme.text,
        }));

    if (turn.meta?.statusMessage) {
      container.addChild(new Spacer(1));
      container.addChild(renderMessageCard(theme, turn.meta.statusMessage, "warning"));
    }

    if (turn.meta?.failureMessage) {
      container.addChild(new Spacer(1));
      container.addChild(renderMessageCard(theme, `Error: ${turn.meta.failureMessage}`, "error"));
    }

    if (turn.meta?.completionNote) {
      container.addChild(new Spacer(1));
      container.addChild(renderMessageCard(theme, turn.meta.completionNote, "info"));
    }

    return container;
  }

  if (turn.role === "system") {
    return renderMessageCard(
      theme,
      turn.markdown,
      turn.status === "failed" ? "error" : (turn.cardTone ?? "warning"),
    );
  }

  return new Text(turn.markdown);
}

function renderMessageCard(
  theme: NanobossTuiTheme,
  markdown: string,
  tone: NonNullable<UiTurn["cardTone"]>,
): Component {
  const lines = markdown.length === 0 ? ["…"] : markdown.split("\n");
  return new MessageCardComponent(theme, lines, tone);
}

function inferTurnCardTone(turn: UiTurn): NonNullable<UiTurn["cardTone"]> {
  if (turn.status === "failed") {
    return "error";
  }

  if (turn.status === "cancelled") {
    return "warning";
  }

  if (turn.status === "complete") {
    return "success";
  }

  return "info";
}

registerChromeContribution({
  id: "core.transcript",
  slot: "transcript",
  order: 0,
  render: ({ getState, theme }) => new TranscriptComponent(theme, getState()),
});

/**
 * Renders any panels registered via ui_panel events whose slot matches
 * this component's slot. Slot-specific contributions are registered
 * below for every non-transcript slot; the transcript slot materializes
 * nb/card@1 panels into turns at the reducer layer.
 */
class PanelsInSlotComponent implements Component {
  private readonly container = new Container();
  private readonly childComponents = new Set<Component>();
  private state: UiState;
  private lastKeys: string[] = [];

  constructor(
    private readonly theme: NanobossTuiTheme,
    private readonly slot: ChromeSlotId,
    initialState: UiState,
  ) {
    this.state = initialState;
    this.rebuild();
  }

  setState(state: UiState): void {
    this.state = state;
    this.rebuild();
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  invalidate(): void {
    this.container.invalidate();
    for (const child of this.childComponents) {
      child.invalidate();
    }
  }

  private rebuild(): void {
    const panels = this.state.panels.filter((panel) => panel.slot === this.slot);
    const keys = panels.map((panel) => `${panel.rendererId}::${panel.key ?? ""}`);
    const sameKeys = keys.length === this.lastKeys.length
      && keys.every((key, i) => key === this.lastKeys[i]);
    if (sameKeys && panels.length === this.childComponents.size) {
      return;
    }
    this.lastKeys = keys;
    this.container.clear();
    this.childComponents.clear();
    for (const panel of panels) {
      const renderer = getPanelRenderer(panel.rendererId);
      if (!renderer || !renderer.schema.validate(panel.payload)) {
        continue;
      }
      const component = renderer.render({
        payload: panel.payload,
        state: this.state,
        theme: this.theme,
      });
      this.childComponents.add(component);
      this.container.addChild(component);
    }
  }
}

const PANEL_HOST_SLOTS: ChromeSlotId[] = [
  "header",
  "session",
  "status",
  "transcriptAbove",
  "transcriptBelow",
  "composerAbove",
  "composerBelow",
  "activityBar",
  "overlay",
  "footer",
];

for (const slot of PANEL_HOST_SLOTS) {
  registerChromeContribution({
    id: `core.panels.${slot}`,
    slot,
    order: 1000,
    shouldRender: (state) => state.panels.some((panel) => panel.slot === slot),
    render: ({ getState, theme }) => new PanelsInSlotComponent(theme, slot, getState()),
  });
}

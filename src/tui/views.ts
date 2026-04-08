import { Container, Markdown, Spacer, Text, TruncatedText, type Component } from "./pi-tui.ts";
import type { UiState, UiToolCall, UiTranscriptItem, UiTurn } from "./state.ts";
import type { NanobossTuiTheme } from "./theme.ts";

import { MessageCardComponent } from "./components/message-card.ts";
import { ToolCardComponent } from "./components/tool-card.ts";
import { formatElapsedRunTimer } from "./format.ts";

export class NanobossAppView implements Component {
  private readonly container = new Container();
  private readonly composerContainer = new Container();
  private readonly transcript: TranscriptComponent;
  private state: UiState;

  constructor(
    private readonly editor: Component,
    private readonly theme: NanobossTuiTheme,
    initialState: UiState,
    private readonly nowProvider: () => number = Date.now,
  ) {
    this.state = initialState;
    this.transcript = new TranscriptComponent(this.theme, this.state);

    this.container.addChild(new ComputedTruncatedText(() => this.buildHeaderLine()));
    this.container.addChild(new ComputedTruncatedText(() => this.buildSessionLine()));
    this.container.addChild(new ComputedTruncatedText(() => this.buildStatusLine()));
    this.container.addChild(new Spacer(1));
    this.container.addChild(this.transcript);
    this.composerContainer.addChild(this.editor);
    this.container.addChild(this.composerContainer);
    this.container.addChild(new Spacer(1));
    this.container.addChild(new ComputedTruncatedText(() => this.buildActivityBarLine()));
    this.container.addChild(new ComputedTruncatedText(() => this.buildFooterLine()));
  }

  setState(state: UiState): void {
    const forceTranscriptRefresh = this.state.toolCardThemeMode !== state.toolCardThemeMode;
    this.state = state;
    this.transcript.setState(this.state, forceTranscriptRefresh);
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  invalidate(): void {
    this.transcript.setState(this.state, true);
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

  private buildHeaderLine(): string {
    const cwd = this.state.cwd || process.cwd();
    return this.theme.accent(`${this.state.buildLabel} • ${cwd}`);
  }

  private buildSessionLine(): string {
    if (!this.state.sessionId) {
      return this.theme.dim("Connecting to nanoboss…");
    }

    return this.theme.dim(`session ${this.state.sessionId.slice(0, 8)} • retained transcript + pi-tui editor`);
  }

  private buildStatusLine(): string | undefined {
    if (!this.state.statusLine) {
      return undefined;
    }

    return styleStatusLine(this.theme, this.state.statusLine);
  }

  private buildActivityBarLine(): string {
    const separator = this.theme.dim(" • ");
    const parts = buildActivityBarParts(this.theme, this.state);
    const runTimerLine = buildRunTimerLine(this.state, this.nowProvider());
    if (runTimerLine) {
      parts.push(this.theme.warning(runTimerLine));
    }
    if (this.state.tokenUsageLine) {
      parts.push(this.theme.success(this.state.tokenUsageLine));
    }
    return parts.join(separator);
  }

  private buildFooterLine(): string {
    const parts = [
      this.state.inputDisabled ? "enter steer" : "enter send",
      "shift+enter newline",
      "ctrl+o tools",
      this.state.expandedToolOutput ? "expanded" : "collapsed",
      "/new",
      "/model",
      `/${this.state.toolCardThemeMode}`,
      this.state.toolCardThemeMode === "dark" ? "/light" : "/dark",
      "/quit",
    ];
    if (this.state.pendingProcedureContinuation) {
      parts.push("/dismiss");
    }
    if (this.state.inputDisabled) {
      parts.push(
        "tab queue",
        "esc stop",
        this.state.pendingPrompts.length > 0 ? `${this.state.pendingPrompts.length} pending` : "run active",
      );
    }
    return this.theme.dim(parts.join(" • "));
  }
}

class ComputedTruncatedText implements Component {
  constructor(private readonly getText: () => string | undefined) {}

  render(width: number): string[] {
    const text = this.getText();
    if (!text) {
      return [];
    }

    return new TruncatedText(text).render(width);
  }
}

class TranscriptComponent implements Component {
  private readonly container = new Container();
  private readonly turnComponents = new Map<string, TurnTranscriptComponent>();
  private readonly toolComponents = new Map<string, ToolTranscriptEntryComponent>();
  private readonly emptyState: EmptyTranscriptComponent;
  private keys: string[] = [];

  constructor(
    private readonly theme: NanobossTuiTheme,
    initialState: UiState,
  ) {
    this.emptyState = new EmptyTranscriptComponent(this.theme);
    this.setState(initialState, true);
  }

  setState(state: UiState, forceRefresh = false): void {
    const nextKeys = state.transcriptItems.map(getTranscriptItemKey);
    if (nextKeys.length === 0) {
      this.keys = [];
      this.turnComponents.clear();
      this.toolComponents.clear();
      this.container.clear();
      this.container.addChild(this.emptyState);
      return;
    }

    const turnById = new Map(state.turns.map((turn): [string, UiTurn] => [turn.id, turn]));
    const toolById = new Map(state.toolCalls.map((toolCall): [string, UiToolCall] => [toolCall.id, toolCall]));

    if (forceRefresh || this.requiresStructureRebuild(nextKeys)) {
      this.rebuildStructure(state, turnById, toolById, state.expandedToolOutput);
    } else {
      for (const item of state.transcriptItems.slice(this.keys.length)) {
        const component = this.getOrCreateComponent(item, turnById, toolById, state.expandedToolOutput);
        if (component) {
          this.container.addChild(component);
        }
      }
    }

    for (const item of state.transcriptItems) {
      if (item.type === "turn") {
        const turn = turnById.get(item.id);
        if (!turn) {
          continue;
        }

        const component = this.turnComponents.get(item.id);
        component?.setTurn(turn, forceRefresh);
        continue;
      }

      const toolCall = toolById.get(item.id);
      if (!toolCall) {
        continue;
      }

      const component = this.toolComponents.get(item.id);
      component?.setToolCall(toolCall, state.expandedToolOutput, forceRefresh);
    }

    this.pruneMissingComponents(state.transcriptItems);
    this.keys = nextKeys;
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  invalidate(): void {
    this.container.invalidate();
  }

  private requiresStructureRebuild(nextKeys: string[]): boolean {
    if (this.container.children.length === 1 && this.container.children[0] === this.emptyState) {
      return true;
    }

    if (nextKeys.length < this.keys.length) {
      return true;
    }

    for (let index = 0; index < this.keys.length; index += 1) {
      if (this.keys[index] !== nextKeys[index]) {
        return true;
      }
    }

    return false;
  }

  private rebuildStructure(
    state: UiState,
    turnById: Map<string, UiTurn>,
    toolById: Map<string, UiToolCall>,
    expandedToolOutput: boolean,
  ): void {
    this.container.clear();

    for (const item of state.transcriptItems) {
      const component = this.getOrCreateComponent(item, turnById, toolById, expandedToolOutput);
      if (!component) {
        continue;
      }

      this.container.addChild(component);
    }
  }

  private getOrCreateComponent(
    item: UiTranscriptItem,
    turnById: Map<string, UiTurn>,
    toolById: Map<string, UiToolCall>,
    expandedToolOutput: boolean,
  ): Component | undefined {
    if (item.type === "turn") {
      const turn = turnById.get(item.id);
      if (!turn) {
        return undefined;
      }

      const existing = this.turnComponents.get(item.id);
      if (existing) {
        return existing;
      }

      const component = new TurnTranscriptComponent(this.theme, turn);
      this.turnComponents.set(item.id, component);
      return component;
    }

    const toolCall = toolById.get(item.id);
    if (!toolCall) {
      return undefined;
    }

    const existing = this.toolComponents.get(item.id);
    if (existing) {
      return existing;
    }

    const component = new ToolTranscriptEntryComponent(this.theme, toolCall, expandedToolOutput);
    this.toolComponents.set(item.id, component);
    return component;
  }

  private pruneMissingComponents(items: UiTranscriptItem[]): void {
    const turnIds = new Set(items.filter((item) => item.type === "turn").map((item) => item.id));
    const toolIds = new Set(items.filter((item) => item.type === "tool_call").map((item) => item.id));

    for (const turnId of this.turnComponents.keys()) {
      if (!turnIds.has(turnId)) {
        this.turnComponents.delete(turnId);
      }
    }

    for (const toolId of this.toolComponents.keys()) {
      if (!toolIds.has(toolId)) {
        this.toolComponents.delete(toolId);
      }
    }
  }
}

class EmptyTranscriptComponent implements Component {
  private readonly container = new Container();

  constructor(theme: NanobossTuiTheme) {
    this.container.addChild(new Text(theme.dim("No turns yet. Send a prompt to start.")));
    this.container.addChild(new Spacer(1));
  }

  render(width: number): string[] {
    return this.container.render(width);
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

function getTranscriptItemKey(item: UiTranscriptItem): string {
  return `${item.type}:${item.id}`;
}

function buildActivityBarParts(theme: NanobossTuiTheme, state: UiState): string[] {
  const parts: string[] = [];
  if (state.inputDisabled) {
    parts.push(theme.warning("● busy"));
  }
  if (state.pendingProcedureContinuation) {
    parts.push(theme.warning(`continuation /${state.pendingProcedureContinuation.procedure}`));
  }

  const steeringCount = state.pendingPrompts.filter((prompt) => prompt.kind === "steering").length;
  const queuedCount = state.pendingPrompts.filter((prompt) => prompt.kind === "queued").length;
  if (steeringCount > 0) {
    parts.push(theme.warning(`steer ${steeringCount}`));
  }
  if (queuedCount > 0) {
    parts.push(theme.warning(`queued ${queuedCount}`));
  }

  const selection = state.defaultAgentSelection;
  if (!selection) {
    parts.push(theme.accent(`agent/model ${state.agentLabel || "connecting"}`));
    return parts;
  }

  const modelLabel = getActivityBarModelLabel(state);
  parts.push(
    theme.accent(`agent ${selection.provider}`),
    theme.accent(`model ${modelLabel}`),
  );
  return parts;
}

function getActivityBarModelLabel(state: UiState): string {
  const selection = state.defaultAgentSelection;
  if (!selection) {
    return state.agentLabel || "connecting";
  }

  const prefix = `${selection.provider}/`;
  if (state.agentLabel.startsWith(prefix)) {
    return state.agentLabel.slice(prefix.length) || "default";
  }

  return selection.model || "default";
}

function buildRunTimerLine(state: UiState, nowMs: number): string | undefined {
  if (!state.inputDisabled || state.runStartedAtMs === undefined) {
    return undefined;
  }

  return formatElapsedRunTimer(Math.max(0, nowMs - state.runStartedAtMs));
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
    container.addChild(turn.markdown.length === 0
      ? new Text(theme.dim("…"))
      : new Markdown(turn.markdown, 0, 0, theme.markdown, {
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

function styleStatusLine(theme: NanobossTuiTheme, line: string): string {
  if (line.includes("failed") || line.includes("error") || line.startsWith("[stream]")) {
    return theme.error(line);
  }

  if (line.startsWith("[server]") || line.startsWith("[run]")) {
    return theme.accent(line);
  }

  if (line.startsWith("[build]")) {
    return theme.warning(line);
  }

  return theme.dim(line);
}

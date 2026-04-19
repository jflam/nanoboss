import { Box, Container, Markdown, Spacer, Text, TruncatedText, truncateToWidth, visibleWidth, type Component } from "./pi-tui.ts";
import type { UiState, UiToolCall, UiTranscriptItem, UiTurn } from "./state.ts";
import type { NanobossTuiTheme } from "./theme.ts";

import { MessageCardComponent } from "./components/message-card.ts";
import { ToolCardComponent } from "./components/tool-card.ts";
import { formatCompactTokenUsage, formatElapsedRunTimer, stripModelQualifier } from "./format.ts";

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
    this.container.addChild(new ActivityBarComponent(this.theme, () => this.state, this.nowProvider));
    this.container.addChild(new KeybindingOverlayComponent(this.theme, () => this.state));
    this.container.addChild(new ComputedTruncatedText(() => this.buildFooterLine()));
  }

  setState(state: UiState): void {
    this.state = state;
    this.transcript.setState(this.state);
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  invalidate(): void {
    this.transcript.setState(this.state);
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

  private buildFooterLine(): string {
    if (this.state.liveUpdatesPaused) {
      return this.theme.warning("⏸ updates paused — ctrl+p to resume (native terminal scrollback works while paused)");
    }
    const parts: string[] = [];
    if (this.state.inputDisabled) {
      const pendingCount = this.state.pendingPrompts.length;
      parts.push(
        "esc stop",
        "tab queue",
        pendingCount > 0 ? `${pendingCount} pending` : "run active",
        "ctrl+k keys",
      );
    } else {
      parts.push("ctrl+k keys", "enter send", "/help");
    }
    if (this.state.pendingContinuation) {
      parts.push("/dismiss");
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

  invalidate(): void {}
}

class ActivityBarComponent implements Component {
  constructor(
    private readonly theme: NanobossTuiTheme,
    private readonly getState: () => UiState,
    private readonly nowProvider: () => number,
  ) {}

  render(width: number): string[] {
    const state = this.getState();
    const lines = buildActivityBarLines(this.theme, state, this.nowProvider(), width);
    const out: string[] = [];
    if (lines.length > 0) {
      const firstLine = lines[0]!;
      // After priority-drop, if the line still overflows we fall back to
      // ellipsis truncation with a "…" character (last resort).
      const finalized = visibleWidth(firstLine) > width
        ? truncateToWidth(firstLine, width, "…")
        : firstLine;
      out.push(...new TruncatedText(finalized).render(width));
    }
    for (let i = 1; i < lines.length; i += 1) {
      out.push(...new Text(lines[i]!, 0, 0).render(width));
    }
    return out;
  }

  invalidate(): void {}
}

// Keybinding overlay — non-modal: rendered as a bordered panel between the
// activity bar and the footer when `keybindingOverlayVisible` is true. We
// chose non-modal because the integration is trivial (just a conditional
// component in the existing layout) — it does not need to intercept the
// input listener. Dismissal is handled by the controller on ctrl+k (toggle)
// and esc (explicit dismiss).
class KeybindingOverlayComponent implements Component {
  constructor(
    private readonly theme: NanobossTuiTheme,
    private readonly getState: () => UiState,
  ) {}

  render(width: number): string[] {
    const state = this.getState();
    if (!state.keybindingOverlayVisible) {
      return [];
    }

    const theme = this.theme;
    const lines: string[] = [
      theme.accent("keybindings"),
      `${theme.dim("send/compose:")} ${theme.text("enter send")}  ${theme.text("shift+enter newline")}`,
      `${theme.dim("tools:")} ${theme.text("ctrl+o tools")}`,
      `${theme.dim("run control:")} ${theme.text("ctrl+g auto-approve")}  ${theme.text("ctrl+p pause")}  ${theme.text("ctrl+t tool cards")}  ${theme.text("esc stop")}  ${theme.text("tab queue")}`,
      `${theme.dim("theme:")} ${theme.text("/light")}  ${theme.text("/dark")}`,
      `${theme.dim("commands:")} ${theme.text("/new")}  ${theme.text("/model")}  ${theme.text("/help")}  ${theme.text("/quit")}  ${theme.text("/dismiss")}`,
      `${theme.dim("overlay:")} ${theme.text("ctrl+k keys")}`,
    ];

    const box = new Box(1, 0, theme.toolCardPendingBg);
    for (const line of lines) {
      box.addChild(new TruncatedText(line));
    }
    return box.render(width);
  }

  invalidate(): void {}
}

class TranscriptComponent implements Component {
  private readonly container = new Container();
  private readonly emptyState: EmptyTranscriptComponent;

  constructor(
    private readonly theme: NanobossTuiTheme,
    initialState: UiState,
  ) {
    this.emptyState = new EmptyTranscriptComponent(this.theme);
    this.setState(initialState);
  }

  setState(state: UiState): void {
    this.container.clear();

    if (state.transcriptItems.length === 0) {
      this.container.addChild(this.emptyState);
      return;
    }

    const turnById = new Map(state.turns.map((turn): [string, UiTurn] => [turn.id, turn]));
    const toolById = new Map(state.toolCalls.map((toolCall): [string, UiToolCall] => [toolCall.id, toolCall]));
    for (const item of state.transcriptItems) {
      if (item.type === "tool_call" && state.toolCardsHidden) {
        continue;
      }
      const component = createTranscriptEntryComponent(this.theme, item, turnById, toolById, state.expandedToolOutput);
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

class EmptyTranscriptComponent implements Component {
  private readonly container = new Container();

  constructor(theme: NanobossTuiTheme) {
    this.container.addChild(new Text(theme.dim("No turns yet. Send a prompt to start.")));
    this.container.addChild(new Spacer(1));
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
  expandedToolOutput: boolean,
): Component | undefined {
  if (item.type === "turn") {
    const turn = turnById.get(item.id);
    return turn ? new TurnTranscriptComponent(theme, turn) : undefined;
  }

  const toolCall = toolById.get(item.id);
  return toolCall ? new ToolTranscriptEntryComponent(theme, toolCall, expandedToolOutput) : undefined;
}

function buildActivityBarLines(
  theme: NanobossTuiTheme,
  state: UiState,
  nowMs: number,
  width?: number,
): string[] {
  const separator = theme.dim(" • ");
  const runState = buildRunStateParts(theme, state, nowMs);
  const identityLine = buildIdentityBudgetLineForWidth(theme, state, separator, width);
  const lines: string[] = [identityLine];
  if (runState.length > 0) {
    lines.push(runState.join(separator));
  }
  return lines;
}

interface IdentityBudgetDropLevels {
  includeTokenPercent: boolean;
  includeTokenLimit: boolean;
  includeAgent: boolean;
  includeModelQualifier: boolean;
}

const IDENTITY_BUDGET_DROP_ORDER: IdentityBudgetDropLevels[] = [
  { includeTokenPercent: true, includeTokenLimit: true, includeAgent: true, includeModelQualifier: true },
  { includeTokenPercent: false, includeTokenLimit: true, includeAgent: true, includeModelQualifier: true },
  { includeTokenPercent: false, includeTokenLimit: false, includeAgent: true, includeModelQualifier: true },
  { includeTokenPercent: false, includeTokenLimit: false, includeAgent: false, includeModelQualifier: true },
  { includeTokenPercent: false, includeTokenLimit: false, includeAgent: false, includeModelQualifier: false },
];

function buildIdentityBudgetLineForWidth(
  theme: NanobossTuiTheme,
  state: UiState,
  separator: string,
  width: number | undefined,
): string {
  if (width === undefined || width <= 0) {
    const parts = buildIdentityBudgetParts(theme, state, IDENTITY_BUDGET_DROP_ORDER[0]!);
    return parts.join(separator);
  }
  let lastLine = "";
  for (const levels of IDENTITY_BUDGET_DROP_ORDER) {
    const parts = buildIdentityBudgetParts(theme, state, levels);
    lastLine = parts.join(separator);
    if (visibleWidth(lastLine) <= width) {
      return lastLine;
    }
  }
  return lastLine;
}

function buildIdentityBudgetParts(
  theme: NanobossTuiTheme,
  state: UiState,
  levels: IdentityBudgetDropLevels = IDENTITY_BUDGET_DROP_ORDER[0]!,
): string[] {
  const parts: string[] = [];
  const selection = state.defaultAgentSelection;
  if (!selection) {
    if (levels.includeAgent) {
      parts.push(theme.accent(`@${state.agentLabel || "connecting"}`));
    }
  } else {
    if (levels.includeAgent) {
      parts.push(theme.accent(`@${selection.provider}`));
    }
    const modelLabel = getActivityBarModelLabel(state);
    const effectiveModel = levels.includeModelQualifier ? modelLabel : stripModelQualifier(modelLabel);
    parts.push(theme.accent(effectiveModel));
  }
  const tokenText = buildTokenUsageText(state, {
    includePercent: levels.includeTokenPercent,
    includeLimit: levels.includeTokenLimit,
  });
  if (tokenText) {
    parts.push(theme.success(tokenText));
  }
  return parts;
}

function buildRunStateParts(theme: NanobossTuiTheme, state: UiState, nowMs: number): string[] {
  const parts: string[] = [];
  if (state.simplify2AutoApprove) {
    parts.push(theme.success("approve on"));
  }
  if (state.inputDisabled) {
    parts.push(theme.warning("● busy"));
    const runTimerLine = buildRunTimerLine(state, nowMs);
    if (runTimerLine) {
      parts.push(theme.warning(runTimerLine));
    }
  }
  if (state.activeProcedure) {
    parts.push(theme.warning(`proc /${state.activeProcedure}`));
  }
  if (state.pendingContinuation) {
    parts.push(theme.warning(`cont /${state.pendingContinuation.procedure}`));
  }
  const steeringCount = state.pendingPrompts.filter((prompt) => prompt.kind === "steering").length;
  const queuedCount = state.pendingPrompts.filter((prompt) => prompt.kind === "queued").length;
  if (steeringCount > 0) {
    parts.push(theme.warning(`steer ${steeringCount}`));
  }
  if (queuedCount > 0) {
    parts.push(theme.warning(`queued ${queuedCount}`));
  }
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

function buildTokenUsageText(
  state: UiState,
  options?: { includePercent?: boolean; includeLimit?: boolean },
): string | undefined {
  if (state.tokenUsage) {
    const compact = formatCompactTokenUsage(state.tokenUsage, options);
    if (compact) {
      return compact;
    }
  }
  return state.tokenUsageLine;
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

function styleStatusLine(theme: NanobossTuiTheme, line: string): string {
  if (line.includes("failed") || line.includes("error") || line.startsWith("[stream]")) {
    return theme.error(line);
  }

  if (line.startsWith("[server]") || line.startsWith("[run]")) {
    return theme.accent(line);
  }

  if (line.startsWith("[status]")) {
    return theme.warning(line);
  }

  if (line.startsWith("[build]")) {
    return theme.warning(line);
  }

  return theme.dim(line);
}

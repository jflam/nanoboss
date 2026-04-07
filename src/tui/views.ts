import { Container, Markdown, Spacer, Text, TruncatedText, type Component, type Editor } from "./pi-tui.ts";
import type { UiState, UiTurn } from "./state.ts";
import type { NanobossTuiTheme } from "./theme.ts";

import { ToolCardComponent } from "./components/tool-card.ts";

export class NanobossAppView implements Component {
  private readonly container = new Container();
  private state: UiState;

  constructor(
    private readonly editor: Editor,
    private readonly theme: NanobossTuiTheme,
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
    this.rebuild();
  }

  private rebuild(): void {
    this.container.clear();

    this.container.addChild(new TruncatedText(this.buildHeaderLine()));
    this.container.addChild(new TruncatedText(this.buildSessionLine()));

    if (this.state.statusLine) {
      this.container.addChild(new TruncatedText(styleStatusLine(this.theme, this.state.statusLine)));
    }

    this.container.addChild(new Spacer(1));
    this.appendTranscript();
    this.container.addChild(this.editor);
    this.container.addChild(new Spacer(1));
    this.container.addChild(new TruncatedText(this.buildActivityBarLine()));
    this.container.addChild(new TruncatedText(this.buildFooterLine()));
  }

  private appendTranscript(): void {
    if (this.state.transcriptItems.length === 0) {
      this.container.addChild(new Text(this.theme.dim("No turns yet. Send a prompt to start.")));
      this.container.addChild(new Spacer(1));
      return;
    }

    for (const item of this.state.transcriptItems) {
      if (item.type === "turn") {
        const turn = this.state.turns.find((candidate) => candidate.id === item.id);
        if (!turn) {
          continue;
        }

        this.container.addChild(new TruncatedText(renderTurnLabel(this.theme, turn)));
        this.container.addChild(renderTurnBody(this.theme, turn));
        this.container.addChild(new Spacer(1));
        continue;
      }

      const toolCall = this.state.toolCalls.find((candidate) => candidate.id === item.id);
      if (!toolCall) {
        continue;
      }

      this.container.addChild(new ToolCardComponent(this.theme, toolCall, this.state.expandedToolOutput));
      this.container.addChild(new Spacer(1));
    }
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

  private buildActivityBarLine(): string {
    const separator = this.theme.dim(" • ");
    const parts = buildActivityBarParts(this.theme, this.state);
    if (this.state.tokenUsageLine) {
      parts.push(this.theme.success(this.state.tokenUsageLine));
    }
    return parts.join(separator);
  }

  private buildFooterLine(): string {
    const parts = [
      "enter send",
      "shift+enter newline",
      "ctrl+o tools",
      this.state.expandedToolOutput ? "expanded" : "collapsed",
      "/new",
      "/model",
      `/${this.state.toolCardThemeMode}`,
      this.state.toolCardThemeMode === "dark" ? "/light" : "/dark",
      "/quit",
    ];
    if (this.state.inputDisabled) {
      parts.push("esc stop", "run active (other submit blocked; /quit exits)");
    }
    return this.theme.dim(parts.join(" • "));
  }
}

function buildActivityBarParts(theme: NanobossTuiTheme, state: UiState): string[] {
  const parts: string[] = [];
  if (state.inputDisabled) {
    parts.push(theme.warning("● busy"));
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
    const container = new Container();
    container.addChild(turn.markdown.length === 0
      ? new Text(theme.dim("…"))
      : new Markdown(turn.markdown, 0, 0, theme.markdown, {
          color: theme.text,
        }));

    if (turn.meta?.failureMessage) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.error(`Error: ${turn.meta.failureMessage}`), 0, 0));
    }

    if (turn.meta?.completionNote) {
      container.addChild(new Text(theme.dim(turn.meta.completionNote), 0, 0));
    }

    return container;
  }

  if (turn.role === "system") {
    return new Text(turn.status === "failed" ? theme.error(turn.markdown) : theme.warning(turn.markdown));
  }

  return new Text(turn.markdown);
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

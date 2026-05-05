import { Box, Container, Text, type Component } from "../shared/pi-tui.ts";
import type { UiToolCall } from "../state/state.ts";
import type { NanobossTuiTheme } from "../theme/theme.ts";

import { renderToolCard } from "./tool-renderers/index.ts";

export class ToolCardComponent implements Component {
  private readonly container = new Container();

  constructor(
    private readonly theme: NanobossTuiTheme,
    private readonly toolCall: UiToolCall,
    private readonly expanded: boolean,
  ) {
    this.rebuild();
  }

  invalidate(): void {
    this.container.invalidate();
    this.rebuild();
  }

  render(width: number): string[] {
    const indent = "  ".repeat(this.toolCall.depth);
    const innerWidth = Math.max(12, width - indent.length);
    return this.container.render(innerWidth).map((line) => `${indent}${line}`);
  }

  private rebuild(): void {
    this.container.clear();

    const formatted = renderToolCard(this.theme, this.toolCall, this.expanded);
    const lines = [...formatted.lines];
    if (this.toolCall.status === "failed" && lines.length > 0) {
      lines[0] = `${this.theme.toolCardError("●")} ${lines[0]}`;
    }
    const box = new Box(1, 1, backgroundForStatus(this.theme, this.toolCall.status));
    box.addChild(new Text(lines.join("\n"), 0, 0));
    this.container.addChild(box);
  }
}

function backgroundForStatus(theme: NanobossTuiTheme, status: string): (text: string) => string {
  if (status === "failed" || status === "cancelled") {
    return theme.toolCardErrorBg;
  }

  if (status === "completed") {
    return theme.toolCardSuccessBg;
  }

  return theme.toolCardPendingBg;
}

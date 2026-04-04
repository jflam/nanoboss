import { Container, Text, type Component } from "../pi-tui.ts";
import type { UiToolCall } from "../state.ts";
import type { NanobossTuiTheme } from "../theme.ts";

import { formatToolCard } from "./tool-card-format.ts";

export class ToolCardComponent implements Component {
  private readonly container = new Container();

  constructor(
    private readonly theme: NanobossTuiTheme,
    private readonly toolCall: UiToolCall,
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

    const formatted = formatToolCard(this.toolCall);
    const body = new Text([
      `${statusGlyph(this.theme, this.toolCall.status)} ${this.theme.toolCardTitle(formatted.title)}`,
      this.theme.toolCardMeta(formatted.metaLine),
      ...formatted.sections.map((section) => this.theme.toolCardBody(`${section.label}: ${section.value}`)),
    ].join("\n"), 0, 0);

    this.container.addChild({
      render: (width) => renderBorderedCard(this.theme, body.render(Math.max(8, width - 4))),
      invalidate: () => body.invalidate(),
    });
  }
}

function renderBorderedCard(theme: NanobossTuiTheme, contentLines: string[]): string[] {
  if (contentLines.length === 0) {
    return [];
  }

  const visibleWidth = contentLines[0]?.replace(/\x1b\[[0-9;]*m/g, "").length ?? 0;
  const horizontal = theme.toolCardBorder(`┌${"─".repeat(Math.max(0, visibleWidth + 2))}┐`);
  const footer = theme.toolCardBorder(`└${"─".repeat(Math.max(0, visibleWidth + 2))}┘`);

  return [
    horizontal,
    ...contentLines.map((line) => `${theme.toolCardBorder("│")} ${line} ${theme.toolCardBorder("│")}`),
    footer,
  ];
}

function statusGlyph(theme: NanobossTuiTheme, status: string): string {
  if (status === "failed" || status === "cancelled") {
    return theme.error("●");
  }

  if (status === "completed") {
    return theme.success("●");
  }

  return theme.warning("●");
}

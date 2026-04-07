import { Box, Container, Text, type Component } from "../pi-tui.ts";
import type { NanobossTuiTheme } from "../theme.ts";
import type { UiTurn } from "../state.ts";

type MessageCardTone = NonNullable<UiTurn["cardTone"]>;

export class MessageCardComponent implements Component {
  private readonly container = new Container();

  constructor(
    private readonly theme: NanobossTuiTheme,
    private readonly lines: string[],
    private readonly tone: MessageCardTone,
  ) {
    this.rebuild();
  }

  invalidate(): void {
    this.container.invalidate();
    this.rebuild();
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  private rebuild(): void {
    this.container.clear();

    const box = new Box(1, 1, backgroundForTone(this.theme, this.tone));
    box.addChild(new Text(this.lines.map((line) => styleLine(this.theme, this.tone, line)).join("\n"), 0, 0));
    this.container.addChild(box);
  }
}

function backgroundForTone(theme: NanobossTuiTheme, tone: MessageCardTone): (text: string) => string {
  if (tone === "error") {
    return theme.toolCardErrorBg;
  }

  if (tone === "success") {
    return theme.toolCardSuccessBg;
  }

  return theme.toolCardPendingBg;
}

function styleLine(theme: NanobossTuiTheme, tone: MessageCardTone, line: string): string {
  switch (tone) {
    case "error":
      return theme.toolCardError(line);
    case "success":
      return theme.toolCardSuccess(line);
    case "warning":
      return theme.toolCardWarning(line);
    case "info":
      return theme.toolCardBody(line);
  }
}

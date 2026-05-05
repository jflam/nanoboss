import { Box, Container, Markdown, type Component } from "../shared/pi-tui.ts";
import type { NanobossTuiTheme } from "../theme/theme.ts";
import type { UiTurn } from "../state/state.ts";

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
    box.addChild(new Markdown(this.lines.join("\n"), 0, 0, this.theme.markdown, {
      color: colorForTone(this.theme, this.tone),
    }));
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

function colorForTone(theme: NanobossTuiTheme, tone: MessageCardTone): (text: string) => string {
  switch (tone) {
    case "error":
      return theme.toolCardError;
    case "success":
      return theme.toolCardSuccess;
    case "warning":
      return theme.toolCardWarning;
    case "info":
      return theme.toolCardBody;
  }
}

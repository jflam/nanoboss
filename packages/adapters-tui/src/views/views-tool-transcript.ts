import { Container, Spacer, type Component } from "../shared/pi-tui.ts";
import type { UiToolCall } from "../state/state.ts";
import type { NanobossTuiTheme } from "../theme/theme.ts";
import { ToolCardComponent } from "../components/tool-card.ts";

export class ToolTranscriptEntryComponent implements Component {
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

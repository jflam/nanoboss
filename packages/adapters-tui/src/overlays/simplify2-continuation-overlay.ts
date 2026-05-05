import { Container, Spacer, Text, type Component, type TUI } from "../shared/pi-tui.ts";
import type { NanobossTuiTheme } from "../theme/theme.ts";

export interface Simplify2CheckpointAction {
  id: "approve" | "stop" | "focus_tests" | "other";
  label: string;
  reply?: string;
  description?: string;
}

export class Simplify2ContinuationOverlay implements Component {
  private readonly container = new Container();

  constructor(
    private readonly tui: TUI,
    private readonly theme: NanobossTuiTheme,
    private readonly title: string,
    private readonly actions: Simplify2CheckpointAction[],
    private readonly done: (action: Simplify2CheckpointAction | undefined) => void,
  ) {
    this.container.addChild(new Text(this.theme.accent(this.title)));
    this.container.addChild(new Spacer(1));

    for (const [index, action] of this.actions.entries()) {
      this.container.addChild(new Text(`${index + 1}. ${action.label}`));
      if (action.description) {
        this.container.addChild(new Text(this.theme.dim(`   ${action.description}`)));
      }
    }

    this.container.addChild(new Spacer(1));
    this.container.addChild(new Text(this.theme.dim("Press 1-4 to choose • esc cancel")));
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  invalidate(): void {
    this.container.invalidate();
  }

  handleInput(data: string): void {
    if (data === "\u001b") {
      this.done(undefined);
      this.tui.requestRender(true);
      return;
    }

    const index = Number.parseInt(data, 10);
    if (!Number.isInteger(index) || index < 1 || index > this.actions.length) {
      return;
    }

    const action = this.actions[index - 1];
    if (!action) {
      return;
    }

    this.done(action);
    this.tui.requestRender(true);
  }
}

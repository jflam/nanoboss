import { Container, Spacer, TruncatedText, type Component } from "../shared/pi-tui.ts";
import type { UiTurn } from "../state/state.ts";
import type { NanobossTuiTheme } from "../theme/theme.ts";
import {
  renderTurnBody,
  renderTurnLabel,
} from "./views-turn-rendering.ts";

export class TurnTranscriptComponent implements Component {
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

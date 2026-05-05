import { buildActivityBarLine } from "./activity-bar.ts";
import {
  Text,
  TruncatedText,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "../shared/pi-tui.ts";
import type { UiState } from "../state/state.ts";
import type { NanobossTuiTheme } from "../theme/theme.ts";

class ActivityBarComponent implements Component {
  constructor(
    private readonly theme: NanobossTuiTheme,
    private readonly getState: () => UiState,
    private readonly getNowMs: () => number,
  ) {}

  render(width: number): string[] {
    const state = this.getState();
    const separator = this.theme.dim(" • ");
    const identityLine = buildActivityBarLine(
      "identity",
      state,
      this.theme,
      this.getNowMs(),
      separator,
      width,
    );
    const runStateLine = buildActivityBarLine(
      "runState",
      state,
      this.theme,
      this.getNowMs(),
      separator,
      undefined,
    );

    const out: string[] = [];
    if (identityLine !== undefined && identityLine.length > 0) {
      // After priority-drop, if the line still overflows we fall back to
      // ellipsis truncation with a "…" character (last resort).
      const finalized = visibleWidth(identityLine) > width
        ? truncateToWidth(identityLine, width, "…")
        : identityLine;
      out.push(...new TruncatedText(finalized).render(width));
    }
    if (runStateLine !== undefined && runStateLine.length > 0) {
      out.push(...new Text(runStateLine, 0, 0).render(width));
    }
    return out;
  }

  invalidate(): void {}
}

export function createActivityBarComponent(
  theme: NanobossTuiTheme,
  getState: () => UiState,
  getNowMs: () => number,
): Component {
  return new ActivityBarComponent(theme, getState, getNowMs);
}

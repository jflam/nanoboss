import {
  TruncatedText,
  type Component,
} from "../shared/pi-tui.ts";
import type { UiState } from "../state/state.ts";
import type { NanobossTuiTheme } from "../theme/theme.ts";
import {
  buildFooterLine,
  buildHeaderLines,
  buildSessionLine,
  buildStatusLine,
} from "./core-chrome-lines.ts";

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

class ComputedTruncatedLines implements Component {
  constructor(private readonly getLines: () => string[]) {}

  render(width: number): string[] {
    const out: string[] = [];
    for (const line of this.getLines()) {
      if (line.length === 0) continue;
      out.push(...new TruncatedText(line).render(width));
    }
    return out;
  }

  invalidate(): void {}
}

export function createHeaderComponent(
  theme: NanobossTuiTheme,
  getState: () => UiState,
): Component {
  return new ComputedTruncatedLines(() => buildHeaderLines(theme, getState()));
}

export function createSessionComponent(
  theme: NanobossTuiTheme,
  getState: () => UiState,
): Component {
  return new ComputedTruncatedText(() => buildSessionLine(theme, getState()));
}

export function createStatusComponent(
  theme: NanobossTuiTheme,
  getState: () => UiState,
): Component {
  return new ComputedTruncatedText(() => buildStatusLine(theme, getState()));
}

export function createFooterComponent(
  theme: NanobossTuiTheme,
  getState: () => UiState,
): Component {
  return new ComputedTruncatedText(() => buildFooterLine(theme, getState()));
}

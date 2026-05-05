import {
  TruncatedText,
  type Component,
} from "./pi-tui.ts";
import type { UiState } from "./state.ts";
import type { NanobossTuiTheme } from "./theme.ts";

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

// Width for caption column so that "build", "cwd", and "session" align.
const IDENTITY_CAPTION_WIDTH = 9;

function formatIdentityRow(theme: NanobossTuiTheme, caption: string, value: string, valueStyle: (text: string) => string): string {
  const paddedCaption = `${caption}:`.padEnd(IDENTITY_CAPTION_WIDTH, " ");
  return `${theme.dim(paddedCaption)}${valueStyle(value)}`;
}

function buildHeaderLines(theme: NanobossTuiTheme, state: UiState): string[] {
  const cwd = state.cwd || process.cwd();
  return [
    formatIdentityRow(theme, "build", state.buildLabel, theme.accent),
    formatIdentityRow(theme, "cwd", cwd, theme.accent),
  ];
}

function buildSessionLine(theme: NanobossTuiTheme, state: UiState): string {
  if (!state.sessionId) {
    return formatIdentityRow(theme, "session", "connecting to nanoboss…", theme.dim);
  }
  return formatIdentityRow(theme, "session", state.sessionId.slice(0, 8), theme.accent);
}

function buildStatusLine(theme: NanobossTuiTheme, state: UiState): string | undefined {
  if (!state.statusLine) {
    return undefined;
  }
  return styleStatusLine(theme, state.statusLine);
}

function buildFooterLine(theme: NanobossTuiTheme, state: UiState): string {
  if (state.liveUpdatesPaused) {
    return theme.warning("⏸ updates paused — ctrl+p to resume (native terminal scrollback works while paused)");
  }
  const parts: string[] = [];
  if (state.inputDisabled) {
    if (state.inputDisabledReason === "local") {
      parts.push("busy", "please wait", "ctrl+h keys");
    } else {
      const pendingCount = state.pendingPrompts.length;
      parts.push(
        "esc stop",
        "tab queue",
        pendingCount > 0 ? `${pendingCount} pending` : "run active",
        "ctrl+h keys",
      );
    }
  } else {
    parts.push("ctrl+h keys", "enter send", "/help");
  }
  if (state.pendingContinuation) {
    parts.push("/dismiss");
  }
  return theme.dim(parts.join(" • "));
}

function styleStatusLine(theme: NanobossTuiTheme, line: string): string {
  if (line.includes("failed") || line.includes("error") || line.startsWith("[stream]")) {
    return theme.error(line);
  }
  if (line.startsWith("[server]") || line.startsWith("[run]")) {
    return theme.accent(line);
  }
  if (line.startsWith("[status]")) {
    return theme.warning(line);
  }
  if (line.startsWith("[build]")) {
    return theme.warning(line);
  }
  return theme.dim(line);
}

import {
  Box,
  Container,
  Spacer,
  Text,
  TruncatedText,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "./pi-tui.ts";
import type { UiState } from "./state.ts";
import type { NanobossTuiTheme } from "./theme.ts";
import { registerChromeContribution } from "./chrome.ts";
import { buildActivityBarLine } from "./activity-bar.ts";
import { listKeyBindings, type KeyBindingCategory } from "./bindings.ts";

/**
 * Core chrome contributions shipped with @nanoboss/adapters-tui. Registered
 * for side effects when this module is imported. Each contribution is a
 * thin wrapper around the lines and components previously hard-wired into
 * NanobossAppView.
 *
 * The composer slot is intentionally NOT registered here: it is owned per
 * NanobossAppView instance (so that the editor can be swapped for inline
 * overlays via showComposer/showEditor without touching the global
 * registry).
 */

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

// Keybinding overlay — non-modal: rendered as a bordered panel between the
// activity bar and the footer when `keybindingOverlayVisible` is true. We
// chose non-modal because the integration is trivial (just a conditional
// component in the existing layout) — it does not need to intercept the
// input listener. Dismissal is handled by the controller on ctrl+k (toggle)
// and esc (explicit dismiss).
class KeybindingOverlayComponent implements Component {
  constructor(
    private readonly theme: NanobossTuiTheme,
    private readonly getState: () => UiState,
  ) {}

  render(width: number): string[] {
    const state = this.getState();
    if (!state.keybindingOverlayVisible) {
      return [];
    }

    const theme = this.theme;
    const lines: string[] = [theme.accent("keybindings")];

    // Overlay groups mirror the user-visible categories. "custom" is
    // intentionally excluded here; user-authored custom bindings can opt
    // into a future overlay slot, but today the overlay documents only
    // the built-in keyboard surface.
    const displayGroups: { category: KeyBindingCategory; label: string }[] = [
      { category: "compose", label: "send/compose" },
      { category: "tools", label: "tools" },
      { category: "run", label: "run control" },
      { category: "theme", label: "theme" },
      { category: "commands", label: "commands" },
      { category: "overlay", label: "overlay" },
    ];

    const allBindings = listKeyBindings();
    for (const group of displayGroups) {
      const groupBindings = allBindings.filter((binding) => binding.category === group.category);
      if (groupBindings.length === 0) {
        continue;
      }
      const labels = groupBindings.map((binding) => theme.text(binding.label)).join("  ");
      lines.push(`${theme.dim(`${group.label}:`)} ${labels}`);
    }

    const box = new Box(1, 0, theme.toolCardPendingBg);
    for (const line of lines) {
      box.addChild(new TruncatedText(line));
    }
    return box.render(width);
  }

  invalidate(): void {}
}

function buildHeaderLine(theme: NanobossTuiTheme, state: UiState): string {
  const cwd = state.cwd || process.cwd();
  return theme.accent(`${state.buildLabel} • ${cwd}`);
}

function buildSessionLine(theme: NanobossTuiTheme, state: UiState): string {
  if (!state.sessionId) {
    return theme.dim("Connecting to nanoboss…");
  }
  return theme.dim(`session ${state.sessionId.slice(0, 8)} • retained transcript + pi-tui editor`);
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
    const pendingCount = state.pendingPrompts.length;
    parts.push(
      "esc stop",
      "tab queue",
      pendingCount > 0 ? `${pendingCount} pending` : "run active",
      "ctrl+k keys",
    );
  } else {
    parts.push("ctrl+k keys", "enter send", "/help");
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

registerChromeContribution({
  id: "core.header",
  slot: "header",
  order: 0,
  render: ({ getState, theme }) => new ComputedTruncatedText(() => buildHeaderLine(theme, getState())),
});

registerChromeContribution({
  id: "core.session",
  slot: "session",
  order: 0,
  render: ({ getState, theme }) => new ComputedTruncatedText(() => buildSessionLine(theme, getState())),
});

registerChromeContribution({
  id: "core.status",
  slot: "status",
  order: 0,
  render: ({ getState, theme }) => new ComputedTruncatedText(() => buildStatusLine(theme, getState())),
});

registerChromeContribution({
  id: "core.transcriptAbove.spacer",
  slot: "transcriptAbove",
  order: 0,
  render: () => new Spacer(1),
});

registerChromeContribution({
  id: "core.composerBelow.spacer",
  slot: "composerBelow",
  order: 0,
  render: () => new Spacer(1),
});

registerChromeContribution({
  id: "core.activityBar",
  slot: "activityBar",
  order: 0,
  render: ({ getState, getNowMs, theme }) => new ActivityBarComponent(theme, getState, getNowMs),
});

registerChromeContribution({
  id: "core.overlay.keybindings",
  slot: "overlay",
  order: 0,
  render: ({ getState, theme }) => new KeybindingOverlayComponent(theme, getState),
});

registerChromeContribution({
  id: "core.footer",
  slot: "footer",
  order: 0,
  render: ({ getState, theme }) => new ComputedTruncatedText(() => buildFooterLine(theme, getState())),
});

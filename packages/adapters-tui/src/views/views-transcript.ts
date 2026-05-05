import { Container, type Component } from "../shared/pi-tui.ts";
import type { UiState } from "../state/state.ts";
import type { NanobossTuiTheme } from "../theme/theme.ts";
import { registerChromeContribution } from "../core/chrome.ts";
import { createTranscriptEntryComponents } from "./views-transcript-entries.ts";

/**
 * Transcript component used by the core "transcript" chrome contribution.
 * Keeps its own children in sync with state.transcriptItems via setState,
 * matching the pre-migration incremental rebuild behavior.
 */
class TranscriptComponent implements Component {
  private readonly container = new Container();

  constructor(
    private readonly theme: NanobossTuiTheme,
    initialState: UiState,
  ) {
    this.setState(initialState);
  }

  setState(state: UiState): void {
    this.container.clear();

    for (const component of createTranscriptEntryComponents(this.theme, state)) {
      this.container.addChild(component);
    }
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  invalidate(): void {
    this.container.invalidate();
  }
}

registerChromeContribution({
  id: "core.transcript",
  slot: "transcript",
  order: 0,
  render: ({ getState, theme }) => new TranscriptComponent(theme, getState()),
});

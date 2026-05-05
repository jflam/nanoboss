import { Container, type Component } from "../shared/pi-tui.ts";
import type { UiState } from "../state/state.ts";
import type { NanobossTuiTheme } from "../theme/theme.ts";
import {
  getChromeContributions,
  type ChromeRenderContext,
  type ChromeSlotId,
} from "../core/chrome.ts";
import {
  mountChromeContribution,
  type StatefulChromeChild,
} from "./views-chrome-mount.ts";

// Side-effect imports: register every core chrome contribution and
// activity-bar segment into the module-level registries before any
// NanobossAppView instance iterates them.
import "../core/core-chrome.ts";
import "../core/core-activity-bar.ts";
import "../core/core-system-panels.ts";
import "./views-transcript.ts";
import "./views-panels.ts";

/**
 * Ordered list of chrome slots rendered by NanobossAppView. The composer
 * slot is rendered by the view itself (using the per-instance editor /
 * overlay composer); every other slot is driven by the registered
 * contributions in chrome.ts.
 */
const SLOT_ORDER: ChromeSlotId[] = [
  "header",
  "session",
  "status",
  "transcriptAbove",
  "transcript",
  "transcriptBelow",
  "composerAbove",
  "composer",
  "composerBelow",
  "activityBar",
  "overlay",
  "footer",
];

export class NanobossAppView implements Component {
  private readonly container = new Container();
  private readonly composerContainer = new Container();
  private readonly statefulChildren: StatefulChromeChild[] = [];
  private state: UiState;

  constructor(
    private readonly editor: Component,
    private readonly theme: NanobossTuiTheme,
    initialState: UiState,
    private readonly nowProvider: () => number = Date.now,
  ) {
    this.state = initialState;
    this.composerContainer.addChild(this.editor);

    const ctx: ChromeRenderContext = {
      state: this.state,
      theme: this.theme,
      getState: () => this.state,
      getNowMs: () => this.nowProvider(),
    };

    for (const slot of SLOT_ORDER) {
      if (slot === "composer") {
        this.container.addChild(this.composerContainer);
        continue;
      }
      for (const contribution of getChromeContributions(slot)) {
        mountChromeContribution({
          container: this.container,
          contribution,
          ctx,
          getState: () => this.state,
          statefulChildren: this.statefulChildren,
        });
      }
    }

    // Give every stateful child the initial state snapshot so their
    // internal layout matches the constructor-time state exactly (this
    // mirrors the pre-migration behavior where TranscriptComponent was
    // seeded with the initial state during construction).
    for (const child of this.statefulChildren) {
      child.setState(this.state);
    }
  }

  setState(state: UiState): void {
    this.state = state;
    for (const child of this.statefulChildren) {
      child.setState(state);
    }
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  invalidate(): void {
    for (const child of this.statefulChildren) {
      child.setState(this.state);
    }
    this.container.invalidate();
  }

  showComposer(component: Component): void {
    this.composerContainer.clear();
    this.composerContainer.addChild(component);
    this.container.invalidate();
  }

  showEditor(): void {
    this.showComposer(this.editor);
  }
}

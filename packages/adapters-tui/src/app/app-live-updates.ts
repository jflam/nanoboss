import type { UiState } from "../state/state.ts";

interface LiveUpdatesTui {
  requestRender(force?: boolean): void;
}

interface LiveUpdatesView {
  setState(state: UiState): void;
}

export class AppLiveUpdates {
  private paused = false;
  private refreshInterval?: ReturnType<typeof setInterval>;

  constructor(
    private readonly deps: {
      tui: LiveUpdatesTui;
      view: LiveUpdatesView;
      getState: () => UiState;
      setState: (state: UiState) => void;
      isStopped: () => boolean;
      setInterval: typeof globalThis.setInterval;
      clearInterval: typeof globalThis.clearInterval;
    },
  ) {}

  withPauseState(state: UiState): UiState {
    return { ...state, liveUpdatesPaused: this.paused };
  }

  requestRender(force?: boolean): void {
    if (this.paused) {
      if (!force) {
        return;
      }
      // A forced render (e.g. user-triggered overlay/composer change) implicitly
      // resumes live updates so the user can see the UI change they just requested.
      this.setPaused(false);
      return;
    }
    this.deps.tui.requestRender(force);
  }

  togglePaused(): void {
    this.setPaused(!this.paused);
  }

  start(): void {
    if (this.refreshInterval) {
      return;
    }

    this.refreshInterval = this.deps.setInterval(() => {
      const state = this.deps.getState();
      if (this.deps.isStopped() || !state.inputDisabled || state.runStartedAtMs === undefined) {
        return;
      }

      this.requestRender();
    }, 1_000);
  }

  stop(): void {
    if (!this.refreshInterval) {
      return;
    }

    this.deps.clearInterval(this.refreshInterval);
    this.refreshInterval = undefined;
  }

  private setPaused(paused: boolean): void {
    if (this.paused === paused) {
      return;
    }
    this.paused = paused;
    const state = this.withPauseState(this.deps.getState());
    this.deps.setState(state);
    this.deps.view.setState(state);
    // Force a single render on every transition: entering pause draws the
    // indicator; leaving pause flushes all updates accumulated while paused.
    this.deps.tui.requestRender(true);
  }
}

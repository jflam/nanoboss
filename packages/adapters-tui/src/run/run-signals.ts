import type { TuiExitSignal } from "./run-terminal.ts";

interface TuiSignalApp {
  requestExit?(): void;
  requestSigintExit?(): boolean;
}

interface TuiSignalHandlerOptions {
  addSignalListener: (signal: TuiExitSignal, listener: () => void) => () => void;
  getApp: () => TuiSignalApp | undefined;
  now: () => number;
  onExitSignal: (signal: TuiExitSignal) => void;
}

const CTRL_C_EXIT_WINDOW_MS = 500;

export function installTuiExitSignalHandlers(options: TuiSignalHandlerOptions): Array<() => void> {
  let lastSigintAt = Number.NEGATIVE_INFINITY;

  return [
    options.addSignalListener("SIGINT", () => {
      const app = options.getApp();
      const appHandled = app?.requestSigintExit?.();
      if (appHandled) {
        options.onExitSignal("SIGINT");
        return;
      }

      const now = options.now();
      if (now - lastSigintAt < CTRL_C_EXIT_WINDOW_MS) {
        options.onExitSignal("SIGINT");
        app?.requestExit?.();
        return;
      }

      lastSigintAt = now;
    }),
    options.addSignalListener("SIGTERM", () => {
      options.onExitSignal("SIGTERM");
      options.getApp()?.requestExit?.();
    }),
  ];
}

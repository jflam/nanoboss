import type {
  ControllerLike,
  TerminalLike,
  TuiLike,
} from "./app-types.ts";
import type { AppLiveUpdates } from "./app-live-updates.ts";

export async function runAppLifecycle(params: {
  tui: TuiLike;
  terminal: TerminalLike;
  liveUpdates: AppLiveUpdates;
  controller: ControllerLike;
  stop: () => Promise<void>;
}): Promise<string | undefined> {
  params.tui.start();
  params.terminal.setTitle("nanoboss");
  params.tui.requestRender(true);
  params.liveUpdates.start();

  try {
    return await params.controller.run();
  } finally {
    await params.stop();
  }
}

export async function stopAppLifecycle(params: {
  stopped: boolean;
  setStopped: (stopped: boolean) => void;
  liveUpdates: AppLiveUpdates;
  controller: ControllerLike;
  terminal: TerminalLike;
  tui: TuiLike;
}): Promise<void> {
  if (params.stopped) {
    return;
  }

  params.setStopped(true);
  params.liveUpdates.stop();
  await params.controller.stop();

  try {
    await params.terminal.drainInput(100, 20);
  } catch {
    // Ignore drain failures during shutdown.
  }

  params.tui.stop();
}

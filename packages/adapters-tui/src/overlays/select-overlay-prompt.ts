import { ProcessTerminal, TUI } from "../shared/pi-tui.ts";
import type { NanobossTuiTheme } from "../theme/theme.ts";
import {
  SelectOverlay,
  type SelectOverlayOptions,
} from "./select-overlay.ts";

export async function promptWithSelectList<T extends string>(
  theme: NanobossTuiTheme,
  options: SelectOverlayOptions<T>,
): Promise<T | undefined> {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, true);

  try {
    const resultPromise = new Promise<T | undefined>((resolve) => {
      const component = new SelectOverlay<T>(tui, theme, options, resolve);
      tui.addChild(component);
      tui.setFocus(component);
    });

    tui.start();
    tui.requestRender(true);
    return await resultPromise;
  } finally {
    try {
      await terminal.drainInput(100, 20);
    } catch {
      // Ignore drain failures during shutdown.
    }
    tui.stop();
  }
}

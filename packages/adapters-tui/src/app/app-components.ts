import { createClipboardImageProvider, type ClipboardImageProvider } from "../clipboard/provider.ts";
import {
  Editor,
  ProcessTerminal,
  TUI,
} from "../shared/pi-tui.ts";
import type {
  EditorLike,
  NanobossTuiAppDeps,
  TerminalLike,
  TuiLike,
  ViewLike,
} from "./app-types.ts";
import type { UiState } from "../state/state.ts";
import { createNanobossTuiTheme, type NanobossTuiTheme } from "../theme/theme.ts";
import { NanobossAppView } from "../views/views.ts";

interface AppCoreComponents {
  theme: NanobossTuiTheme;
  terminal: TerminalLike;
  tui: TuiLike;
  editor: EditorLike;
  clipboardImageProvider: ClipboardImageProvider;
}

export function createAppCoreComponents(
  deps: NanobossTuiAppDeps,
): AppCoreComponents {
  const theme = deps.createTheme?.() ?? createNanobossTuiTheme();
  const terminal = deps.createTerminal?.() ?? new ProcessTerminal();
  const tui = deps.createTui?.(terminal) ?? new TUI(terminal as ProcessTerminal, false);
  const editor = deps.createEditor?.(tui, theme)
    ?? new Editor(tui as TUI, theme.editor, {
      paddingX: 1,
      autocompleteMaxVisible: 8,
    });
  const clipboardImageProvider = deps.createClipboardImageProvider?.()
    ?? createClipboardImageProvider();

  return {
    theme,
    terminal,
    tui,
    editor,
    clipboardImageProvider,
  };
}

export function createAppView(params: {
  deps: NanobossTuiAppDeps;
  editor: EditorLike;
  theme: NanobossTuiTheme;
  state: UiState;
}): ViewLike {
  return params.deps.createView?.(params.editor, params.theme, params.state)
    ?? new NanobossAppView(params.editor as Editor, params.theme, params.state);
}

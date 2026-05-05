import { createAppView } from "./app-components.ts";
import { AppModelPrompts } from "./app-model-prompts.ts";
import {
  createAppRuntimeHelpers,
  type AppRuntimeHelpers,
} from "./app-runtime-helpers.ts";
import type { SelectOverlayOptions } from "./overlays/select-overlay.ts";
import type { NanobossTuiTheme } from "./theme.ts";
import type { UiState } from "./state.ts";
import type {
  ControllerLike,
  EditorLike,
  NanobossTuiAppDeps,
  TuiLike,
  ViewLike,
} from "./app-types.ts";

interface AppRuntimeWiringOptions {
  deps: NanobossTuiAppDeps;
  cwd: string;
  tui: TuiLike;
  editor: EditorLike;
  controller: ControllerLike;
  theme: NanobossTuiTheme;
  state: UiState;
  getState: () => UiState;
  setState: (state: UiState) => void;
  isStopped: () => boolean;
  now: () => number;
  requestRender: (force?: boolean) => void;
  promptWithInlineSelect: <T extends string>(
    options: SelectOverlayOptions<T>,
  ) => Promise<T | undefined>;
}

interface AppRuntimeWiring {
  view: ViewLike;
  helpers: AppRuntimeHelpers;
  modelPrompts: AppModelPrompts;
}

export function createAppRuntimeWiring(options: AppRuntimeWiringOptions): AppRuntimeWiring {
  const view = createAppView({
    deps: options.deps,
    editor: options.editor,
    theme: options.theme,
    state: options.state,
  });

  const helpers = createAppRuntimeHelpers({
    deps: options.deps,
    cwd: options.cwd,
    tui: options.tui,
    view,
    editor: options.editor,
    controller: options.controller,
    theme: options.theme,
    getState: options.getState,
    setState: options.setState,
    isStopped: options.isStopped,
    now: options.now,
    requestRender: options.requestRender,
  });

  const modelPrompts = new AppModelPrompts({
    cwd: options.cwd,
    deps: options.deps,
    controller: options.controller,
    promptWithInlineSelect: options.promptWithInlineSelect,
  });

  return {
    view,
    helpers,
    modelPrompts,
  };
}

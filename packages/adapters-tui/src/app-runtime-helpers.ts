import { AppAutocompleteSync } from "./app-autocomplete.ts";
import { AppContinuationComposer } from "./app-continuation-composer.ts";
import { AppLiveUpdates } from "./app-live-updates.ts";
import { AppSigintExit } from "./app-sigint-exit.ts";
import type {
  ControllerLike,
  EditorLike,
  NanobossTuiAppDeps,
  TuiLike,
  ViewLike,
} from "./app-types.ts";
import type { UiState } from "./state.ts";
import type { NanobossTuiTheme } from "./theme.ts";

export interface AppRuntimeHelpers {
  autocomplete: AppAutocompleteSync;
  sigintExit: AppSigintExit;
  continuationComposer: AppContinuationComposer;
  liveUpdates: AppLiveUpdates;
}

export function createAppRuntimeHelpers(params: {
  deps: NanobossTuiAppDeps;
  cwd: string;
  tui: TuiLike;
  view: ViewLike;
  editor: EditorLike;
  controller: ControllerLike;
  theme: NanobossTuiTheme;
  now: () => number;
  getState: () => UiState;
  setState: (state: UiState) => void;
  isStopped: () => boolean;
  requestRender: (force?: boolean) => void;
}): AppRuntimeHelpers {
  const autocomplete = new AppAutocompleteSync({
    editor: params.editor,
    cwd: params.cwd,
  });
  const sigintExit = new AppSigintExit({
    controller: params.controller,
    editor: params.editor,
    now: params.now,
    exitWindowMs: 500,
  });
  const continuationComposer = new AppContinuationComposer({
    tui: params.tui,
    view: params.view,
    editor: params.editor,
    controller: params.controller,
    theme: params.theme,
    getState: params.getState,
    requestRender: params.requestRender,
  });
  const liveUpdates = new AppLiveUpdates({
    tui: params.tui,
    view: params.view,
    getState: params.getState,
    setState: params.setState,
    isStopped: params.isStopped,
    setInterval: params.deps.setInterval ?? globalThis.setInterval,
    clearInterval: params.deps.clearInterval ?? globalThis.clearInterval,
  });

  return {
    autocomplete,
    sigintExit,
    continuationComposer,
    liveUpdates,
  };
}

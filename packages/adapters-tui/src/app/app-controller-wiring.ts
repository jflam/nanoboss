import type { DownstreamAgentSelection } from "@nanoboss/contracts";
import { writePersistedDefaultAgentSelection } from "@nanoboss/store";

import { createAppControllerDeps } from "./app-controller-deps.ts";
import { NanobossTuiController } from "../controller/controller.ts";
import type { ComposerState } from "./composer.ts";
import type {
  ControllerLike,
  EditorLike,
  NanobossTuiAppDeps,
  NanobossTuiAppParams,
} from "./app-types.ts";
import type { UiState } from "../state/state.ts";

interface AppControllerWiringOptions {
  appParams: NanobossTuiAppParams;
  appDeps: NanobossTuiAppDeps;
  composerState: ComposerState;
  editor: Pick<EditorLike, "addToHistory" | "setText">;
  promptForModelSelection: (
    currentSelection?: DownstreamAgentSelection,
  ) => Promise<DownstreamAgentSelection | undefined>;
  confirmPersistDefaultAgentSelection: (selection: DownstreamAgentSelection) => Promise<boolean>;
  onStateChange: (state: UiState) => void;
}

export function createAppController(options: AppControllerWiringOptions): ControllerLike {
  const controllerDeps = createAppControllerDeps({
    appParams: options.appParams,
    composerState: options.composerState,
    editor: options.editor,
    promptForModelSelection: options.promptForModelSelection,
    confirmPersistDefaultAgentSelection: options.confirmPersistDefaultAgentSelection,
    persistDefaultAgentSelection: writePersistedDefaultAgentSelection,
    onStateChange: options.onStateChange,
  });

  return options.appDeps.createController?.(options.appParams, controllerDeps)
    ?? new NanobossTuiController(options.appParams, controllerDeps);
}

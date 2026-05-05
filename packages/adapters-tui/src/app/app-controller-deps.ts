import type { DownstreamAgentSelection } from "@nanoboss/contracts";

import { clearComposerState, type ComposerState } from "./composer.ts";
import type { NanobossTuiControllerDeps } from "../controller/controller.ts";
import type { EditorLike, NanobossTuiAppParams } from "./app-types.ts";
import type { UiState } from "../state/state.ts";

export function createAppControllerDeps(params: {
  appParams: NanobossTuiAppParams;
  composerState: ComposerState;
  editor: Pick<EditorLike, "addToHistory" | "setText">;
  promptForModelSelection: (currentSelection?: DownstreamAgentSelection) => Promise<DownstreamAgentSelection | undefined>;
  confirmPersistDefaultAgentSelection: (selection: DownstreamAgentSelection) => Promise<boolean>;
  persistDefaultAgentSelection: (selection: DownstreamAgentSelection) => void;
  onStateChange: (state: UiState) => void;
}): NanobossTuiControllerDeps {
  return {
    promptForModelSelection: params.promptForModelSelection,
    confirmPersistDefaultAgentSelection: params.confirmPersistDefaultAgentSelection,
    persistDefaultAgentSelection: params.persistDefaultAgentSelection,
    listExtensionEntries: params.appParams.listExtensionEntries,
    onStateChange: params.onStateChange,
    onAddHistory: (text) => {
      params.editor.addToHistory(text);
    },
    onClearInput: () => {
      clearComposerState(params.composerState);
      params.editor.setText("");
    },
  };
}

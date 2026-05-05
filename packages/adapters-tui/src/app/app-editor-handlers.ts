import {
  type ComposerState,
  reconcileComposerState,
} from "./composer.ts";
import {
  buildPromptInputForSubmit,
  cloneComposerState,
} from "./app-composer.ts";
import type {
  ControllerLike,
  EditorLike,
} from "./app-types.ts";

export function bindAppEditorHandlers(params: {
  editor: EditorLike;
  controller: ControllerLike;
  composerState: ComposerState;
  getClearedComposerStateSnapshot: () => ComposerState | undefined;
  setClearedComposerStateSnapshot: (snapshot: ComposerState) => void;
  clearClearedComposerStateSnapshot: () => void;
  updateEditorSubmitState: () => void;
}): void {
  params.editor.onSubmit = (text) => {
    const promptInput = buildPromptInputForSubmit(
      params.composerState,
      text,
      params.getClearedComposerStateSnapshot(),
    );
    params.clearClearedComposerStateSnapshot();
    void params.controller.handleSubmit(promptInput);
  };
  params.editor.onChange = (text) => {
    if (text.length === 0 && params.composerState.imagesByToken.size > 0) {
      params.setClearedComposerStateSnapshot(cloneComposerState(params.composerState));
    } else if (text.length > 0) {
      params.clearClearedComposerStateSnapshot();
    }
    reconcileComposerState(params.composerState, text);
    params.updateEditorSubmitState();
  };
}

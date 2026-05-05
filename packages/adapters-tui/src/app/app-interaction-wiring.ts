import type { ComposerState } from "./composer.ts";
import { bindAppEditorHandlers } from "./app-editor-handlers.ts";
import { bindAppInputListener } from "./app-input-listener.ts";
import type {
  ControllerLike,
  EditorLike,
  TuiLike,
} from "./app-types.ts";
import type { KeyBindingAppHooks } from "../core/bindings.ts";
import type { UiState } from "../state/state.ts";

export function bindAppInteractions(params: {
  tui: TuiLike;
  editor: EditorLike;
  controller: ControllerLike;
  composerState: ComposerState;
  getState: () => UiState;
  getClearedComposerStateSnapshot: () => ComposerState | undefined;
  setClearedComposerStateSnapshot: (snapshot: ComposerState) => void;
  clearClearedComposerStateSnapshot: () => void;
  updateEditorSubmitState: () => void;
  createBindingAppHooks: () => KeyBindingAppHooks;
  handleImageTokenDeletion: (direction: "backspace" | "delete") => boolean;
}): void {
  bindAppEditorHandlers({
    editor: params.editor,
    controller: params.controller,
    composerState: params.composerState,
    getClearedComposerStateSnapshot: params.getClearedComposerStateSnapshot,
    setClearedComposerStateSnapshot: params.setClearedComposerStateSnapshot,
    clearClearedComposerStateSnapshot: params.clearClearedComposerStateSnapshot,
    updateEditorSubmitState: params.updateEditorSubmitState,
  });

  bindAppInputListener({
    tui: params.tui,
    controller: params.controller,
    editor: params.editor,
    getState: params.getState,
    createBindingAppHooks: params.createBindingAppHooks,
    handleImageTokenDeletion: params.handleImageTokenDeletion,
  });
}

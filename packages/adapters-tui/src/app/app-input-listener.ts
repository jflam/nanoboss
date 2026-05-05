import type {
  ControllerLike,
  EditorLike,
  TuiLike,
} from "./app-types.ts";
import { dispatchKeyBinding, type BindingCtx } from "../core/bindings.ts";
import {
  isKeyRelease,
  matchesKey,
} from "../shared/pi-tui.ts";
import type { UiState } from "../state/state.ts";

export function bindAppInputListener(params: {
  tui: TuiLike;
  controller: ControllerLike;
  editor: EditorLike;
  getState: () => UiState;
  createBindingAppHooks: () => BindingCtx["app"];
  handleImageTokenDeletion: (direction: "backspace" | "delete") => boolean;
}): void {
  params.tui.addInputListener((data) => {
    if (isKeyRelease(data)) {
      return undefined;
    }

    // Editor-local pre-step: backspace/delete image-token removal
    // depends on cursor state and the composer's image token map,
    // neither of which is surfaced through BindingCtx. Keep this
    // handler ahead of the registry dispatch so a successful token
    // deletion consumes the key before the registry sees it.
    if (matchesKey(data, "backspace") && params.handleImageTokenDeletion("backspace")) {
      return { consume: true };
    }

    if (matchesKey(data, "delete") && params.handleImageTokenDeletion("delete")) {
      return { consume: true };
    }

    const ctx: BindingCtx = {
      controller: params.controller,
      state: params.getState(),
      editor: {
        getText: () => params.editor.getText(),
        isShowingAutocomplete: () => params.editor.isShowingAutocomplete(),
      },
      app: params.createBindingAppHooks(),
    };

    const result = dispatchKeyBinding(data, ctx);
    if (result && result.consume !== false) {
      return { consume: true };
    }
    return undefined;
  });
}

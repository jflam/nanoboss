import type { Component } from "../shared/pi-tui.ts";
import type { UiState } from "../state/state.ts";
import type { NanobossTuiTheme } from "../theme/theme.ts";
import {
  getFormRenderer,
  type EditorLike,
  type FormRenderContext,
} from "../core/form-renderers.ts";
import type { FrontendContinuationWithFormId } from "./app-continuation-form.ts";

export function renderContinuationFormComponent(params: {
  continuation: FrontendContinuationWithFormId;
  state: UiState;
  theme: NanobossTuiTheme;
  editor: EditorLike;
  submit: (reply: string) => void;
  cancel: () => void;
}): Component | undefined {
  const renderer = getFormRenderer(params.continuation.formId);
  if (!renderer) {
    return undefined;
  }

  if (!renderer.schema.validate(params.continuation.formPayload)) {
    return undefined;
  }

  const ctx: FormRenderContext<unknown> = {
    payload: params.continuation.formPayload,
    state: params.state,
    theme: params.theme,
    editor: params.editor,
    submit: params.submit,
    cancel: params.cancel,
  };
  return renderer.render(ctx);
}

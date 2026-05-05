import { createTextPromptInput } from "@nanoboss/procedure-sdk";

import {
  buildContinuationFormSignature,
  getFormContinuation,
  type FrontendContinuationWithFormId,
} from "./app-continuation-form.ts";
import type {
  ControllerLike,
  EditorLike,
  TuiLike,
  ViewLike,
} from "./app-types.ts";
import { getFormRenderer, type FormRenderContext } from "./form-renderers.ts";
import type { UiState } from "./state.ts";
import type { NanobossTuiTheme } from "./theme.ts";

type InlineComposerMode = "editor" | "select" | "simplify2";

export class AppContinuationComposer {
  private inlineComposerMode: InlineComposerMode = "editor";
  private openSimplify2ContinuationSignature?: string;
  private lastSeenSimplify2ContinuationSignature?: string;
  private dismissedSimplify2ContinuationSignature?: string;

  constructor(
    private readonly deps: {
      tui: TuiLike;
      view: ViewLike;
      editor: EditorLike;
      controller: ControllerLike;
      theme: NanobossTuiTheme;
      getState: () => UiState;
      requestRender: (force?: boolean) => void;
    },
  ) {}

  beginSelect(): void {
    this.inlineComposerMode = "select";
  }

  restoreEditorComposer(): void {
    this.inlineComposerMode = "editor";
    this.openSimplify2ContinuationSignature = undefined;
    this.deps.view.showEditor();
    this.deps.tui.setFocus(this.deps.editor);
    this.deps.requestRender(true);
  }

  sync(): void {
    const state = this.deps.getState();
    const continuation = getFormContinuation(state.pendingContinuation);
    const signature = continuation ? buildContinuationFormSignature(continuation) : undefined;
    if (signature !== this.lastSeenSimplify2ContinuationSignature) {
      this.lastSeenSimplify2ContinuationSignature = signature;
      this.dismissedSimplify2ContinuationSignature = undefined;
    }

    const shouldShow = Boolean(
      continuation
      && signature
      && !state.simplify2AutoApprove
      && !state.inputDisabled
      && this.inlineComposerMode !== "select"
      && this.dismissedSimplify2ContinuationSignature !== signature,
    );

    if (shouldShow && continuation && signature && this.inlineComposerMode !== "simplify2") {
      this.mountContinuationForm(continuation, signature);
      return;
    }

    if (!shouldShow && this.inlineComposerMode === "simplify2") {
      this.restoreEditorComposer();
    }
  }

  private mountContinuationForm(
    continuation: FrontendContinuationWithFormId,
    signature: string,
  ): void {
    const renderer = getFormRenderer(continuation.formId);
    if (!renderer) {
      // Unknown formId: dismiss the inline composer so the user can
      // still type a free-form reply instead of crashing the TUI.
      this.dismissedSimplify2ContinuationSignature = signature;
      return;
    }

    if (!renderer.schema.validate(continuation.formPayload)) {
      // Payload failed typia validation. Treat as unknown/dismissed
      // rather than crashing the TUI; the underlying continuation is
      // still pending and the user can type a reply in the default
      // composer.
      this.dismissedSimplify2ContinuationSignature = signature;
      return;
    }

    const state = this.deps.getState();
    this.inlineComposerMode = "simplify2";
    this.openSimplify2ContinuationSignature = signature;

    const ctx: FormRenderContext<unknown> = {
      payload: continuation.formPayload,
      state,
      theme: this.deps.theme,
      editor: {
        setText: (text: string) => {
          this.deps.editor.setText(text);
        },
        getText: () => this.deps.editor.getText(),
      },
      submit: (reply: string) => {
        this.handleFormSubmit(reply);
      },
      cancel: () => {
        this.handleFormCancel();
      },
    };

    const component = renderer.render(ctx);
    this.deps.view.showComposer(component);
    this.deps.tui.setFocus(component);
    this.deps.requestRender(true);
  }

  private handleFormSubmit(reply: string): void {
    this.restoreEditorComposer();
    void this.deps.controller.handleSubmit(createTextPromptInput(reply));
  }

  private handleFormCancel(): void {
    const signature = this.openSimplify2ContinuationSignature;
    this.restoreEditorComposer();
    if (signature) {
      this.dismissedSimplify2ContinuationSignature = signature;
    }
    void this.deps.controller.handleContinuationCancel?.();
  }
}

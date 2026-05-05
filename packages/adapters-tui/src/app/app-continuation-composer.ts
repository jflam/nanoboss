import { createTextPromptInput } from "@nanoboss/procedure-sdk";

import {
  buildContinuationFormSignature,
  getFormContinuation,
  type FrontendContinuationWithFormId,
} from "./app-continuation-form.ts";
import { renderContinuationFormComponent } from "./app-continuation-renderer.ts";
import type {
  ControllerLike,
  EditorLike,
  TuiLike,
  ViewLike,
} from "./app-types.ts";
import { SelectOverlay, type SelectOverlayOptions } from "../overlays/select-overlay.ts";
import { TUI } from "../shared/pi-tui.ts";
import type { UiState } from "../state/state.ts";
import type { NanobossTuiTheme } from "../theme/theme.ts";

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

  private beginSelect(): void {
    this.inlineComposerMode = "select";
  }

  async promptSelect<T extends string>(
    options: SelectOverlayOptions<T>,
  ): Promise<T | undefined> {
    return await new Promise<T | undefined>((resolve) => {
      this.beginSelect();
      const component = new SelectOverlay<T>(
        this.deps.tui as TUI,
        this.deps.theme,
        options,
        (value) => {
          this.restoreEditorComposer();
          resolve(value);
        },
      );
      this.deps.view.showComposer(component);
      this.deps.tui.setFocus(component);
      this.deps.requestRender(true);
    });
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
    const component = renderContinuationFormComponent({
      continuation,
      state: this.deps.getState(),
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
    });
    if (!component) {
      this.dismissedSimplify2ContinuationSignature = signature;
      return;
    }

    this.inlineComposerMode = "simplify2";
    this.openSimplify2ContinuationSignature = signature;
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

import type { TypeDescriptor } from "@nanoboss/procedure-sdk";

import type { Component } from "../shared/pi-tui.ts";
import type { UiState } from "../state/state.ts";
import type { NanobossTuiTheme } from "../theme/theme.ts";

/**
 * Minimal editor surface exposed to form renderers. Mirrors the internal
 * EditorLike shape used in app.ts so renderers can seed or inspect the
 * default composer without taking a direct dependency on the full TUI
 * Editor implementation.
 */
export interface EditorLike {
  setText(text: string): void;
  getText(): string;
}

/**
 * Per-renderer context handed to FormRenderer.render. The payload has
 * already been validated against the renderer's schema by the caller
 * before mount. submit/cancel route through the controller: submit
 * reaches controller.handleSubmit (resume), cancel reaches
 * controller.handleContinuationCancel (engine-authoritative cancel).
 */
export interface FormRenderContext<T> {
  payload: T;
  state: UiState;
  theme: NanobossTuiTheme;
  submit(reply: string): void;
  cancel(): void;
  editor: EditorLike;
}

/**
 * A registered form renderer. formId is the public contract procedures
 * target via Continuation.form.formId; schemas are typia-backed via the
 * shared jsonType(...) pattern so payloads are validated at mount time.
 */
interface FormRenderer<T = unknown> {
  formId: string;
  schema: TypeDescriptor<T>;
  render(ctx: FormRenderContext<T>): Component;
}

const registry = new Map<string, FormRenderer<unknown>>();

export function registerFormRenderer<T>(renderer: FormRenderer<T>): void {
  if (registry.has(renderer.formId)) {
    throw new Error(`form renderer already registered: ${renderer.formId}`);
  }
  registry.set(renderer.formId, renderer as FormRenderer<unknown>);
}

export function getFormRenderer(formId: string): FormRenderer<unknown> | undefined {
  return registry.get(formId);
}

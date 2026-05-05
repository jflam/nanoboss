import type { PanelRenderer as SdkPanelRenderer } from "@nanoboss/tui-extension-sdk";

import type { UiState } from "../state/state.ts";
import type { NanobossTuiTheme } from "../theme/theme.ts";

export type PanelRenderer<T = unknown> = SdkPanelRenderer<T, UiState, NanobossTuiTheme>;

const registry = new Map<string, PanelRenderer<unknown>>();

export function registerPanelRenderer<T>(renderer: PanelRenderer<T>): void {
  if (registry.has(renderer.rendererId)) {
    throw new Error(`panel renderer already registered: ${renderer.rendererId}`);
  }
  registry.set(renderer.rendererId, renderer as PanelRenderer<unknown>);
}

/**
 * Remove a previously-registered panel renderer. Exposed for the TUI
 * extension boot layer so a higher-precedence extension (repo/profile) can
 * shadow a renderer contributed by a lower-precedence extension (builtin).
 * Returns true if a renderer was removed, false otherwise.
 */
export function unregisterPanelRenderer(rendererId: string): boolean {
  return registry.delete(rendererId);
}

export function getPanelRenderer(rendererId: string): PanelRenderer<unknown> | undefined {
  return registry.get(rendererId);
}

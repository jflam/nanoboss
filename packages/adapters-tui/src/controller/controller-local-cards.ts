import type { TuiExtensionStatus } from "@nanoboss/tui-extension-catalog";

import { formatExtensionsCard } from "../extensions/command-extensions-card.ts";
import type { UiAction } from "../reducer/reducer-actions.ts";

export interface ControllerLocalCardOptions {
  /**
   * Stable keys replace prior local cards in place; omitted keys append a
   * fresh card for affordances like keybinding help.
   */
  key?: string;
  title: string;
  markdown: string;
  severity?: "info" | "warn" | "error";
  dismissible?: boolean;
}

export function createLocalCardAction(
  opts: ControllerLocalCardOptions,
): Extract<UiAction, { type: "local_procedure_panel" }> {
  // Local cards render through nb/card@1 so command output remains visible in
  // the transcript instead of disappearing through the status line.
  return {
    type: "local_procedure_panel",
    panelId: `local-${opts.key ?? "anon"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    rendererId: "nb/card@1",
    payload: {
      kind: "notice",
      title: opts.title,
      markdown: opts.markdown,
    },
    severity: opts.severity ?? "info",
    dismissible: opts.dismissible ?? true,
    ...(opts.key !== undefined ? { key: opts.key } : {}),
  };
}

export function buildExtensionsLocalCard(
  provider: (() => readonly TuiExtensionStatus[]) | undefined,
): ControllerLocalCardOptions {
  if (!provider) {
    return {
      key: "local:extensions",
      title: "Extensions",
      markdown: "Extension registry is not available.",
      severity: "error",
    };
  }

  const card = formatExtensionsCard(provider());
  return {
    key: "local:extensions",
    title: card.title,
    markdown: card.markdown,
    severity: card.severity,
  };
}

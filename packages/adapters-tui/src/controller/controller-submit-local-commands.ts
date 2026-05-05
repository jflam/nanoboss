import {
  isExitRequest,
  isExtensionsListRequest,
  isModelPickerRequest,
  isNewSessionRequest,
  parseToolCardThemeCommand,
} from "../app/commands.ts";
import type { ControllerLocalCardOptions } from "./controller-local-cards.ts";
import type { UiAction } from "../reducer/reducer-actions.ts";

export function handleImmediateLocalSubmitCommand(params: {
  trimmed: string;
  onClearInput?: () => void;
  requestExit: () => void;
  dispatch: (action: UiAction) => void;
  showLocalCard: (opts: ControllerLocalCardOptions) => void;
}): boolean {
  if (isExitRequest(params.trimmed)) {
    params.onClearInput?.();
    params.requestExit();
    return true;
  }

  const toolCardThemeMode = parseToolCardThemeCommand(params.trimmed);
  if (toolCardThemeMode) {
    params.onClearInput?.();
    params.dispatch({ type: "local_tool_card_theme_mode", mode: toolCardThemeMode });
    params.showLocalCard({
      key: "local:tool-theme",
      title: "Tool cards",
      markdown: `Theme set to **${toolCardThemeMode}**.`,
      severity: "info",
    });
    return true;
  }

  return false;
}

export async function handleIdleLocalSubmitCommand(params: {
  trimmed: string;
  onClearInput?: () => void;
  createNewSession: () => Promise<void>;
  emitExtensionsList: () => void;
  openModelPicker: () => Promise<void>;
}): Promise<boolean> {
  if (isNewSessionRequest(params.trimmed)) {
    params.onClearInput?.();
    await params.createNewSession();
    return true;
  }

  if (isExtensionsListRequest(params.trimmed)) {
    params.onClearInput?.();
    params.emitExtensionsList();
    return true;
  }

  if (isModelPickerRequest(params.trimmed)) {
    await params.openModelPicker();
    return true;
  }

  return false;
}

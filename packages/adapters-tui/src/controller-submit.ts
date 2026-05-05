import type { PromptInput } from "@nanoboss/contracts";
import {
  normalizePromptInput,
  promptInputDisplayText,
} from "@nanoboss/procedure-sdk";

import {
  isExitRequest,
  isExtensionsListRequest,
  isModelPickerRequest,
  isNewSessionRequest,
  parseModelSelectionCommand,
  parseToolCardThemeCommand,
} from "./commands.ts";
import {
  applyInlineModelSelection,
  type ControllerModelSelectionDeps,
} from "./controller-model-selection.ts";
import type { ControllerLocalCardOptions } from "./controller-local-cards.ts";
import type { UiAction } from "./reducer-actions.ts";
import type { UiPendingPrompt, UiState } from "./state.ts";

interface ControllerSubmitDeps extends ControllerModelSelectionDeps {
  onClearInput?: () => void;
  onAddHistory?: (text: string) => void;
}

export async function handleControllerSubmit(params: {
  input: string | PromptInput;
  cwd: string;
  deps: ControllerSubmitDeps;
  getState: () => UiState;
  requestExit: () => void;
  dispatch: (action: UiAction) => void;
  showLocalCard: (opts: ControllerLocalCardOptions) => void;
  handleBusyPromptInput: (
    promptInput: PromptInput,
    text: string,
    trimmed: string,
    kind: UiPendingPrompt["kind"],
  ) => Promise<boolean>;
  createNewSession: () => Promise<void>;
  emitExtensionsList: () => void;
  openModelPicker: () => Promise<void>;
  withLocalBusy: <T>(status: string, work: () => Promise<T>) => Promise<T>;
  forwardPrompt: (prompt: PromptInput) => Promise<boolean>;
}): Promise<void> {
  const promptInput = normalizePromptInput(params.input);
  const text = promptInputDisplayText(promptInput);
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return;
  }

  if (isExitRequest(trimmed)) {
    params.deps.onClearInput?.();
    params.requestExit();
    return;
  }

  const toolCardThemeMode = parseToolCardThemeCommand(trimmed);
  if (toolCardThemeMode) {
    params.deps.onClearInput?.();
    params.dispatch({ type: "local_tool_card_theme_mode", mode: toolCardThemeMode });
    params.showLocalCard({
      key: "local:tool-theme",
      title: "Tool cards",
      markdown: `Theme set to **${toolCardThemeMode}**.`,
      severity: "info",
    });
    return;
  }

  if (params.getState().inputDisabled) {
    if (await params.handleBusyPromptInput(promptInput, text, trimmed, "steering")) {
      return;
    }
  }

  if (isNewSessionRequest(trimmed)) {
    params.deps.onClearInput?.();
    await params.createNewSession();
    return;
  }

  if (isExtensionsListRequest(trimmed)) {
    params.deps.onClearInput?.();
    params.emitExtensionsList();
    return;
  }

  if (isModelPickerRequest(trimmed)) {
    await params.openModelPicker();
    return;
  }

  const inlineSelection = parseModelSelectionCommand(trimmed);
  if (inlineSelection) {
    await applyInlineModelSelection({
      selection: inlineSelection,
      cwd: params.cwd,
      deps: params.deps,
      withLocalBusy: params.withLocalBusy,
      showLocalCard: params.showLocalCard,
      dispatch: params.dispatch,
    });
  }

  params.deps.onAddHistory?.(text);
  params.deps.onClearInput?.();
  await params.forwardPrompt(promptInput);
}

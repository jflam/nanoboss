import type { PromptInput } from "@nanoboss/contracts";
import {
  normalizePromptInput,
  promptInputDisplayText,
} from "@nanoboss/procedure-sdk";

import { parseModelSelectionCommand } from "../app/commands.ts";
import {
  applyInlineModelSelection,
  type ControllerModelSelectionDeps,
} from "./controller-model-selection.ts";
import type { ControllerLocalCardOptions } from "./controller-local-cards.ts";
import type { UiAction } from "../reducer/reducer-actions.ts";
import type { UiPendingPrompt, UiState } from "../state/state.ts";
import {
  handleIdleLocalSubmitCommand,
  handleImmediateLocalSubmitCommand,
} from "./controller-submit-local-commands.ts";

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

  if (handleImmediateLocalSubmitCommand({
    trimmed,
    onClearInput: params.deps.onClearInput,
    requestExit: params.requestExit,
    dispatch: params.dispatch,
    showLocalCard: params.showLocalCard,
  })) {
    return;
  }

  if (params.getState().inputDisabled) {
    if (await params.handleBusyPromptInput(promptInput, text, trimmed, "steering")) {
      return;
    }
  }

  if (await handleIdleLocalSubmitCommand({
    trimmed,
    onClearInput: params.deps.onClearInput,
    createNewSession: params.createNewSession,
    emitExtensionsList: params.emitExtensionsList,
    openModelPicker: params.openModelPicker,
  })) {
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

export async function queueControllerPrompt(params: {
  input: string | PromptInput;
  getState: () => UiState;
  handleBusyPromptInput: (
    promptInput: PromptInput,
    text: string,
    trimmed: string,
    kind: UiPendingPrompt["kind"],
  ) => Promise<boolean>;
}): Promise<void> {
  const promptInput = normalizePromptInput(params.input);
  const text = promptInputDisplayText(promptInput);
  const trimmed = text.trim();
  if (trimmed.length === 0 || !params.getState().inputDisabled) {
    return;
  }

  await params.handleBusyPromptInput(promptInput, text, trimmed, "queued");
}

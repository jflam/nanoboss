import type { PromptInput } from "@nanoboss/procedure-sdk";

import type { KeyBindingAppHooks } from "../core/bindings.ts";
import type { ComposerState } from "./composer.ts";
import { buildPromptInputForSubmit } from "./app-composer.ts";

interface BindingHooksEditor {
  getText(): string;
  isShowingAutocomplete(): boolean;
}

interface BindingHooksController {
  toggleToolOutput(): void;
  queuePrompt(input: PromptInput): Promise<void>;
}

export function createAppBindingHooks(params: {
  controller: BindingHooksController;
  editor: BindingHooksEditor;
  composerState: ComposerState;
  getClearedComposerStateSnapshot: () => ComposerState | undefined;
  clearClearedComposerStateSnapshot: () => void;
  handleCtrlC: () => boolean;
  handleCtrlVImagePaste: () => Promise<void>;
  toggleLiveUpdatesPaused: () => void;
  now: () => number;
  getLastToolOutputToggleAt: () => number;
  setLastToolOutputToggleAt: (value: number) => void;
  toolOutputToggleCooldownMs: number;
}): KeyBindingAppHooks {
  return {
    handleCtrlC: params.handleCtrlC,
    handleCtrlVImagePaste: params.handleCtrlVImagePaste,
    handleCtrlOWithCooldown: () => {
      const now = params.now();
      if (now - params.getLastToolOutputToggleAt() >= params.toolOutputToggleCooldownMs) {
        params.setLastToolOutputToggleAt(now);
        params.controller.toggleToolOutput();
      }
    },
    toggleLiveUpdatesPaused: params.toggleLiveUpdatesPaused,
    handleTabQueue: () => {
      if (params.editor.isShowingAutocomplete()) {
        return false;
      }
      const text = params.editor.getText();
      if (text.trim().length === 0) {
        return false;
      }
      const promptInput = buildPromptInputForSubmit(
        params.composerState,
        text,
        params.getClearedComposerStateSnapshot(),
      );
      params.clearClearedComposerStateSnapshot();
      void params.controller.queuePrompt(promptInput);
      return true;
    },
  };
}

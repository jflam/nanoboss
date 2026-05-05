import {
  sendSessionPrompt,
  type FrontendEventEnvelope,
} from "@nanoboss/adapters-http";
import type { PromptInput } from "@nanoboss/contracts";
import {
  normalizePromptInput,
  promptInputDisplayText,
} from "@nanoboss/procedure-sdk";

import type { UiAction } from "../reducer/reducer-actions.ts";
import type { UiPendingPrompt, UiState } from "../state/state.ts";
import {
  formatPendingPromptClearStatus,
  isTerminalFrontendEvent,
  selectNextPendingPrompt,
} from "./controller-input-flow.ts";

export interface ControllerPromptFlowDeps {
  sendSessionPrompt?: typeof sendSessionPrompt;
}

type Dispatch = (action: UiAction) => void;

export function buildPendingPromptAction(params: {
  promptInput: PromptInput;
  kind: UiPendingPrompt["kind"];
  nextPendingPromptId: number;
}): {
  action: UiAction;
  nextPendingPromptId: number;
} {
  const text = promptInputDisplayText(params.promptInput);
  return {
    action: {
      type: "local_pending_prompt_added",
      prompt: {
        id: `pending-${params.nextPendingPromptId}`,
        text,
        kind: params.kind,
        promptInput: params.promptInput,
      },
    },
    nextPendingPromptId: params.nextPendingPromptId + 1,
  };
}

export async function maybeFlushPendingPrompt(params: {
  event: FrontendEventEnvelope;
  getState: () => UiState;
  flushingPendingPrompt: boolean;
  setFlushingPendingPrompt: (flushing: boolean) => void;
  forwardPrompt: (prompt: PromptInput) => Promise<boolean>;
  dispatch: Dispatch;
}): Promise<void> {
  const state = params.getState();
  if (!isTerminalFrontendEvent(params.event) || params.flushingPendingPrompt || state.inputDisabled) {
    return;
  }

  const nextPrompt = selectNextPendingPrompt(state.pendingPrompts);
  if (!nextPrompt) {
    return;
  }

  params.setFlushingPendingPrompt(true);
  params.dispatch({
    type: "local_pending_prompt_removed",
    promptId: nextPrompt.id,
  });

  try {
    const forwarded = await params.forwardPrompt(nextPrompt.promptInput ?? normalizePromptInput(nextPrompt.text));
    const remainingPendingPrompts = params.getState().pendingPrompts.length;
    if (!forwarded && remainingPendingPrompts > 0) {
      params.dispatch({
        type: "local_pending_prompts_cleared",
        text: formatPendingPromptClearStatus(remainingPendingPrompts),
      });
    }
  } finally {
    params.setFlushingPendingPrompt(false);
  }
}

export async function forwardPrompt(params: {
  deps: ControllerPromptFlowDeps;
  serverUrl: string;
  state: UiState;
  prompt: PromptInput;
  dispatch: Dispatch;
}): Promise<boolean> {
  params.dispatch({ type: "local_user_submitted", text: promptInputDisplayText(params.prompt) });

  try {
    if (!params.state.sessionId) {
      throw new Error("No active session");
    }

    await (params.deps.sendSessionPrompt ?? sendSessionPrompt)(
      params.serverUrl,
      params.state.sessionId,
      params.prompt,
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    params.dispatch({ type: "local_send_failed", error: message });
    return false;
  }
}

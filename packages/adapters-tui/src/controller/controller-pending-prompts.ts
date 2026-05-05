import type { PromptInput } from "@nanoboss/contracts";

import type { UiAction } from "../reducer/reducer-actions.ts";
import type { UiPendingPrompt } from "../state/state.ts";
import {
  buildPendingPromptAction,
} from "./controller-prompt-flow.ts";

export async function enqueueControllerPendingPrompt(params: {
  promptInput: PromptInput;
  kind: UiPendingPrompt["kind"];
  nextPendingPromptId: number;
  dispatch: (action: UiAction) => void;
  cancelActiveRun: () => Promise<void>;
}): Promise<number> {
  const pendingPrompt = buildPendingPromptAction({
    promptInput: params.promptInput,
    kind: params.kind,
    nextPendingPromptId: params.nextPendingPromptId,
  });
  params.dispatch(pendingPrompt.action);

  if (params.kind === "steering") {
    await params.cancelActiveRun();
  }

  return pendingPrompt.nextPendingPromptId;
}

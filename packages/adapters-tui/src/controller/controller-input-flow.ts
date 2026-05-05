import type { FrontendEventEnvelope } from "@nanoboss/adapters-http";
import type { PromptInput } from "@nanoboss/contracts";

import type { UiPendingPrompt, UiState } from "../state/state.ts";
import type { UiAction } from "../reducer/reducer-actions.ts";

type Dispatch = (action: UiAction) => void;

function getBusyLocalCommandLabel(trimmed: string): string | undefined {
  if (trimmed === "/new") {
    return "/new";
  }

  if (trimmed === "/model" || trimmed.startsWith("/model ")) {
    return "/model";
  }

  return undefined;
}

export function isTerminalFrontendEvent(event: FrontendEventEnvelope): boolean {
  return event.type === "run_completed"
    || event.type === "run_paused"
    || event.type === "run_failed"
    || event.type === "run_cancelled";
}

export function selectNextPendingPrompt(
  prompts: UiPendingPrompt[],
): UiPendingPrompt | undefined {
  return prompts.find((prompt) => prompt.kind === "steering")
    ?? prompts.find((prompt) => prompt.kind === "queued");
}

export function formatPendingPromptClearStatus(count: number): string {
  return `[run] cleared ${count} pending prompt${count === 1 ? "" : "s"} after send failed`;
}

function getLocalBusyInputStatus(statusLine: string | undefined): string {
  if (statusLine?.startsWith("[model]")) {
    return "[model] wait for the current model update to finish before sending more input";
  }

  return "[status] wait for the current local task to finish before sending more input";
}

export async function handleBusyPromptInput(params: {
  state: UiState;
  trimmed: string;
  text: string;
  promptInput: PromptInput;
  kind: UiPendingPrompt["kind"];
  dispatch: Dispatch;
  onAddHistory?: (text: string) => void;
  onClearInput?: () => void;
  enqueuePendingPrompt: (promptInput: PromptInput, kind: UiPendingPrompt["kind"]) => Promise<void>;
}): Promise<boolean> {
  if (!params.state.inputDisabled) {
    return false;
  }

  if (params.state.inputDisabledReason === "local") {
    params.dispatch({
      type: "local_status",
      text: getLocalBusyInputStatus(params.state.statusLine),
    });
    return true;
  }

  const blockedCommand = getBusyLocalCommandLabel(params.trimmed);
  if (blockedCommand) {
    params.dispatch({
      type: "local_status",
      text: `[run] wait for the current run to finish before using ${blockedCommand}`,
    });
    return true;
  }

  params.onAddHistory?.(params.text);
  params.onClearInput?.();
  await params.enqueuePendingPrompt(params.promptInput, params.kind);
  return true;
}

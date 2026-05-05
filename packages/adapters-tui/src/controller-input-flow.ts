import type { FrontendEventEnvelope } from "@nanoboss/adapters-http";

import type { UiPendingPrompt } from "./state.ts";

export function getBusyLocalCommandLabel(trimmed: string): string | undefined {
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

export function getLocalBusyInputStatus(statusLine: string | undefined): string {
  if (statusLine?.startsWith("[model]")) {
    return "[model] wait for the current model update to finish before sending more input";
  }

  return "[status] wait for the current local task to finish before sending more input";
}

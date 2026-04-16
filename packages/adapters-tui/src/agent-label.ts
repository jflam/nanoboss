import type { DownstreamAgentSelection } from "@nanoboss/contracts";

import { parseReasoningModelSelection } from "@nanoboss/agent-acp";

export function formatAgentSelectionLabel(selection: DownstreamAgentSelection): string {
  const model = selection.model?.trim();
  if (!model) {
    return `${selection.provider}/default`;
  }

  if (selection.provider !== "copilot") {
    return `${selection.provider}/${model}`;
  }

  const { baseModel, reasoningEffort } = parseReasoningModelSelection(model);
  const normalizedModel = baseModel ?? model;
  return reasoningEffort
    ? `${selection.provider}/${normalizedModel}/${formatReasoningEffort(reasoningEffort)}`
    : `${selection.provider}/${normalizedModel}`;
}

function formatReasoningEffort(value: string): string {
  return value === "xhigh" ? "x-high" : value;
}

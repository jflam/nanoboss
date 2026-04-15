import type { DownstreamAgentConfig } from "@nanoboss/contracts";

export function formatAgentBanner(config: DownstreamAgentConfig): string {
  const provider = config.provider ?? config.command;
  const model = config.model?.trim() || "default";
  const reasoning = formatReasoningEffort(config.reasoningEffort);
  return reasoning ? `${provider}/${model}/${reasoning}` : `${provider}/${model}`;
}

function formatReasoningEffort(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value === "xhigh" ? "x-high" : value;
}

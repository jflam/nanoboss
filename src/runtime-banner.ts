import { resolveDownstreamAgentConfig } from "./config.ts";
import type { DownstreamAgentConfig } from "./types.ts";

export function formatAgentBanner(config: DownstreamAgentConfig): string {
  const provider = config.provider ?? config.command;
  const model = config.model?.trim() || "default";
  const reasoning = formatReasoningEffort(config.reasoningEffort);
  return reasoning ? `${provider}/${model}/${reasoning}` : `${provider}/${model}`;
}

export function getDefaultAgentBanner(cwd?: string): string {
  return formatAgentBanner(resolveDownstreamAgentConfig(cwd));
}

function formatReasoningEffort(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  if (value === "xhigh") {
    return "x-high";
  }

  return value;
}

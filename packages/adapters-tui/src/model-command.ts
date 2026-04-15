import type { DownstreamAgentProvider } from "@nanoboss/contracts";

export function buildModelCommand(
  provider: DownstreamAgentProvider,
  model: string,
): string {
  return `/model ${provider} ${model}`;
}

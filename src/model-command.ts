import type { DownstreamAgentProvider } from "./types.ts";

export function buildModelCommand(
  provider: DownstreamAgentProvider,
  model: string,
): string {
  return `/model ${provider} ${model}`;
}

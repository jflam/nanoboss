import { getAgentTokenUsagePercent } from "../agent/token-usage.ts";
import type { AgentTokenUsage } from "../core/types.ts";

export function formatToolTraceLine(depth: number, text: string): string {
  return `${"│ ".repeat(depth)}${text}`;
}

export function formatTokenUsageLine(usage: AgentTokenUsage): string {
  if (usage.currentContextTokens !== undefined && usage.maxContextTokens !== undefined) {
    const percent = getAgentTokenUsagePercent(usage) ?? 0;
    return `[tokens] ${formatInt(usage.currentContextTokens)} / ${formatInt(usage.maxContextTokens)} (${percent.toFixed(1)}%)`;
  }

  if (usage.currentContextTokens !== undefined) {
    return `[tokens] ${formatInt(usage.currentContextTokens)}`;
  }

  return `[tokens] ${usage.source}`;
}

export function formatElapsedRunTimer(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `[time] ${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `[time] ${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatInt(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

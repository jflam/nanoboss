import { getAgentTokenUsagePercent } from "@nanoboss/agent-acp";
import type { AgentTokenUsage } from "@nanoboss/contracts";

export interface TokenUsageSummary {
  used?: number;
  limit?: number;
  percent?: number;
  source?: string;
}

function formatToolTraceLine(depth: number, text: string): string {
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

export function toTokenUsageSummary(usage: AgentTokenUsage): TokenUsageSummary {
  const summary: TokenUsageSummary = { source: usage.source };
  if (usage.currentContextTokens !== undefined) {
    summary.used = usage.currentContextTokens;
  }
  if (usage.maxContextTokens !== undefined) {
    summary.limit = usage.maxContextTokens;
  }
  const percent = getAgentTokenUsagePercent(usage);
  if (percent !== undefined) {
    summary.percent = percent;
  }
  return summary;
}

function formatCompactTokenCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return "0";
  }
  if (value < 1_000) {
    return String(Math.round(value));
  }
  if (value < 100_000) {
    const rounded = Math.round(value / 100) / 10;
    return `${trimTrailingZero(rounded.toFixed(1))}k`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  const millions = value / 1_000_000;
  if (millions < 10) {
    return `${trimTrailingZero(millions.toFixed(1))}M`;
  }
  return `${Math.round(millions)}M`;
}

interface FormatCompactTokenUsageOptions {
  includePercent?: boolean;
  includeLimit?: boolean;
}

export function formatCompactTokenUsage(
  summary: TokenUsageSummary,
  options?: FormatCompactTokenUsageOptions,
): string | undefined {
  if (summary.used === undefined && summary.limit === undefined && summary.percent === undefined) {
    return undefined;
  }
  const includePercent = options?.includePercent ?? true;
  const includeLimit = options?.includeLimit ?? true;
  const used = summary.used !== undefined ? formatCompactTokenCount(summary.used) : "?";
  const segments = [`tok ${used}`];
  if (includeLimit && summary.limit !== undefined) {
    segments[0] = `tok ${used}/${formatCompactTokenCount(summary.limit)}`;
  }
  if (includePercent && summary.percent !== undefined) {
    segments.push(`(${Math.round(summary.percent)}%)`);
  }
  return segments.join(" ");
}

export function stripModelQualifier(model: string): string {
  const slash = model.indexOf("/");
  if (slash === -1) {
    return model;
  }
  return model.slice(0, slash);
}

function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
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

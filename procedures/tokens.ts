import { formatAgentBanner } from "../src/core/runtime-banner.ts";
import { getAgentTokenUsagePercent } from "../src/agent/token-usage.ts";
import type { AgentTokenUsage, Procedure } from "../src/core/types.ts";

export default {
  name: "tokens",
  description: "Show the latest token/context metrics for the default agent session",
  async execute(_prompt, ctx) {
    const config = ctx.getDefaultAgentConfig();
    const banner = formatAgentBanner(config);
    const usage = await ctx.getDefaultAgentTokenUsage();

    if (!usage) {
      return {
        display: [
          `Default agent: ${banner}`,
          "",
          "No live token metrics yet.",
          "Run a /default turn first, then run /tokens again.",
          "",
          "Current implementation has concrete live metrics for Codex, Copilot, and Claude sessions.",
        ].join("\n"),
        summary: `tokens: unavailable for ${banner}`,
      };
    }

    return {
      data: usage,
      display: renderUsage(banner, usage),
      summary: summarizeUsage(banner, usage),
    };
  },
} satisfies Procedure;

function renderUsage(banner: string, usage: AgentTokenUsage): string {
  const lines = [
    `Default agent: ${banner}`,
    `Source: ${usage.source}`,
  ];

  if (usage.currentContextTokens !== undefined && usage.maxContextTokens !== undefined) {
    lines.push(
      `Context: ${formatInt(usage.currentContextTokens)} / ${formatInt(usage.maxContextTokens)} tokens (${formatPercent(getAgentTokenUsagePercent(usage) ?? 0)})`,
    );
  } else if (usage.currentContextTokens !== undefined) {
    lines.push(`Context: ${formatInt(usage.currentContextTokens)} tokens in use`);
  }

  if (
    usage.inputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.cacheReadTokens !== undefined ||
    usage.cacheWriteTokens !== undefined
  ) {
    lines.push(
      `Turn usage: input ${formatMaybe(usage.inputTokens)}, output ${formatMaybe(usage.outputTokens)}, cache read ${formatMaybe(usage.cacheReadTokens)}, cache write ${formatMaybe(usage.cacheWriteTokens)}`,
    );
  }

  const breakdown = [
    usage.systemTokens !== undefined ? `system ${formatInt(usage.systemTokens)}` : undefined,
    usage.conversationTokens !== undefined ? `conversation ${formatInt(usage.conversationTokens)}` : undefined,
    usage.toolDefinitionsTokens !== undefined ? `tools ${formatInt(usage.toolDefinitionsTokens)}` : undefined,
  ].filter(Boolean);
  if (breakdown.length > 0) {
    lines.push(`Breakdown: ${breakdown.join(", ")}`);
  }

  if (usage.totalTrackedTokens !== undefined) {
    lines.push(`Cumulative tracked tokens: ${formatInt(usage.totalTrackedTokens)}`);
  }

  if (usage.sessionId) {
    lines.push(`ACP session: ${usage.sessionId}`);
  }

  if (usage.capturedAt) {
    lines.push(`Captured at: ${usage.capturedAt}`);
  }

  return `${lines.join("\n")}\n`;
}

function summarizeUsage(banner: string, usage: AgentTokenUsage): string {
  if (usage.currentContextTokens !== undefined && usage.maxContextTokens !== undefined) {
    return `tokens: ${banner} ${usage.currentContextTokens}/${usage.maxContextTokens}`;
  }

  if (usage.currentContextTokens !== undefined) {
    return `tokens: ${banner} ${usage.currentContextTokens}`;
  }

  return `tokens: ${banner}`;
}

function formatMaybe(value: number | undefined): string {
  return value === undefined ? "—" : formatInt(value);
}

function formatInt(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatPercent(percent: number): string {
  return `${percent.toFixed(1)}%`;
}

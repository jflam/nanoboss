import { formatAgentBanner } from "../src/runtime-banner.ts";
import type { AgentTokenSnapshot, Procedure } from "../src/types.ts";

export default {
  name: "tokens",
  description: "Show the latest token/context metrics for the default agent session",
  async execute(_prompt, ctx) {
    const config = ctx.getDefaultAgentConfig();
    const banner = formatAgentBanner(config);
    const snapshot = await ctx.getDefaultAgentTokenSnapshot();

    if (!snapshot) {
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
      data: snapshot,
      display: renderSnapshot(banner, snapshot),
      summary: summarizeSnapshot(banner, snapshot),
    };
  },
} satisfies Procedure;

function renderSnapshot(banner: string, snapshot: AgentTokenSnapshot): string {
  const lines = [
    `Default agent: ${banner}`,
    `Source: ${snapshot.source}`,
  ];

  if (snapshot.usedContextTokens !== undefined && snapshot.contextWindowTokens !== undefined) {
    lines.push(
      `Context: ${formatInt(snapshot.usedContextTokens)} / ${formatInt(snapshot.contextWindowTokens)} tokens (${formatPercent(snapshot.usedContextTokens, snapshot.contextWindowTokens)})`,
    );
  } else if (snapshot.usedContextTokens !== undefined) {
    lines.push(`Context: ${formatInt(snapshot.usedContextTokens)} tokens in use`);
  }

  if (
    snapshot.inputTokens !== undefined ||
    snapshot.outputTokens !== undefined ||
    snapshot.cacheReadTokens !== undefined ||
    snapshot.cacheWriteTokens !== undefined
  ) {
    lines.push(
      `Turn usage: input ${formatMaybe(snapshot.inputTokens)}, output ${formatMaybe(snapshot.outputTokens)}, cache read ${formatMaybe(snapshot.cacheReadTokens)}, cache write ${formatMaybe(snapshot.cacheWriteTokens)}`,
    );
  }

  const breakdown = [
    snapshot.systemTokens !== undefined ? `system ${formatInt(snapshot.systemTokens)}` : undefined,
    snapshot.conversationTokens !== undefined ? `conversation ${formatInt(snapshot.conversationTokens)}` : undefined,
    snapshot.toolDefinitionsTokens !== undefined ? `tools ${formatInt(snapshot.toolDefinitionsTokens)}` : undefined,
  ].filter(Boolean);
  if (breakdown.length > 0) {
    lines.push(`Breakdown: ${breakdown.join(", ")}`);
  }

  if (snapshot.totalTokens !== undefined) {
    lines.push(`Cumulative tracked tokens: ${formatInt(snapshot.totalTokens)}`);
  }

  if (snapshot.sessionId) {
    lines.push(`ACP session: ${snapshot.sessionId}`);
  }

  if (snapshot.capturedAt) {
    lines.push(`Captured at: ${snapshot.capturedAt}`);
  }

  return `${lines.join("\n")}\n`;
}

function summarizeSnapshot(banner: string, snapshot: AgentTokenSnapshot): string {
  if (snapshot.usedContextTokens !== undefined && snapshot.contextWindowTokens !== undefined) {
    return `tokens: ${banner} ${snapshot.usedContextTokens}/${snapshot.contextWindowTokens}`;
  }

  if (snapshot.usedContextTokens !== undefined) {
    return `tokens: ${banner} ${snapshot.usedContextTokens}`;
  }

  return `tokens: ${banner}`;
}

function formatMaybe(value: number | undefined): string {
  return value === undefined ? "—" : formatInt(value);
}

function formatInt(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatPercent(used: number, total: number): string {
  if (total <= 0) {
    return "0.0%";
  }

  return `${((used / total) * 100).toFixed(1)}%`;
}

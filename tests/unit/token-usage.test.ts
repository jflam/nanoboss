import { describe, expect, test } from "bun:test";

import {
  getAgentTokenUsagePercent,
  normalizeAgentTokenUsage,
} from "@nanoboss/agent-acp";

describe("token-usage", () => {
  test("normalizes token snapshots into a stable usage shape", () => {
    const usage = normalizeAgentTokenUsage(
      {
        source: "copilot_log",
        usedContextTokens: 24236,
        contextWindowTokens: 272000,
        totalTokens: 21177,
      },
      {
        provider: "copilot",
        model: "gpt-5.4",
      },
    );

    expect(usage).toEqual({
      provider: "copilot",
      model: "gpt-5.4",
      sessionId: undefined,
      source: "copilot_log",
      capturedAt: undefined,
      currentContextTokens: 24236,
      maxContextTokens: 272000,
      systemTokens: undefined,
      conversationTokens: undefined,
      toolDefinitionsTokens: undefined,
      inputTokens: undefined,
      outputTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      totalTrackedTokens: 21177,
    });
    if (!usage) {
      throw new Error("expected usage to be defined");
    }

    expect(getAgentTokenUsagePercent(usage)).toBeCloseTo(8.9102941176, 6);
  });
});

import { describe, expect, test } from "bun:test";

import modelProcedure from "../../commands/model.ts";

describe("/model command", () => {
  test("shows the last observed default-session context window when available", async () => {
    const result = await modelProcedure.execute("", {
      getDefaultAgentConfig: () => ({
        provider: "codex",
        command: "codex-acp",
        args: [],
        model: "gpt-5.2-codex",
        reasoningEffort: "xhigh",
      }),
      getDefaultAgentTokenUsage: async () => ({
        source: "acp_usage_update",
        currentContextTokens: 12824,
        maxContextTokens: 258400,
      }),
    } as any);

    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
    expect((result as { display: string }).display).toContain(
      "Last observed context: 12,824 / 258,400 tokens (5.0%)",
    );
    expect((result as { display: string }).display).toContain("Context source: acp_usage_update");
  });
});

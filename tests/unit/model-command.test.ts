import { describe, expect, test } from "bun:test";

import modelProcedure from "../../packages/model.ts";
import type { CommandContext, DownstreamAgentConfig } from "../../src/core/types.ts";

describe("/model command", () => {
  test("shows the last observed default-session context window when available", async () => {
    const result = await modelProcedure.execute("", createMockContext());

    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
    expect((result as { display: string }).display).toContain(
      "Last observed context: 12,824 / 258,400 tokens (5.0%)",
    );
    expect((result as { display: string }).display).toContain("Context source: acp_usage_update");
  });
});

function createMockContext(): CommandContext {
  const defaultAgentConfig: DownstreamAgentConfig = {
    provider: "codex",
    command: "codex-acp",
    args: [],
    model: "gpt-5.2-codex",
    reasoningEffort: "xhigh",
  };

  return {
    cwd: process.cwd(),
    sessionId: "test-session",
    refs: {
      async read() {
        throw new Error("Not implemented in test");
      },
      async stat() {
        throw new Error("Not implemented in test");
      },
      async writeToFile() {
        throw new Error("Not implemented in test");
      },
    },
    session: {
      async recent() {
        return [];
      },
      async topLevelRuns() {
        return [];
      },
      async get() {
        throw new Error("Not implemented in test");
      },
      async ancestors() {
        return [];
      },
      async descendants() {
        return [];
      },
    },
    getDefaultAgentConfig() {
      return defaultAgentConfig;
    },
    setDefaultAgentSelection() {
      return defaultAgentConfig;
    },
    async getDefaultAgentTokenSnapshot() {
      return undefined;
    },
    async getDefaultAgentTokenUsage() {
      return {
        source: "acp_usage_update",
        currentContextTokens: 12824,
        maxContextTokens: 258400,
      };
    },
    callAgent: (async () => {
      throw new Error("Not implemented in test");
    }) as CommandContext["callAgent"],
    async callProcedure() {
      throw new Error("Not implemented in test");
    },
    async continueDefaultSession() {
      throw new Error("Not implemented in test");
    },
    print() {},
  };
}

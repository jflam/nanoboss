import { describe, expect, test } from "bun:test";

import modelProcedure from "../../procedures/model.ts";
import type { ProcedureApi, DownstreamAgentConfig } from "../../src/core/types.ts";

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

function createMockContext(): ProcedureApi {
  const defaultAgentConfig: DownstreamAgentConfig = {
    provider: "codex",
    command: "codex-acp",
    args: [],
    model: "gpt-5.2-codex",
    reasoningEffort: "xhigh",
  };
  const refs: ProcedureApi["state"]["refs"] = {
    async read() {
      throw new Error("Not implemented in test");
    },
    async stat() {
      throw new Error("Not implemented in test");
    },
    async writeToFile() {
      throw new Error("Not implemented in test");
    },
  };
  const runs: ProcedureApi["state"]["runs"] = {
    async recent() {
      return [];
    },
    async latest() {
      return undefined;
    },
    async topLevelRuns() {
      return [];
    },
    async get() {
      throw new Error("Not implemented in test");
    },
    async parent() {
      return undefined;
    },
    async children() {
      return [];
    },
    async ancestors() {
      return [];
    },
    async descendants() {
      return [];
    },
  };
  const agent: ProcedureApi["agent"] = {
    run: (async () => {
      throw new Error("Not implemented in test");
    }) as ProcedureApi["agent"]["run"],
    session() {
      return {
        run: (async () => {
          throw new Error("Not implemented in test");
        }) as ProcedureApi["agent"]["run"],
      };
    },
  };
  const procedures: ProcedureApi["procedures"] = {
    async run() {
      throw new Error("Not implemented in test");
    },
  };
  const ui: ProcedureApi["ui"] = {
    text() {},
    info() {},
    warning() {},
    error() {},
    status() {},
    card() {},
  };

  return {
    cwd: process.cwd(),
    sessionId: "test-session",
    agent,
    state: {
      runs,
      refs,
    },
    ui,
    procedures,
    session: {
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
    },
    assertNotCancelled() {},
  };
}

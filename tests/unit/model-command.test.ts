import { describe, expect, test } from "bun:test";

import modelProcedure, { createModelProcedure } from "../../procedures/model.ts";
import type { DownstreamAgentConfig, ProcedureApi } from "@nanoboss/procedure-sdk";

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

  test("surfaces provider refresh failures instead of falling back to the static model catalog", async () => {
    const procedure = createModelProcedure({
      discoverAgentCatalog: async () => {
        throw new Error("probe offline");
      },
    });

    for (const prompt of ["copilot", "copilot gpt-5.4/xhigh"]) {
      const result = await procedure.execute(prompt, createMockContext());

      expect(result).toBeDefined();
      expect(typeof result).toBe("object");
      expect((result as { display: string }).display).toContain(
        "Failed to refresh models from copilot harness: probe offline",
      );
      expect((result as { display: string }).display).toContain(
        "Use `/model copilot` to retry model discovery.",
      );
      expect((result as { summary: string }).summary).toBe("model: refresh copilot failed");
      expect((result as { display: string }).display).not.toContain("gpt-5.4");
    }
  });

  test("lists discovered model options from the refreshed provider catalog", async () => {
    const procedure = createModelProcedure({
      discoverAgentCatalog: async () => ({
        provider: "copilot",
        label: "Copilot",
        models: [
          {
            id: "gpt-4.1",
            name: "GPT-4.1",
            description: "Fast chat model",
          },
          {
            id: "gpt-5.4",
            name: "GPT-5.4",
            description: "Primary frontier model",
            supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
            defaultReasoningEffort: "medium",
          },
          {
            id: "claude-opus-4.7",
            name: "Claude Opus 4.7",
            description: "Premium reasoning model",
            supportedReasoningEfforts: ["low", "medium", "high"],
            defaultReasoningEffort: "high",
          },
        ],
      }),
    });

    const result = await procedure.execute("copilot", createMockContext());

    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
    expect((result as { display: string }).display).toContain(
      "- gpt-4.1 — Fast chat model",
    );
    expect((result as { display: string }).display).toContain(
      "- gpt-5.4/xhigh — Primary frontier model. Maximum reasoning depth",
    );
    expect((result as { display: string }).display).toContain(
      "- claude-opus-4.7/high — Premium reasoning model. More thorough reasoning, slower responses",
    );
    expect((result as { display: string }).display).not.toContain("goldeneye");
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
    async list() {
      return [];
    },
    async get() {
      throw new Error("Not implemented in test");
    },
    async getAncestors() {
      return [];
    },
    async getDescendants() {
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
    panel() {},
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

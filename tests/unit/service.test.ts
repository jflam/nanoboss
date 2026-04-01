import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProcedureRegistry } from "../../src/registry.ts";
import { NanoAgentBossService } from "../../src/service.ts";

async function withMockAgentEnv(run: () => Promise<void>): Promise<void> {
  const originalCommand = process.env.NANO_AGENTBOSS_AGENT_CMD;
  const originalArgs = process.env.NANO_AGENTBOSS_AGENT_ARGS;
  const originalModel = process.env.NANO_AGENTBOSS_AGENT_MODEL;

  process.env.NANO_AGENTBOSS_AGENT_CMD = "bun";
  process.env.NANO_AGENTBOSS_AGENT_ARGS = JSON.stringify(["run", "tests/fixtures/mock-agent.ts"]);
  delete process.env.NANO_AGENTBOSS_AGENT_MODEL;

  try {
    await run();
  } finally {
    if (originalCommand === undefined) {
      delete process.env.NANO_AGENTBOSS_AGENT_CMD;
    } else {
      process.env.NANO_AGENTBOSS_AGENT_CMD = originalCommand;
    }

    if (originalArgs === undefined) {
      delete process.env.NANO_AGENTBOSS_AGENT_ARGS;
    } else {
      process.env.NANO_AGENTBOSS_AGENT_ARGS = originalArgs;
    }

    if (originalModel === undefined) {
      delete process.env.NANO_AGENTBOSS_AGENT_MODEL;
    } else {
      process.env.NANO_AGENTBOSS_AGENT_MODEL = originalModel;
    }
  }
}

describe("NanoAgentBossService", () => {
  test("does not duplicate final display when the same text was already streamed", async () => {
    const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-service-")));
    registry.register({
      name: "default",
      description: "test default",
      async execute(_prompt, ctx) {
        ctx.print("4");
        return {
          display: "4",
        };
      },
    });

    const service = new NanoAgentBossService(registry);
    const session = service.createSession({ cwd: process.cwd() });

    await service.prompt(session.sessionId, "what is 2+2");

    const events = service.getSessionEvents(session.sessionId)?.after(-1) ?? [];
    const textEvents = events.filter((event) => event.type === "text_delta");

    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]?.data.text).toBe("4");
  });

  test("nested callAgent tool events remain visible when text streaming is disabled", async () => {
    await withMockAgentEnv(async () => {
      const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-service-")));
      registry.register({
        name: "probe",
        description: "test nested tool trace forwarding",
        async execute(_prompt, ctx) {
          await ctx.callAgent("nested tool trace demo", { stream: false });
          return {
            display: "done",
          };
        },
      });

      const service = new NanoAgentBossService(registry);
      const session = service.createSession({ cwd: process.cwd() });

      await service.prompt(session.sessionId, "/probe");

      const events = service.getSessionEvents(session.sessionId)?.after(-1) ?? [];
      const toolTitles = events
        .filter((event) => event.type === "tool_started")
        .map((event) => event.data.title);
      const textEvents = events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.data.text);

      expect(toolTitles).toContain("Mock read README.md");
      expect(toolTitles.some((title) => title.startsWith("callAgent:"))).toBe(true);
      expect(textEvents).toEqual(["done"]);
    });
  }, 30_000);

  test("/model updates the session default agent banner", async () => {
    const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-service-")));
    registry.loadBuiltins();

    const service = new NanoAgentBossService(registry);
    const session = service.createSession({ cwd: process.cwd() });

    await service.prompt(session.sessionId, "/model copilot gpt-5.4/xhigh");

    expect(service.getSession(session.sessionId)?.agentLabel).toBe("copilot/gpt-5.4/x-high");
  });

  test("createSession accepts an inherited default agent selection", () => {
    const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-service-")));
    registry.loadBuiltins();

    const service = new NanoAgentBossService(registry);
    const session = service.createSession({
      cwd: process.cwd(),
      defaultAgentSelection: {
        provider: "copilot",
        model: "gpt-5.4/xhigh",
      },
    });

    expect(session.agentLabel).toBe("copilot/gpt-5.4/x-high");
    expect(session.defaultAgentSelection).toEqual({
      provider: "copilot",
      model: "gpt-5.4/xhigh",
    });
  });
});

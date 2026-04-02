import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProcedureRegistry } from "../../src/registry.ts";
import { NanobossService } from "../../src/service.ts";

async function withMockAgentEnv(run: () => Promise<void>): Promise<void> {
  const originalCommand = process.env.NANOBOSS_AGENT_CMD;
  const originalArgs = process.env.NANOBOSS_AGENT_ARGS;
  const originalModel = process.env.NANOBOSS_AGENT_MODEL;

  process.env.NANOBOSS_AGENT_CMD = "bun";
  process.env.NANOBOSS_AGENT_ARGS = JSON.stringify(["run", "tests/fixtures/mock-agent.ts"]);
  delete process.env.NANOBOSS_AGENT_MODEL;

  try {
    await run();
  } finally {
    if (originalCommand === undefined) {
      delete process.env.NANOBOSS_AGENT_CMD;
    } else {
      process.env.NANOBOSS_AGENT_CMD = originalCommand;
    }

    if (originalArgs === undefined) {
      delete process.env.NANOBOSS_AGENT_ARGS;
    } else {
      process.env.NANOBOSS_AGENT_ARGS = originalArgs;
    }

    if (originalModel === undefined) {
      delete process.env.NANOBOSS_AGENT_MODEL;
    } else {
      process.env.NANOBOSS_AGENT_MODEL = originalModel;
    }
  }
}

describe("NanobossService", () => {
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

    const service = new NanobossService(registry);
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

      const service = new NanobossService(registry);
      const session = service.createSession({ cwd: process.cwd() });

      await service.prompt(session.sessionId, "/probe");

      const events = service.getSessionEvents(session.sessionId)?.after(-1) ?? [];
      const toolTitles = events
        .filter((event) => event.type === "tool_started")
        .map((event) => event.data.title);
      const textEvents = events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.data.text);
      const tokenUsageEvents = events.filter((event) => event.type === "token_usage");
      const completed = events.findLast((event) => event.type === "run_completed" && event.data.procedure === "probe");

      expect(toolTitles).toContain("Mock read README.md");
      expect(toolTitles.some((title) => title.startsWith("callAgent:"))).toBe(true);
      expect(textEvents).toEqual(["done"]);
      expect(tokenUsageEvents).toHaveLength(1);
      expect(tokenUsageEvents[0]?.data.usage).toEqual({
        source: "acp_usage_update",
        currentContextTokens: 512,
        maxContextTokens: 8192,
      });
      expect(completed?.type).toBe("run_completed");
      expect(completed?.data.tokenUsage).toEqual({
        source: "acp_usage_update",
        currentContextTokens: 512,
        maxContextTokens: 8192,
      });
    });
  }, 30_000);

  test("/model updates the session default agent banner", async () => {
    const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-service-")));
    registry.loadBuiltins();

    const service = new NanobossService(registry);
    const session = service.createSession({ cwd: process.cwd() });

    await service.prompt(session.sessionId, "/model copilot gpt-5.4/xhigh");

    expect(service.getSession(session.sessionId)?.agentLabel).toBe("copilot/gpt-5.4/x-high");
  });

  test("createSession accepts an inherited default agent selection", () => {
    const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-service-")));
    registry.loadBuiltins();

    const service = new NanobossService(registry);
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

  test("createSession honors an explicit session id", () => {
    const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-service-")));
    registry.loadBuiltins();

    const service = new NanobossService(registry);
    const session = service.createSession({
      cwd: process.cwd(),
      sessionId: "session-from-client",
    });

    expect(session.sessionId).toBe("session-from-client");
    expect(service.getSession("session-from-client")?.sessionId).toBe("session-from-client");
  });

  test("createSession exposes session inspection commands on the parent command surface", () => {
    const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-service-")));
    registry.loadBuiltins();

    const service = new NanobossService(registry);
    const session = service.createSession({ cwd: process.cwd() });

    expect(session.commands.some((command) => command.name === "top_level_runs")).toBe(true);
    expect(session.commands.some((command) => command.name === "cell_get")).toBe(true);
    expect(session.commands.some((command) => command.name === "ref_read")).toBe(true);
  });

  test("session inspection commands can read current-session results", async () => {
    const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-service-")));
    registry.loadBuiltins();
    registry.register({
      name: "review",
      description: "store a durable review result",
      async execute(prompt) {
        return {
          data: {
            subject: prompt,
            verdict: "mixed",
          },
          display: "review stored",
          summary: `review ${prompt}`,
        };
      },
    });

    const service = new NanobossService(registry);
    const session = service.createSession({ cwd: process.cwd() });

    await service.prompt(session.sessionId, "/review patch");

    const events = service.getSessionEvents(session.sessionId)?.after(-1) ?? [];
    const runCompleted = events.findLast((event) => event.type === "run_completed" && event.data.procedure === "review");
    const cell = runCompleted?.type === "run_completed" ? runCompleted.data.cell : undefined;

    expect(cell).toBeDefined();

    await service.prompt(session.sessionId, `/ref_read session=${session.sessionId} cell=${cell?.cellId} path=output.data`);

    const afterRefRead = service.getSessionEvents(session.sessionId)?.after(-1) ?? [];
    const text = afterRefRead
      .filter((event) => event.type === "text_delta")
      .map((event) => event.data.text)
      .join("");

    expect(text).toContain("\"subject\": \"patch\"");
    expect(text).toContain("\"verdict\": \"mixed\"");
  });
});

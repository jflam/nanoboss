import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MOCK_AGENT_PATH = join(process.cwd(), "tests/fixtures/mock-agent.ts");
const SELF_COMMAND_PATH = join(process.cwd(), "dist", "nanoboss");

import { DefaultConversationSession } from "../../src/agent/default-session.ts";
import { ProcedureRegistry } from "../../src/procedure/registry.ts";
import { extractProcedureDispatchResult, NanobossService } from "../../src/core/service.ts";

beforeAll(() => {
  const build = spawnSync("bun", ["run", "build"], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    stdio: "pipe",
  });

  if (build.status !== 0) {
    throw new Error([build.stdout, build.stderr].filter(Boolean).join("\n"));
  }

  process.env.NANOBOSS_SELF_COMMAND = SELF_COMMAND_PATH;
});

afterAll(() => {
  delete process.env.NANOBOSS_SELF_COMMAND;
});

async function withMockAgentEnv(
  run: () => Promise<void>,
  extraEnv: Record<string, string | undefined> = {},
): Promise<void> {
  const trackedKeys = [
    "NANOBOSS_AGENT_CMD",
    "NANOBOSS_AGENT_ARGS",
    "NANOBOSS_AGENT_MODEL",
    "NANOBOSS_SELF_COMMAND",
    ...Object.keys(extraEnv),
  ];
  const originalEnv = new Map<string, string | undefined>(
    trackedKeys.map((key) => [key, process.env[key]]),
  );

  process.env.NANOBOSS_AGENT_CMD = "bun";
  process.env.NANOBOSS_AGENT_ARGS = JSON.stringify(["run", MOCK_AGENT_PATH]);
  delete process.env.NANOBOSS_AGENT_MODEL;
  process.env.NANOBOSS_SELF_COMMAND = SELF_COMMAND_PATH;

  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await run();
  } finally {
    for (const [key, value] of originalEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function createRegistryWithWorkspace(commandFiles: Record<string, string> = {}): Promise<{
  cwd: string;
  registry: ProcedureRegistry;
}> {
  const cwd = mkdtempSync(join(tmpdir(), "nab-workspace-"));
  const commandsDir = join(cwd, "commands");
  mkdirSync(commandsDir, { recursive: true });

  for (const [name, content] of Object.entries(commandFiles)) {
    writeFileSync(join(commandsDir, `${name}.ts`), content, "utf8");
  }

  const registry = new ProcedureRegistry(commandsDir);
  registry.loadBuiltins();
  await registry.loadFromDisk();
  return { cwd, registry };
}

function readStoredMockSession(sessionStoreDir: string): {
  turns: Array<{ role: "user" | "assistant"; text: string }>;
} {
  const files = readdirSync(sessionStoreDir).filter((file) => file.endsWith(".json"));
  expect(files).toHaveLength(1);
  const fileName = files[0];
  if (!fileName) {
    throw new Error("Expected stored mock session file");
  }

  return JSON.parse(readFileSync(join(sessionStoreDir, fileName), "utf8")) as {
    turns: Array<{ role: "user" | "assistant"; text: string }>;
  };
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 5_000,
  message = "Timed out waiting for condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await Bun.sleep(20);
  }

  throw new Error(message);
}

describe("NanobossService", () => {
  test("extracts async procedure dispatch results from copilot-style tool payloads", () => {
    const parsed = extractProcedureDispatchResult([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_123",
        status: "completed",
        rawOutput: {
          content: '{"dispatchId":"dispatch_123","status":"completed","procedure":"research","result":{"procedure":"research","cell":{"sessionId":"s1","cellId":"c1"},"display":"done"}}',
          detailedContent: '{"dispatchId":"dispatch_123","status":"completed","procedure":"research","result":{"procedure":"research","cell":{"sessionId":"s1","cellId":"c1"},"display":"done"}}',
          contents: [
            {
              type: "text",
              text: '{"dispatchId":"dispatch_123","status":"completed","procedure":"research","result":{"procedure":"research","cell":{"sessionId":"s1","cellId":"c1"},"display":"done"}}',
            },
          ],
        },
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: '{"dispatchId":"dispatch_123","status":"completed","procedure":"research","result":{"procedure":"research","cell":{"sessionId":"s1","cellId":"c1"},"display":"done"}}',
            },
          },
        ],
      } as never,
    ]);

    expect(parsed).toEqual({
      procedure: "research",
      cell: { sessionId: "s1", cellId: "c1" },
      display: "done",
    });
  });

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

  test("reconstructed resume replays the persisted frontend transcript trace", async () => {
    const tempHome = mkdtempSync(join(tmpdir(), "nab-resume-history-home-"));
    const sessionStoreDir = mkdtempSync(join(tmpdir(), "nab-resume-history-agent-"));

    await withMockAgentEnv(async () => {
      const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-resume-history-reg-")));
      registry.loadBuiltins();
      const createService = () => new NanobossService(registry);

      const service = createService();
      const session = service.createSession({ cwd: process.cwd() });

      try {
        await service.prompt(session.sessionId, "nested tool trace demo");
        const liveReplay = normalizeReplayEvents(
          service.getSessionEvents(session.sessionId)?.after(-1) ?? [],
        );
        const liveCompletedAt = liveReplay.findLast((event) => event.type === "run_completed")?.data.completedAt;

        expect(liveReplay.some((event) => event.type === "tool_started")).toBe(true);
        expect(liveReplay.some((event) => event.type === "text_delta")).toBe(true);
        expect(typeof liveCompletedAt).toBe("string");

        service.destroySession(session.sessionId);

        const resumedService = createService();
        resumedService.resumeSession({
          sessionId: session.sessionId,
          cwd: process.cwd(),
        });

        const resumedEvents = resumedService.getSessionEvents(session.sessionId)?.after(-1) ?? [];
        const restored = resumedEvents.find((event) => event.type === "run_restored");
        const commandsUpdated = resumedEvents.find((event) => event.type === "commands_updated");

        expect(restored).toEqual({
          sessionId: session.sessionId,
          seq: 1,
          type: "run_restored",
          data: {
            runId: expect.any(String),
            procedure: "default",
            prompt: "nested tool trace demo",
            completedAt: liveCompletedAt,
            cell: {
              sessionId: session.sessionId,
              cellId: expect.any(String),
            },
            status: "complete",
          },
        });
        expect(normalizeReplayEvents(resumedEvents.slice(1))).toEqual(liveReplay);
        expect(commandsUpdated?.type).toBe("commands_updated");
      } finally {
        service.destroySession(session.sessionId);
      }
    }, {
      HOME: tempHome,
      MOCK_AGENT_SUPPORT_LOAD_SESSION: "1",
      MOCK_AGENT_SESSION_STORE_DIR: sessionStoreDir,
    });
  }, 30_000);

  test("reconstructed resume preserves cancelled runs as cancelled", async () => {
    const sessionStoreDir = mkdtempSync(join(tmpdir(), "nab-resume-cancelled-agent-"));

    await withMockAgentEnv(async () => {
      const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-resume-cancelled-reg-")));
      registry.loadBuiltins();
      const createService = () => new NanobossService(registry);

      const service = createService();
      const session = service.createSession({ cwd: process.cwd() });

      try {
        const promptPromise = service.prompt(session.sessionId, "cooperative cancel demo");

        await waitForCondition(() => {
          const events = service.getSessionEvents(session.sessionId)?.after(-1) ?? [];
          return events.some((event) => event.type === "run_started");
        });

        const runStarted = service.getSessionEvents(session.sessionId)?.after(-1)
          .findLast((event) => event.type === "run_started");
        if (runStarted?.type !== "run_started") {
          throw new Error("Missing run_started event");
        }

        service.cancel(session.sessionId, runStarted.data.runId);
        await promptPromise;

        const liveReplay = normalizeReplayEvents(
          service.getSessionEvents(session.sessionId)?.after(-1) ?? [],
        );
        const liveCancelledAt = liveReplay.findLast((event) => event.type === "run_cancelled")?.data.completedAt;
        expect(liveReplay.some((event) => event.type === "run_cancelled")).toBe(true);
        expect(typeof liveCancelledAt).toBe("string");

        service.destroySession(session.sessionId);

        const resumedService = createService();
        resumedService.resumeSession({
          sessionId: session.sessionId,
          cwd: process.cwd(),
        });

        const resumedEvents = resumedService.getSessionEvents(session.sessionId)?.after(-1) ?? [];
        const restored = resumedEvents.find((event) => event.type === "run_restored");

        expect(restored).toEqual({
          sessionId: session.sessionId,
          seq: 1,
          type: "run_restored",
          data: {
            runId: runStarted.data.runId,
            procedure: "default",
            prompt: "cooperative cancel demo",
            completedAt: liveCancelledAt,
            cell: {
              sessionId: session.sessionId,
              cellId: expect.any(String),
            },
            status: "cancelled",
          },
        });
        expect(normalizeReplayEvents(resumedEvents.slice(1))).toEqual(liveReplay);
      } finally {
        service.destroySession(session.sessionId);
      }
    }, {
      MOCK_AGENT_SUPPORT_LOAD_SESSION: "1",
      MOCK_AGENT_SESSION_STORE_DIR: sessionStoreDir,
      MOCK_AGENT_COOPERATIVE_CANCEL: "1",
    });
  }, 30_000);

  test("slash commands dispatch through async procedure dispatch tools inside the default session", async () => {
    await withMockAgentEnv(async () => {
      const { cwd, registry } = await createRegistryWithWorkspace({
        probe: [
          "export default {",
          '  name: "probe",',
          '  description: "test procedure dispatch",',
          '  async execute(_prompt, ctx) {',
          '    await ctx.callAgent("nested tool trace demo", { stream: false });',
          '    return { display: "done" };',
          '  },',
          "};",
        ].join("\n"),
      });

      const service = new NanobossService(registry);
      const session = service.createSession({ cwd });

      await service.prompt(session.sessionId, "/probe");

      const events = service.getSessionEvents(session.sessionId)?.after(-1) ?? [];
      const toolTitles = events
        .filter((event) => event.type === "tool_started")
        .map((event) => event.data.title);
      const textEvents = events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.data.text);
      const completed = events.findLast((event) => event.type === "run_completed" && event.data.procedure === "probe");

      expect(toolTitles).toContain("procedure_dispatch_start");
      expect(toolTitles).toContain("procedure_dispatch_wait");
      expect(toolTitles).toContain("Mock read README.md");
      expect(textEvents).toContain("done");
      expect(completed?.type).toBe("run_completed");
      expect(completed?.data.tokenUsage).toMatchObject({
        source: "acp_usage_update",
        currentContextTokens: 512,
        maxContextTokens: 8192,
      });
      expect(completed?.data.tokenUsage?.sessionId).toEqual(expect.any(String));
    });
  }, 30_000);

  test("streams async dispatch assistant progress before the final slash-command result", async () => {
    await withMockAgentEnv(async () => {
      const { cwd, registry } = await createRegistryWithWorkspace({
        slowreview: [
          "export default {",
          '  name: "slowreview",',
          '  description: "slow async procedure",',
          '  async execute(prompt) {',
          '    await Bun.sleep(200);',
          '    return {',
          '      display: `completed: ${prompt}`,',
          '    };',
          '  },',
          "};",
        ].join("\n"),
      });

      const service = new NanobossService(registry);
      const session = service.createSession({ cwd });

      try {
        await service.prompt(session.sessionId, "/slowreview patch");

        const events = service.getSessionEvents(session.sessionId)?.after(-1) ?? [];
        const firstProgressIndex = events.findIndex((event) => event.type === "text_delta" && event.data.text.includes("Running the dispatch through the global nanoboss MCP implementation"));
        const completedIndex = events.findIndex((event) => event.type === "run_completed" && event.data.procedure === "slowreview");

        expect(firstProgressIndex).toBeGreaterThanOrEqual(0);
        expect(completedIndex).toBeGreaterThan(firstProgressIndex);
      } finally {
        service.destroySession(session.sessionId);
      }
    }, {
      MOCK_AGENT_STREAM_ASYNC_DISPATCH_PROGRESS: "1",
    });
  }, 30_000);

  test("recovers async dispatch completion when the provider omits the terminal structured tool payload", async () => {
    await withMockAgentEnv(async () => {
      const { cwd, registry } = await createRegistryWithWorkspace({
        slowreview: [
          "export default {",
          '  name: "slowreview",',
          '  description: "slow async procedure",',
          '  async execute(prompt) {',
          '    await Bun.sleep(50);',
          '    return {',
          '      data: { subject: prompt, verdict: "completed" },',
          '      display: `completed: ${prompt}`,',
          '      summary: `completed ${prompt}`,',
          '      memory: `Completed durable result for ${prompt}.`,',
          '    };',
          '  },',
          "};",
        ].join("\n"),
      });

      const service = new NanobossService(registry);
      const session = service.createSession({ cwd });

      try {
        await service.prompt(session.sessionId, "/slowreview patch");

        const events = service.getSessionEvents(session.sessionId)?.after(-1) ?? [];
        const completed = events.findLast((event) => event.type === "run_completed" && event.data.procedure === "slowreview");
        const failed = events.findLast((event) => event.type === "run_failed" && event.data.procedure === "slowreview");

        expect(completed?.type).toBe("run_completed");
        expect(completed?.data.display).toBe("completed: patch");
        expect(failed).toBeUndefined();
      } finally {
        service.destroySession(session.sessionId);
      }
    }, {
      MOCK_AGENT_STRIP_ASYNC_WAIT_RAW_OUTPUT: "1",
    });
  }, 30_000);

  test.skip("long-running slash commands survive short per-request MCP deadlines via async dispatch polling", async () => {
    const sessionStoreDir = mkdtempSync(join(tmpdir(), "nab-service-recovery-agent-"));
    const { cwd, registry } = await createRegistryWithWorkspace({
      slowreview: [
        "export default {",
        '  name: "slowreview",',
        '  description: "slow async procedure",',
        '  async execute(prompt) {',
        '    await Bun.sleep(200);',
        '    return {',
        '      data: { subject: prompt, verdict: "completed" },',
        '      display: `completed: ${prompt}`,',
        '      summary: `completed ${prompt}`,',
        '      memory: `Completed durable result for ${prompt}.`,',
        '    };',
        '  },',
        "};",
      ].join("\n"),
    });

    const service = new NanobossService(
      registry,
      (workspaceCwd) => ({
        provider: "copilot",
        command: "bun",
        args: ["run", MOCK_AGENT_PATH],
        cwd: workspaceCwd,
        env: {
          NANOBOSS_SELF_COMMAND: SELF_COMMAND_PATH,
          MOCK_AGENT_SESSION_STORE_DIR: sessionStoreDir,
          MOCK_AGENT_PROCEDURE_DISPATCH_TIMEOUT_MS: "150",
        },
      }),
    );
    const session = service.createSession({ cwd });

    try {
      await service.prompt(session.sessionId, "/slowreview patch");
      await service.prompt(session.sessionId, "what mattered most?");

      const events = service.getSessionEvents(session.sessionId)?.after(-1) ?? [];
      const completed = events.findLast((event) => event.type === "run_completed" && event.data.procedure === "slowreview");
      const diagnostics = events.findLast((event) => event.type === "prompt_diagnostics");
      const stored = readStoredMockSession(sessionStoreDir);
      const promptTexts = stored.turns.filter((turn) => turn.role === "user").map((turn) => turn.text);

      expect(completed?.type).toBe("run_completed");
      expect(completed?.data.display).toBe("completed: patch");
      expect(completed?.data.tokenUsage).toMatchObject({
        source: "acp_usage_update",
        currentContextTokens: 512,
        maxContextTokens: 8192,
      });
      expect(promptTexts.some((text) => text.includes("Nanoboss internal recovered procedure synchronization."))).toBe(false);
      expect(diagnostics?.type).toBe("prompt_diagnostics");
      expect(diagnostics?.data.diagnostics.guidanceTokens).toBeUndefined();
      expect(diagnostics?.data.diagnostics.memoryCardsTokens).toBeUndefined();
    } finally {
      service.destroySession(session.sessionId);
    }
  }, 30_000);

  test("publishes prompt diagnostics for openai-compatible default prompts without steady-state retrieval guidance after slash dispatch", async () => {
    const { cwd, registry } = await createRegistryWithWorkspace({
      review: [
        "export default {",
        '  name: "review",',
        '  description: "store a durable review result",',
        '  async execute(prompt) {',
        '    return {',
        '      data: { subject: prompt, verdict: "mixed" },',
        '      display: "review output",',
        '      summary: `review summary for ${prompt}`,',
        '      memory: `Most important issue for ${prompt} was missing edge-case analysis.`,',
        '    };',
        '  },',
        "};",
      ].join("\n"),
    });

    const service = new NanobossService(
      registry,
      (cwd) => ({
        provider: "copilot",
        command: "bun",
        args: ["run", MOCK_AGENT_PATH],
        cwd,
      }),
    );
    const session = service.createSession({ cwd });

    try {
      await service.prompt(session.sessionId, "/review the code");
      await service.prompt(session.sessionId, "what mattered most?");

      const events = service.getSessionEvents(session.sessionId)?.after(-1) ?? [];
      const storedCard = events.find((event) => event.type === "memory_card_stored");
      const memoryCards = events.find((event) => event.type === "memory_cards");
      const diagnostics = events.find((event) => event.type === "prompt_diagnostics");

      expect(storedCard?.type).toBe("memory_card_stored");
      expect(storedCard?.data.card.estimatedPromptTokens).toBeGreaterThan(0);
      expect(memoryCards).toBeUndefined();
      expect(diagnostics?.type).toBe("prompt_diagnostics");
      expect(diagnostics?.data.diagnostics.method).toBe("tiktoken");
      expect(diagnostics?.data.diagnostics.encoding).toBe("o200k_base");
      expect(diagnostics?.data.diagnostics.totalTokens).toBeGreaterThan(0);
      expect(diagnostics?.data.diagnostics.memoryCardsTokens).toBeUndefined();
      expect(diagnostics?.data.diagnostics.guidanceTokens).toBeUndefined();
      expect(diagnostics?.data.diagnostics.userMessageTokens).toBeGreaterThan(0);
    } finally {
      service.destroySession(session.sessionId);
    }
  }, 30_000);

  test("/model updates the session default agent banner", async () => {
    await withMockAgentEnv(async () => {
      const { cwd, registry } = await createRegistryWithWorkspace();

      const service = new NanobossService(registry);
      const session = service.createSession({ cwd });

      await service.prompt(session.sessionId, "/model copilot gpt-5.4/xhigh");

      expect(service.getSession(session.sessionId)?.agentLabel).toBe("copilot/gpt-5.4/x-high");
    });
  }, 30_000);

  test("soft stop cancels the in-flight agent and blocks the next boundary", async () => {
    await withMockAgentEnv(async () => {
      const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-service-stop-")));
      registry.register({
        name: "default",
        description: "test soft stop boundaries",
        async execute(_prompt, ctx) {
          try {
            await ctx.callAgent("cooperative cancel demo", { stream: false });
          } catch {}
          await ctx.callAgent("second boundary should never start", { stream: false });
          return { display: "done" };
        },
      });

      const service = new NanobossService(registry);
      const session = service.createSession({ cwd: process.cwd() });
      const promptPromise = service.prompt(session.sessionId, "stop after this boundary");

      await waitForCondition(() => {
        const events = service.getSessionEvents(session.sessionId)?.after(-1) ?? [];
        return events.some((event) => event.type === "tool_started" && event.data.title.includes("cooperative cancel demo"));
      });

      const runStarted = (service.getSessionEvents(session.sessionId)?.after(-1) ?? []).findLast(
        (event) => event.type === "run_started",
      );
      if (runStarted?.type !== "run_started") {
        throw new Error("Missing run_started event");
      }

      service.cancel(session.sessionId, runStarted.data.runId);
      await promptPromise;

      const events = service.getSessionEvents(session.sessionId)?.after(-1) ?? [];
      const firstStarted = events.find(
        (event) => event.type === "tool_started" && event.data.title.includes("cooperative cancel demo"),
      );
      const firstUpdate = firstStarted?.type === "tool_started"
        ? events.findLast(
          (event) => event.type === "tool_updated" && event.data.toolCallId === firstStarted.data.toolCallId,
        )
        : undefined;
      const startedTitles = events
        .filter((event) => event.type === "tool_started")
        .map((event) => event.data.title);
      const cancelledRun = events.findLast((event) => event.type === "run_cancelled");

      expect(startedTitles.some((title) => title.includes("cooperative cancel demo"))).toBe(true);
      expect(startedTitles.some((title) => title.includes("second boundary should never start"))).toBe(false);
      expect(firstUpdate?.type).toBe("tool_updated");
      expect(firstUpdate?.data.status).toBe("cancelled");
      expect(cancelledRun?.type).toBe("run_cancelled");
      expect(cancelledRun?.data.message).toBe("Stopped.");
    }, {
      MOCK_AGENT_COOPERATIVE_CANCEL: "1",
    });
  }, 30_000);

  test("run-scoped cancel ignores stale run ids", async () => {
    const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-service-stop-")));
    registry.register({
      name: "default",
      description: "test stale stop ids",
      async execute() {
        await Bun.sleep(150);
        return { display: "done" };
      },
    });

    const service = new NanobossService(registry);
    const session = service.createSession({ cwd: process.cwd() });
    const promptPromise = service.prompt(session.sessionId, "hello");

    await waitForCondition(() => {
      const events = service.getSessionEvents(session.sessionId)?.after(-1) ?? [];
      return events.some((event) => event.type === "run_started");
    });

    service.cancel(session.sessionId, "stale-run-id");
    await promptPromise;

    const events = service.getSessionEvents(session.sessionId)?.after(-1) ?? [];
    expect(events.some((event) => event.type === "run_cancelled")).toBe(false);
    expect(events.findLast((event) => event.type === "run_completed")?.type).toBe("run_completed");
  });

  test("soft stop keeps the persistent default ACP session alive", async () => {
    await withMockAgentEnv(async () => {
      const session = new DefaultConversationSession({
        config: {
          provider: "copilot",
          command: "bun",
          args: ["run", MOCK_AGENT_PATH],
          cwd: process.cwd(),
        },
        sessionId: "soft-stop-session",
      });
      const softStopController = new AbortController();
      const promptPromise = session.prompt("cooperative cancel demo", {
        softStopSignal: softStopController.signal,
      });

      await Bun.sleep(100);
      softStopController.abort();

      await expect(promptPromise).rejects.toThrow("Stopped.");

      const persistedSessionId = session.currentSessionId;
      expect(persistedSessionId).toEqual(expect.any(String));
      await expect(session.prompt("what is 2+2")).resolves.toMatchObject({ raw: "4" });
      expect(session.currentSessionId).toBe(persistedSessionId);

      session.closeLiveSession();
    }, {
      MOCK_AGENT_COOPERATIVE_CANCEL: "1",
    });
  }, 30_000);

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
    await withMockAgentEnv(async () => {
      const { cwd, registry } = await createRegistryWithWorkspace({
        review: [
          "export default {",
          '  name: "review",',
          '  description: "store a durable review result",',
          '  async execute(prompt) {',
          '    return {',
          '      data: { subject: prompt, verdict: "mixed" },',
          '      display: "review stored",',
          '      summary: `review ${prompt}`,',
          '    };',
          '  },',
          "};",
        ].join("\n"),
      });

      const service = new NanobossService(registry);
      const session = service.createSession({ cwd });

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
  }, 30_000);
});

function normalizeReplayEvents(events: Array<{ type: string; data: Record<string, unknown> }>): Array<{
  type: string;
  data: Record<string, unknown>;
}> {
  const replayable = new Set([
    "text_delta",
    "tool_started",
    "tool_updated",
    "token_usage",
    "run_completed",
    "run_failed",
    "run_cancelled",
  ]);

  return events
    .filter((event) => replayable.has(event.type))
    .map((event) => ({
      type: event.type,
      data: event.data,
    }));
}

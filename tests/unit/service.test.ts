import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MOCK_AGENT_PATH = join(process.cwd(), "tests/fixtures/mock-agent.ts");
const SELF_COMMAND_PATH = join(process.cwd(), "dist", "nanoboss");
const BUILD_HOOK_TIMEOUT_MS = 30_000;

import { DefaultConversationSession } from "../../src/agent/default-session.ts";
import type { CellRef, Procedure } from "../../src/core/types.ts";
import { ProcedureRegistry } from "../../src/procedure/registry.ts";
import { buildProcedureDispatchJobsDir, ProcedureDispatchJobManager } from "../../src/procedure/dispatch-jobs.ts";
import { TopLevelProcedureCancelledError } from "../../src/procedure/runner.ts";
import { SessionStore } from "../../src/session/index.ts";
import { extractProcedureDispatchResult, NanobossService } from "../../src/core/service.ts";

interface InternalSessionState {
  store: SessionStore;
  defaultConversation: DefaultConversationSession;
}

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
}, BUILD_HOOK_TIMEOUT_MS);

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
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }

  try {
    await run();
  } finally {
    for (const [key, value] of originalEnv) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
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
  const procedureRoot = join(cwd, ".nanoboss", "procedures");
  mkdirSync(procedureRoot, { recursive: true });

  for (const [name, content] of Object.entries(commandFiles)) {
    const packageDir = join(procedureRoot, name);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "index.ts"), content, "utf8");
  }

  const registry = new ProcedureRegistry(procedureRoot);
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

function extractDispatchRequest(prompt: string): {
  sessionId: string;
  name: string;
  prompt: string;
  defaultAgentSelection?: unknown;
  dispatchCorrelationId?: string;
} {
  const payload = prompt
    .split("\n\n")
    .find((part) => part.trimStart().startsWith('{"sessionId"'));
  if (!payload) {
    throw new Error("Missing internal dispatch JSON payload");
  }

  return JSON.parse(payload) as {
    sessionId: string;
    name: string;
    prompt: string;
    defaultAgentSelection?: unknown;
    dispatchCorrelationId?: string;
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

function isInternalSessionState(value: unknown): value is InternalSessionState {
  return typeof value === "object"
    && value !== null
    && "store" in value
    && value.store instanceof SessionStore;
}

function getInternalSessionState(service: NanobossService, sessionId: string): InternalSessionState {
  const sessions = Reflect.get(service as object, "sessions") as unknown;
  if (!(sessions instanceof Map)) {
    throw new Error("Missing internal session map");
  }

  const sessionState: unknown = (sessions as Map<unknown, unknown>).get(sessionId);
  if (!isInternalSessionState(sessionState)) {
    throw new Error("Missing internal session state");
  }

  return sessionState;
}

function setDispatchProcedureIntoDefaultConversation(
  service: NanobossService,
  dispatch: (...args: unknown[]) => Promise<never>,
): void {
  Reflect.set(service as object, "dispatchProcedureIntoDefaultConversation", dispatch);
}

function createPausedWizardProcedure(): Procedure {
  return {
    name: "wizard",
    description: "pause and resume test procedure",
    executionMode: "harness",
    async execute(prompt) {
      return {
        display: `wizard started: ${prompt}\n`,
        pause: {
          question: "What should I do next?",
          state: {
            step: 1,
            priorPrompt: prompt,
          },
          suggestedReplies: ["apply it", "skip it", "stop"],
        },
      };
    },
    async resume(prompt, state) {
      return {
        display: `resumed with ${prompt} after ${(state as { step: number }).step} step\n`,
      };
    },
  };
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

  test("publishes a final token usage event before run completion for assistant replies", async () => {
    await withMockAgentEnv(async () => {
      const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-service-token-usage-")));
      registry.loadBuiltins();

      const service = new NanobossService(registry);
      const session = service.createSession({ cwd: process.cwd() });

      await service.prompt(session.sessionId, "what is 2+2");

      const events = service.getSessionEvents(session.sessionId)?.after(-1) ?? [];
      const completedIndex = events.findLastIndex((event) => event.type === "run_completed");
      const tokenUsageIndex = events.findLastIndex((event) => event.type === "token_usage");

      expect(completedIndex).toBeGreaterThanOrEqual(0);
      expect(tokenUsageIndex).toBe(completedIndex - 1);

      const completed = completedIndex >= 0 ? events[completedIndex] : undefined;
      const tokenUsage = tokenUsageIndex >= 0 ? events[tokenUsageIndex] : undefined;
      expect(completed?.type).toBe("run_completed");
      expect(tokenUsage?.type).toBe("token_usage");
      if (completed?.type !== "run_completed" || tokenUsage?.type !== "token_usage") {
        throw new Error("Expected final token_usage and run_completed events");
      }

      expect(tokenUsage.data.sourceUpdate).toBe("run_completed");
      expect(tokenUsage.data.usage).toEqual(completed.data.tokenUsage);
    });
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
        if (typeof liveCompletedAt !== "string") {
          throw new Error("Missing completed timestamp");
        }

        service.destroySession(session.sessionId);

        const resumedService = createService();
        resumedService.resumeSession({
          sessionId: session.sessionId,
          cwd: process.cwd(),
        });

        const resumedEvents = resumedService.getSessionEvents(session.sessionId)?.after(-1) ?? [];
        const restored = resumedEvents.find((event) => event.type === "run_restored");
        const commandsUpdated = resumedEvents.find((event) => event.type === "commands_updated");

        expect(restored?.type).toBe("run_restored");
        if (restored?.type !== "run_restored") {
          throw new Error("Missing run_restored event");
        }
        expect(restored.sessionId).toBe(session.sessionId);
        expect(restored.seq).toBe(1);
        expect(typeof restored.data.runId).toBe("string");
        expect(restored.data.procedure).toBe("default");
        expect(restored.data.prompt).toBe("nested tool trace demo");
        expect(restored.data.completedAt).toBe(liveCompletedAt);
        expect(restored.data.cell.sessionId).toBe(session.sessionId);
        expect(typeof restored.data.cell.cellId).toBe("string");
        expect(restored.data.status).toBe("complete");
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
        if (typeof liveCancelledAt !== "string") {
          throw new Error("Missing cancelled timestamp");
        }

        service.destroySession(session.sessionId);

        const resumedService = createService();
        resumedService.resumeSession({
          sessionId: session.sessionId,
          cwd: process.cwd(),
        });

        const resumedEvents = resumedService.getSessionEvents(session.sessionId)?.after(-1) ?? [];
        const restored = resumedEvents.find((event) => event.type === "run_restored");

        expect(restored?.type).toBe("run_restored");
        if (restored?.type !== "run_restored") {
          throw new Error("Missing run_restored event");
        }
        expect(restored.sessionId).toBe(session.sessionId);
        expect(restored.seq).toBe(1);
        expect(restored.data.runId).toBe(runStarted.data.runId);
        expect(restored.data.procedure).toBe("default");
        expect(restored.data.prompt).toBe("cooperative cancel demo");
        expect(restored.data.completedAt).toBe(liveCancelledAt);
        expect(restored.data.cell.sessionId).toBe(session.sessionId);
        expect(typeof restored.data.cell.cellId).toBe("string");
        expect(restored.data.status).toBe("cancelled");
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
      if (completed?.type !== "run_completed") {
        throw new Error("Missing run_completed event");
      }
      const tokenUsage = completed.data.tokenUsage;
      expect(tokenUsage).toMatchObject({
        source: "acp_usage_update",
        currentContextTokens: 512,
        maxContextTokens: 8192,
      });
      expect(typeof tokenUsage?.sessionId).toBe("string");
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

  test("keeps deterministic polling when the default session returns a non-terminal async dispatch status", async () => {
    const originalRecoveryWaitMs = process.env.NANOBOSS_PROCEDURE_DISPATCH_RECOVERY_WAIT_MS;
    process.env.NANOBOSS_PROCEDURE_DISPATCH_RECOVERY_WAIT_MS = "100";

    try {
      const { cwd, registry } = await createRegistryWithWorkspace({
        slowreview: [
          "export default {",
          '  name: "slowreview",',
          '  description: "slow async procedure",',
          '  async execute(prompt) {',
          '    await Bun.sleep(1500);',
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
      const sessionState = getInternalSessionState(service, session.sessionId);
      const manager = new ProcedureDispatchJobManager({
        cwd,
        sessionId: session.sessionId,
        rootDir: sessionState.store.rootDir,
        getRegistry: async () => registry,
      });
      const originalPrompt = sessionState.defaultConversation.prompt.bind(sessionState.defaultConversation);
      const originalGetCurrentTokenSnapshot = sessionState.defaultConversation.getCurrentTokenSnapshot
        .bind(sessionState.defaultConversation);

      Reflect.set(
        sessionState.defaultConversation as object,
        "prompt",
        async (controlPrompt: string, options: { onUpdate?: (update: unknown) => Promise<void> | void } = {}) => {
          const dispatch = extractDispatchRequest(controlPrompt);
          const startResult = await manager.start({
            name: dispatch.name,
            prompt: dispatch.prompt,
            defaultAgentSelection: dispatch.defaultAgentSelection as never,
            dispatchCorrelationId: dispatch.dispatchCorrelationId,
          });

          let runningResult = await manager.wait(startResult.dispatchId, 25);
          for (let attempt = 0; attempt < 20 && runningResult.status === "queued"; attempt += 1) {
            runningResult = await manager.wait(startResult.dispatchId, 25);
          }

          expect(runningResult.status).toBe("running");

          const updates = [
            {
              sessionUpdate: "tool_call",
              toolCallId: "dispatch-start",
              title: "procedure_dispatch_start",
              kind: "other",
              status: "pending",
              rawInput: dispatch,
            },
            {
              sessionUpdate: "tool_call_update",
              toolCallId: "dispatch-start",
              status: "completed",
              rawOutput: startResult,
            },
            {
              sessionUpdate: "tool_call",
              toolCallId: "dispatch-wait",
              title: "procedure_dispatch_wait",
              kind: "other",
              status: "pending",
              rawInput: {
                dispatchId: startResult.dispatchId,
                waitMs: 25,
              },
            },
            {
              sessionUpdate: "tool_call_update",
              toolCallId: "dispatch-wait",
              status: "completed",
              rawOutput: runningResult,
            },
          ] as const;

          for (const update of updates) {
            await options.onUpdate?.(update);
          }

          return {
            raw: JSON.stringify(runningResult),
            updates: [...updates],
            durationMs: 0,
          };
        },
      );
      Reflect.set(
        sessionState.defaultConversation as object,
        "getCurrentTokenSnapshot",
        async () => undefined,
      );

      try {
        await service.prompt(session.sessionId, "/slowreview patch");

        const events = service.getSessionEvents(session.sessionId)?.after(-1) ?? [];
        const completed = events.findLast((event) => event.type === "run_completed" && event.data.procedure === "slowreview");
        const failed = events.findLast((event) => event.type === "run_failed" && event.data.procedure === "slowreview");

        expect(completed?.type).toBe("run_completed");
        expect(completed?.data.display).toBe("completed: patch");
        expect(failed).toBeUndefined();
      } finally {
        Reflect.set(sessionState.defaultConversation as object, "prompt", originalPrompt);
        Reflect.set(
          sessionState.defaultConversation as object,
          "getCurrentTokenSnapshot",
          originalGetCurrentTokenSnapshot,
        );
        service.destroySession(session.sessionId);
      }
    } finally {
      if (originalRecoveryWaitMs === undefined) {
        delete process.env.NANOBOSS_PROCEDURE_DISPATCH_RECOVERY_WAIT_MS;
      } else {
        process.env.NANOBOSS_PROCEDURE_DISPATCH_RECOVERY_WAIT_MS = originalRecoveryWaitMs;
      }
    }
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
    } finally {
      service.destroySession(session.sessionId);
    }
  }, 30_000);

  test("does not publish local prompt estimates for default prompts after slash dispatch", async () => {
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
      expect(storedCard?.type).toBe("memory_card_stored");
      if (storedCard?.type !== "memory_card_stored") {
        throw new Error("Expected a stored memory card event");
      }
      expect(memoryCards).toBeUndefined();
      expect("estimatedPromptTokens" in storedCard.data.card).toBe(false);
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

  test("/model executes in the harness instead of dispatching through the default conversation", async () => {
    const { cwd, registry } = await createRegistryWithWorkspace();

    const service = new NanobossService(registry);
    const session = service.createSession({ cwd });
    setDispatchProcedureIntoDefaultConversation(service, async () => {
      throw new Error("/model should not use async procedure dispatch");
    });

    await service.prompt(session.sessionId, "/model copilot gpt-5.4/xhigh");

    expect(service.getSession(session.sessionId)?.agentLabel).toBe("copilot/gpt-5.4/x-high");
    const toolTitles = (service.getSessionEvents(session.sessionId)?.after(-1) ?? [])
      .filter((event) => event.type === "tool_started")
      .map((event) => event.data.title);
    expect(toolTitles).not.toContain("procedure_dispatch_start");
    expect(toolTitles).not.toContain("procedure_dispatch_wait");
  });

  test("cancelled slash-command dispatches still publish a terminal run_cancelled event", async () => {
    const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-service-dispatch-stop-")));
    registry.register({
      name: "default",
      description: "test default",
      async execute() {
        return { display: "default" };
      },
    });
    registry.register({
      name: "review",
      description: "test review",
      async execute() {
        return { display: "review" };
      },
    });

    const service = new NanobossService(registry);
    const session = service.createSession({ cwd: process.cwd() });
    const sessionState = getInternalSessionState(service, session.sessionId);

    const cancelledResult = sessionState.store.finalizeCell(
      sessionState.store.startCell({
        procedure: "review",
        input: "/review the code",
        kind: "top_level",
      }),
      {
        display: "Stopped.",
        summary: "Stopped.",
      },
    );
    const cancelledCell: CellRef = cancelledResult.cell;
    setDispatchProcedureIntoDefaultConversation(service, async () => {
      throw new TopLevelProcedureCancelledError("Stopped.", cancelledCell);
    });

    await service.prompt(session.sessionId, "/review the code");

    const events = service.getSessionEvents(session.sessionId)?.after(-1) ?? [];
    const cancelledRun = events.findLast((event) => event.type === "run_cancelled");

    expect(cancelledRun?.type).toBe("run_cancelled");
    if (cancelledRun?.type !== "run_cancelled") {
      throw new Error("Missing run_cancelled event");
    }
    expect(cancelledRun.data.message).toBe("Stopped.");
    expect(cancelledRun.data.cell).toEqual(cancelledCell);
    expect(events.some((event) => event.type === "run_failed")).toBe(false);
  });

  test("soft stop cancels the in-flight agent and blocks the next boundary", async () => {
    await withMockAgentEnv(async () => {
      const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-service-stop-")));
      registry.register({
        name: "default",
        description: "test soft stop boundaries",
        async execute(_prompt, ctx) {
          try {
            await ctx.callAgent("cooperative cancel demo", { stream: false });
          } catch {
            // Expected: the active boundary is cancelled before the next one can start.
          }
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

  test("soft stop cancels slash-command dispatch workers and their nested agents", async () => {
    await withMockAgentEnv(async () => {
      const { cwd, registry } = await createRegistryWithWorkspace({
        review: [
          "export default {",
          '  name: "review",',
          '  description: "test review",',
          "  async execute(_prompt, ctx) {",
          '    await ctx.callAgent("cooperative cancel demo", { stream: false });',
          '    return { display: "done" };',
          "  },",
          "};",
        ].join("\n"),
      });

      const service = new NanobossService(registry);
      const session = service.createSession({ cwd });
      const sessionState = getInternalSessionState(service, session.sessionId);
      const jobsDir = buildProcedureDispatchJobsDir(sessionState.store.rootDir);
      const promptPromise = service.prompt(session.sessionId, "/review stop this");

      await waitForCondition(() => {
        try {
          return readdirSync(jobsDir).some((file) => file.endsWith(".json"));
        } catch {
          return false;
        }
      }, 10_000, "Timed out waiting for procedure dispatch job");

      const runStarted = (service.getSessionEvents(session.sessionId)?.after(-1) ?? []).findLast(
        (event) => event.type === "run_started",
      );
      if (runStarted?.type !== "run_started") {
        throw new Error("Missing run_started event");
      }

      service.cancel(session.sessionId, runStarted.data.runId);
      await promptPromise;
      await waitForCondition(() => {
        const fileName = readdirSync(jobsDir).find((file) => file.endsWith(".json"));
        if (!fileName) {
          return false;
        }
        const job = JSON.parse(readFileSync(join(jobsDir, fileName), "utf8")) as { status?: string; error?: string };
        return job.status === "cancelled" && job.error === "Stopped.";
      }, 10_000, "Timed out waiting for cancelled dispatch job");

      const events = service.getSessionEvents(session.sessionId)?.after(-1) ?? [];
      const cancelledRun = events.findLast((event) => event.type === "run_cancelled");
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
      expect(typeof persistedSessionId).toBe("string");
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

  test("plain-text replies resume a paused procedure", async () => {
    const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-service-pause-")));
    registry.register(createPausedWizardProcedure());
    registry.register({
      name: "default",
      description: "test default",
      async execute(prompt) {
        return { display: `default: ${prompt}` };
      },
    });

    const service = new NanobossService(registry);
    const session = service.createSession({ cwd: process.cwd() });

    await service.prompt(session.sessionId, "/wizard first");
    let events = service.getSessionEvents(session.sessionId)?.after(-1) ?? [];
    const paused = events.findLast((event) => event.type === "run_paused");
    expect(paused?.type).toBe("run_paused");
    if (paused?.type !== "run_paused") {
      throw new Error("Expected run_paused event");
    }
    expect(paused.data.question).toContain("What should I do next");
    expect(events.some((event) => event.type === "run_completed" && event.data.procedure === "wizard")).toBe(false);

    await service.prompt(session.sessionId, "focus on dead code");

    events = service.getSessionEvents(session.sessionId)?.after(-1) ?? [];
    const completed = events.findLast((event) => event.type === "run_completed" && event.data.procedure === "wizard");
    expect(completed?.type).toBe("run_completed");
    if (completed?.type !== "run_completed") {
      throw new Error("Expected resumed run_completed event");
    }
    expect(completed.data.display).toContain("resumed with focus on dead code");
  });

  test("explicit slash commands do not consume a pending continuation", async () => {
    const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-service-pause-")));
    registry.register(createPausedWizardProcedure());
    registry.register({
      name: "default",
      description: "test default",
      async execute(prompt) {
        return { display: `default: ${prompt}` };
      },
    });

    const service = new NanobossService(registry);
    const session = service.createSession({ cwd: process.cwd() });

    await service.prompt(session.sessionId, "/wizard first");
    await service.prompt(session.sessionId, "/default hello");
    await service.prompt(session.sessionId, "resume now");

    const events = service.getSessionEvents(session.sessionId)?.after(-1) ?? [];
    const defaultCompleted = events.findLast((event) => event.type === "run_completed" && event.data.procedure === "default");
    const wizardCompleted = events.findLast((event) => event.type === "run_completed" && event.data.procedure === "wizard");

    expect(defaultCompleted?.type).toBe("run_completed");
    expect(wizardCompleted?.type).toBe("run_completed");
    if (wizardCompleted?.type !== "run_completed") {
      throw new Error("Expected wizard continuation to remain pending");
    }
    expect(wizardCompleted.data.display).toContain("resumed with resume now");
  });

  test("resumed sessions keep paused procedure continuations", async () => {
    const originalHome = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), "nab-paused-resume-home-"));

    try {
      const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-service-pause-")));
      registry.register(createPausedWizardProcedure());
      registry.register({
        name: "default",
        description: "test default",
        async execute(prompt) {
          return { display: `default: ${prompt}` };
        },
      });

      const service = new NanobossService(registry);
      const session = service.createSession({ cwd: process.cwd() });

      await service.prompt(session.sessionId, "/wizard first");

      const resumedService = new NanobossService(registry);
      resumedService.resumeSession({ sessionId: session.sessionId, cwd: process.cwd() });

      const restored = resumedService.getSessionEvents(session.sessionId)?.after(-1) ?? [];
      const restoredPaused = restored.findLast((event) => event.type === "run_restored");
      expect(restoredPaused?.type).toBe("run_restored");
      if (restoredPaused?.type !== "run_restored") {
        throw new Error("Expected restored paused run");
      }
      expect(restoredPaused.data.status).toBe("paused");

      await resumedService.prompt(session.sessionId, "keep going");

      const events = resumedService.getSessionEvents(session.sessionId)?.after(-1) ?? [];
      const completed = events.findLast((event) => event.type === "run_completed" && event.data.procedure === "wizard");
      expect(completed?.type).toBe("run_completed");
      if (completed?.type !== "run_completed") {
        throw new Error("Expected resumed completion");
      }
      expect(completed.data.display).toContain("resumed with keep going");
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });
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
    "run_paused",
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

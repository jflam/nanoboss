import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import typia from "typia";

import { createAgentSession, type AgentSession, type CreateAgentSessionParams } from "@nanoboss/agent-acp";
import {
  normalizePromptInput,
  promptInputDisplayText,
} from "@nanoboss/procedure-sdk";
import { CommandContextImpl, RunLogger } from "@nanoboss/procedure-engine";
import { resolveDownstreamAgentConfig } from "@nanoboss/procedure-engine";
import { jsonType, type DownstreamAgentConfig, type ProcedureApi, type PromptInput } from "@nanoboss/procedure-sdk";
import { ProcedureRegistry } from "@nanoboss/procedure-catalog";
import { SessionStore } from "@nanoboss/store";

interface MathResult {
  result: number;
}

function toPromptText(prompt: string | PromptInput): string {
  return typeof prompt === "string" ? prompt : promptInputDisplayText(prompt);
}

const MathResultType = jsonType<MathResult>(
  typia.json.schema<MathResult>(),
  typia.createValidate<MathResult>(),
);
const MOCK_AGENT_PATH = join(import.meta.dir, "..", "fixtures", "mock-agent.ts");

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("procedure API session namespaces", () => {
  test("typed default-session calls reuse the default transport and keep parse retries", async () => {
    let submittedCount = 0;
    const { conversation, ctx, emittedUpdates } = createContext({
      prepareDefaultPrompt: (promptInput: PromptInput) => ({
        promptInput: normalizePromptInput({
          parts: [
            {
              type: "text",
              text: `Prepared default prompt\n\nUser message:\n${promptInputDisplayText(promptInput)}`,
            },
          ],
        }),
        markSubmitted: () => {
          submittedCount += 1;
        },
      }),
    });
    const prompts: string[] = [];

    Reflect.set(conversation as object, "persistedSessionId", "default-session-1");
    Reflect.set(
      conversation as object,
      "prompt",
      async (
        prompt: string | PromptInput,
        options: { onUpdate?: (update: acp.SessionUpdate) => Promise<void> | void } = {},
      ) => {
        prompts.push(toPromptText(prompt));
        await options.onUpdate?.({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "suppressed chunk",
          },
        });

        return {
          raw: prompts.length === 1 ? "not json" : '{"result":7}',
          updates: [],
          durationMs: 0,
        };
      },
    );
    const result = await ctx.agent.run("Compute 4 + 3.", MathResultType, {
      session: "default",
      stream: false,
    });

    expect(result.data).toEqual({ result: 7 });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("Prepared default prompt");
    expect(prompts[0]).toContain("Respond ONLY with valid JSON matching this schema.");
    expect(prompts[1]).toContain("Your previous response was invalid");
    expect(submittedCount).toBe(2);
    expect(emittedUpdates.some((update) => update.sessionUpdate === "agent_message_chunk")).toBe(false);

    expect(emittedUpdates).toEqual([]);
  });

  test("untyped default-session calls use the same unified ctx.agent.run path", async () => {
    let submittedCount = 0;
    const { conversation, ctx, emittedUpdates } = createContext({
      prepareDefaultPrompt: (promptInput: PromptInput) => ({
        promptInput: normalizePromptInput({
          parts: [
            {
              type: "text",
              text: `Prepared default prompt\n\nUser message:\n${promptInputDisplayText(promptInput)}`,
            },
          ],
        }),
        markSubmitted: () => {
          submittedCount += 1;
        },
      }),
    });
    const prompts: string[] = [];

    Reflect.set(conversation as object, "persistedSessionId", "default-session-2");
    Reflect.set(
      conversation as object,
      "prompt",
      async (prompt: string | PromptInput) => {
        prompts.push(toPromptText(prompt));
        return {
          raw: "4",
          updates: [],
          durationMs: 0,
        };
      },
    );
    const result = await ctx.agent.run("What is 2 + 2?", { session: "default" });

    expect(result.data).toBe("4");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toBe("Prepared default prompt\n\nUser message:\nWhat is 2 + 2?");
    expect(submittedCount).toBe(1);

    expect(emittedUpdates).toEqual([]);
  });

  test("fresh calls can resume a persisted isolated session when requested", async () => {
    const sessionStoreDir = mkdtempSync(join(tmpdir(), "nab-mock-agent-store-"));
    tempDirs.push(sessionStoreDir);
    const { ctx } = createContext({
      configOverride: {
        env: {
          MOCK_AGENT_SUPPORT_LOAD_SESSION: "1",
          MOCK_AGENT_SESSION_STORE_DIR: sessionStoreDir,
        },
      },
    });

    const first = await ctx.agent.run("What is 2+2?", {
      stream: false,
    });
    const persistedSessionId = first.tokenUsage?.sessionId;
    const second = await ctx.agent.run("add 3 to result", {
      stream: false,
      persistedSessionId,
    });

    expect(first.data).toBe("4");
    expect(typeof persistedSessionId).toBe("string");
    expect(second.data).toBe("7");
  });

  test("ctx.procedures.run inherits the current default-session binding by default", async () => {
    const { conversation, ctx, registry } = createContext();
    const prompts: string[] = [];

    Reflect.set(conversation as object, "persistedSessionId", "default-session-procedure-inherit");
    Reflect.set(
      conversation as object,
      "prompt",
      async (prompt: string | PromptInput) => {
        prompts.push(toPromptText(prompt));
        return {
          raw: "inherited",
          updates: [],
          durationMs: 0,
        };
      },
    );

    registry.register({
      name: "child",
      description: "test child procedure",
      async execute(prompt, childCtx) {
        const reply = await childCtx.agent.run(prompt, {
          session: "default",
          stream: false,
        });
        return {
          data: reply.data,
        };
      },
    });

    const result = await ctx.procedures.run("child", "reuse the bound session");

    expect(result.data).toBe("inherited");
    expect(prompts).toEqual(["reuse the bound session"]);
  });

  test("ctx.procedures.run with session fresh gives the child a private default binding", async () => {
    const promptedSessions: AgentSession[] = [];
    let rootSession: AgentSession | undefined;
    const { conversation, ctx, registry } = createContext({
      createAgentSession: (params) => {
        const session = createAgentSession(params);
        Reflect.set(
          session as object,
          "prompt",
          async function prompt(this: AgentSession, promptText: string | PromptInput) {
            promptedSessions.push(this);
            return {
              raw: `${toPromptText(promptText)} via ${this === rootSession ? "root" : "fresh"}`,
              updates: [],
              durationMs: 0,
            };
          },
        );
        rootSession ??= session;
        return session;
      },
    });
    const rootConfigBefore = ctx.session.getDefaultAgentConfig();

    Reflect.set(conversation as object, "persistedSessionId", "default-session-root");

    registry.register({
      name: "child",
      description: "test fresh child procedure",
      async execute(prompt, childCtx) {
        childCtx.session.setDefaultAgentSelection({
          provider: "codex",
          model: "gpt-5.4/high",
        });

        const reply = await childCtx.agent.run(prompt, {
          session: "default",
          stream: false,
        });

        return {
          data: {
            reply: reply.data,
            selection: childCtx.session.getDefaultAgentConfig(),
          },
        };
      },
    });

    const result = await ctx.procedures.run<{
      reply: string;
      selection: DownstreamAgentConfig;
    }>("child", "private child session", { session: "fresh" });

    expect(result.data?.reply).toBe("private child session via fresh");
    expect(promptedSessions).toHaveLength(1);
    expect(promptedSessions[0]).not.toBe(conversation);
    expect(result.data?.selection.provider).toBe("codex");
    expect(result.data?.selection.model).toBe("gpt-5.4/high");
    expect(ctx.session.getDefaultAgentConfig()).toEqual(rootConfigBefore);
  });

  test("ctx.procedures.run with session default rebinds nested children to the master session", async () => {
    const promptedSessions: AgentSession[] = [];
    let rootSession: AgentSession | undefined;
    const { conversation, ctx, registry } = createContext({
      createAgentSession: (params) => {
        const session = createAgentSession(params);
        Reflect.set(
          session as object,
          "prompt",
          async function prompt(this: AgentSession) {
            promptedSessions.push(this);
            return {
              raw: "master session reply",
              updates: [],
              durationMs: 0,
            };
          },
        );
        rootSession ??= session;
        return session;
      },
    });

    Reflect.set(conversation as object, "persistedSessionId", "default-session-master");

    registry.register({
      name: "inner",
      description: "test nested child procedure",
      async execute(_prompt, innerCtx) {
        const reply = await innerCtx.agent.run("use the master binding", {
          session: "default",
          stream: false,
        });
        return {
          data: reply.data,
        };
      },
    });
    registry.register({
      name: "outer",
      description: "test outer child procedure",
      async execute(_prompt, outerCtx) {
        const result = await outerCtx.procedures.run("inner", "", { session: "default" });
        return {
          data: result.data,
        };
      },
    });

    const result = await ctx.procedures.run("outer", "", { session: "fresh" });

    expect(result.data).toBe("master session reply");
    expect(promptedSessions).toEqual([conversation]);
  });

  test("ctx.state owns durable run traversal while ctx.session owns live default-agent control", async () => {
    const { ctx, store } = createContext();
    const otherTopLevel = store.completeRun(
      store.startRun({
        procedure: "other-procedure",
        input: "other input",
        kind: "top_level",
      }),
      {
        summary: "other summary",
      },
    );

    expect("list" in ctx.session).toBe(false);
    expect("getDefaultAgentConfig" in ctx.state).toBe(false);

    const recentRuns = await ctx.state.runs.list({ scope: "recent", limit: 1 });
    const topLevelRuns = await ctx.state.runs.list();

    expect(ctx.session.getDefaultAgentConfig()).toEqual(createMockConfig(ctx.cwd));
    expect(recentRuns[0]?.run).toEqual(otherTopLevel.run);
    expect(topLevelRuns.map((run) => run.run)).toContainEqual(otherTopLevel.run);
  });

  test("failed typed image calls discard staged prompt attachments", async () => {
    const { ctx, store } = createContext();

    await expect(
      ctx.agent.run("Inspect this image", MathResultType, {
        promptInput: {
          parts: [
            { type: "text", text: "Inspect this image " },
            {
              type: "image",
              token: "[Image 1: PNG 10x10 3B]",
              mimeType: "image/png",
              data: "YWJj",
              width: 10,
              height: 10,
              byteLength: 3,
            },
          ],
        },
      }),
    ).rejects.toThrow("Image prompts are only supported");

    const attachmentsDir = join(store.rootDir, "attachments");
    expect(existsSync(attachmentsDir)).toBe(true);
    expect(readdirSync(attachmentsDir)).toEqual([]);
  });
});

function createContext(options: {
  prepareDefaultPrompt?: (promptInput: PromptInput) => {
    promptInput: PromptInput;
    markSubmitted?: () => void;
  };
  createAgentSession?: (params: CreateAgentSessionParams) => AgentSession;
  configOverride?: Partial<DownstreamAgentConfig>;
} = {}): {
  conversation: AgentSession;
  ctx: ProcedureApi;
  emittedUpdates: acp.SessionUpdate[];
  registry: ProcedureRegistry;
  store: SessionStore;
} {
  const cwd = mkdtempSync(join(tmpdir(), "nab-call-agent-session-"));
  tempDirs.push(cwd);

  const registryRoot = join(cwd, ".nanoboss", "procedures");
  const registry = new ProcedureRegistry({ procedureRoots: [registryRoot] });
  const logger = new RunLogger();
  const store = new SessionStore({
    sessionId: crypto.randomUUID(),
    cwd,
    rootDir: join(cwd, ".nanoboss", "sessions", "test-session"),
  });
  const emittedUpdates: acp.SessionUpdate[] = [];
  let config = createMockConfig(cwd, options.configOverride);
  const createSession = options.createAgentSession ?? createAgentSession;
  const conversation = createSession({
    config,
  });

  const ctx = new CommandContextImpl({
    cwd,
    logger,
    registry,
    procedureName: "test-procedure",
    spanId: logger.newSpan(),
    emitter: {
      emit(update) {
        emittedUpdates.push(update);
      },
      async flush() {},
    },
    store,
    run: store.startRun({
      procedure: "test-procedure",
      input: "test",
      kind: "top_level",
    }),
    agentSession: conversation,
    getDefaultAgentConfig: () => config,
    setDefaultAgentSelection: (selection) => {
      const nextConfig = resolveDownstreamAgentConfig(cwd, selection);
      config = nextConfig;
      conversation.updateConfig(nextConfig);
      return nextConfig;
    },
    prepareDefaultPrompt: options.prepareDefaultPrompt,
    createAgentSession: createSession,
  });

  return {
    conversation,
    ctx,
    emittedUpdates,
    registry,
    store,
  };
}

function createMockConfig(
  cwd: string,
  overrides: Partial<DownstreamAgentConfig> = {},
): DownstreamAgentConfig {
  return {
    command: "bun",
    cwd,
    ...overrides,
    args: overrides.args ?? ["run", MOCK_AGENT_PATH],
  };
}

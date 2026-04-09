import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import typia from "typia";

import { DefaultConversationSession } from "../../src/agent/default-session.ts";
import { CommandContextImpl } from "../../src/core/context.ts";
import { resolveDownstreamAgentConfig } from "../../src/core/config.ts";
import { RunLogger } from "../../src/core/logger.ts";
import { jsonType, type DownstreamAgentConfig } from "../../src/core/types.ts";
import { ProcedureRegistry } from "../../src/procedure/registry.ts";
import { SessionStore } from "../../src/session/index.ts";

interface MathResult {
  result: number;
}

const MathResultType = jsonType<MathResult>(
  typia.json.schema<MathResult>(),
  typia.createValidate<MathResult>(),
);

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("CommandContext callAgent session selection", () => {
  test("typed default-session calls reuse the default transport and keep parse retries", async () => {
    const { conversation, ctx, emittedUpdates } = createContext();
    const prompts: string[] = [];
    let submittedCount = 0;

    Reflect.set(conversation as object, "persistedSessionId", "default-session-1");
    Reflect.set(
      conversation as object,
      "prompt",
      async (
        prompt: string,
        options: { onUpdate?: (update: acp.SessionUpdate) => Promise<void> | void } = {},
      ) => {
        prompts.push(prompt);
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
    Reflect.set(
      ctx as object,
      "prepareDefaultPromptValue",
      (prompt: string) => ({
        prompt: `Prepared default prompt\n\nUser message:\n${prompt}`,
        markSubmitted: () => {
          submittedCount += 1;
        },
      }),
    );

    const result = await ctx.callAgent("Compute 4 + 3.", MathResultType, {
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

  test("untyped default-session calls use the same unified callAgent path", async () => {
    const { conversation, ctx, emittedUpdates } = createContext();
    const prompts: string[] = [];
    let submittedCount = 0;

    Reflect.set(conversation as object, "persistedSessionId", "default-session-2");
    Reflect.set(
      conversation as object,
      "prompt",
      async (prompt: string) => {
        prompts.push(prompt);
        return {
          raw: "4",
          updates: [],
          durationMs: 0,
        };
      },
    );
    Reflect.set(
      ctx as object,
      "prepareDefaultPromptValue",
      (prompt: string) => ({
        prompt: `Prepared default prompt\n\nUser message:\n${prompt}`,
        markSubmitted: () => {
          submittedCount += 1;
        },
      }),
    );

    const result = await ctx.callAgent("What is 2 + 2?", { session: "default" });

    expect(result.data).toBe("4");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toBe("Prepared default prompt\n\nUser message:\nWhat is 2 + 2?");
    expect(submittedCount).toBe(1);

    expect(emittedUpdates).toEqual([]);
  });

  test("callProcedure inherits the current default-session binding by default", async () => {
    const { conversation, ctx, registry } = createContext();
    const prompts: string[] = [];

    Reflect.set(conversation as object, "persistedSessionId", "default-session-procedure-inherit");
    Reflect.set(
      conversation as object,
      "prompt",
      async (prompt: string) => {
        prompts.push(prompt);
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
        const reply = await childCtx.callAgent(prompt, {
          session: "default",
          stream: false,
        });
        return {
          data: reply.data,
        };
      },
    });

    const result = await ctx.callProcedure("child", "reuse the bound session");

    expect(result.data).toBe("inherited");
    expect(prompts).toEqual(["reuse the bound session"]);
  });

  test("callProcedure with session fresh gives the child a private default binding", async () => {
    const { conversation, ctx, registry } = createContext();
    const rootConfigBefore = ctx.getDefaultAgentConfig();
    const promptedConversations: DefaultConversationSession[] = [];
    const originalPrompt = DefaultConversationSession.prototype.prompt;

    Reflect.set(conversation as object, "persistedSessionId", "default-session-root");

    Reflect.set(
      DefaultConversationSession.prototype as object,
      "prompt",
      async function prompt(
        this: DefaultConversationSession,
        promptText: string,
      ) {
        promptedConversations.push(this);
        return {
          raw: `${promptText} via ${this === conversation ? "root" : "fresh"}`,
          updates: [],
          durationMs: 0,
        };
      },
    );

    registry.register({
      name: "child",
      description: "test fresh child procedure",
      async execute(prompt, childCtx) {
        childCtx.setDefaultAgentSelection({
          provider: "codex",
          model: "gpt-5.4/high",
        });

        const reply = await childCtx.callAgent(prompt, {
          session: "default",
          stream: false,
        });

        return {
          data: {
            reply: reply.data,
            selection: childCtx.getDefaultAgentConfig(),
          },
        };
      },
    });

    try {
      const result = await ctx.callProcedure<{
        reply: string;
        selection: DownstreamAgentConfig;
      }>("child", "private child session", { session: "fresh" });

      expect(result.data?.reply).toBe("private child session via fresh");
      expect(promptedConversations).toHaveLength(1);
      expect(promptedConversations[0]).not.toBe(conversation);
      expect(result.data?.selection.provider).toBe("codex");
      expect(result.data?.selection.model).toBe("gpt-5.4/high");
      expect(ctx.getDefaultAgentConfig()).toEqual(rootConfigBefore);
    } finally {
      Reflect.set(DefaultConversationSession.prototype as object, "prompt", originalPrompt);
    }
  });

  test("callProcedure with session default rebinds nested children to the master session", async () => {
    const { conversation, ctx, registry } = createContext();
    const promptedConversations: DefaultConversationSession[] = [];
    const originalPrompt = DefaultConversationSession.prototype.prompt;

    Reflect.set(conversation as object, "persistedSessionId", "default-session-master");
    Reflect.set(
      DefaultConversationSession.prototype as object,
      "prompt",
      async function prompt(this: DefaultConversationSession) {
        promptedConversations.push(this);
        return {
          raw: "master session reply",
          updates: [],
          durationMs: 0,
        };
      },
    );

    registry.register({
      name: "inner",
      description: "test nested child procedure",
      async execute(_prompt, innerCtx) {
        const reply = await innerCtx.callAgent("use the master binding", {
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
        const result = await outerCtx.callProcedure("inner", "", { session: "default" });
        return {
          data: result.data,
        };
      },
    });

    try {
      const result = await ctx.callProcedure("outer", "", { session: "fresh" });

      expect(result.data).toBe("master session reply");
      expect(promptedConversations).toEqual([conversation]);
    } finally {
      Reflect.set(DefaultConversationSession.prototype as object, "prompt", originalPrompt);
    }
  });
});

function createContext(): {
  conversation: DefaultConversationSession;
  ctx: CommandContextImpl;
  emittedUpdates: acp.SessionUpdate[];
  registry: ProcedureRegistry;
} {
  const cwd = mkdtempSync(join(tmpdir(), "nab-call-agent-session-"));
  tempDirs.push(cwd);

  const registryRoot = join(cwd, ".nanoboss", "procedures");
  const registry = new ProcedureRegistry(registryRoot);
  const logger = new RunLogger();
  const store = new SessionStore({
    sessionId: crypto.randomUUID(),
    cwd,
  });
  const emittedUpdates: acp.SessionUpdate[] = [];
  let config = createMockConfig(cwd);
  const conversation = new DefaultConversationSession({
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
    cell: store.startCell({
      procedure: "test-procedure",
      input: "test",
      kind: "top_level",
    }),
    defaultConversation: conversation,
    getDefaultAgentConfig: () => config,
    setDefaultAgentSelection: (selection) => {
      const nextConfig = resolveDownstreamAgentConfig(cwd, selection);
      config = nextConfig;
      conversation.updateConfig(nextConfig);
      return nextConfig;
    },
  });

  return {
    conversation,
    ctx,
    emittedUpdates,
    registry,
  };
}

function createMockConfig(cwd: string): DownstreamAgentConfig {
  return {
    command: "bun",
    args: ["run", "tests/fixtures/mock-agent.ts"],
    cwd,
  };
}

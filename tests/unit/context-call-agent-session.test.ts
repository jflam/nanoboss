import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import typia from "typia";

import { DefaultConversationSession } from "../../src/agent/default-session.ts";
import { CommandContextImpl } from "../../src/core/context.ts";
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
});

function createContext(): {
  conversation: DefaultConversationSession;
  ctx: CommandContextImpl;
  emittedUpdates: acp.SessionUpdate[];
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
  const config = createMockConfig(cwd);
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
    setDefaultAgentSelection: () => config,
  });

  return {
    conversation,
    ctx,
    emittedUpdates,
  };
}

function createMockConfig(cwd: string): DownstreamAgentConfig {
  return {
    command: "bun",
    args: ["run", "tests/fixtures/mock-agent.ts"],
    cwd,
  };
}

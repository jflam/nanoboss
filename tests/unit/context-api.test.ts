import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CommandContextImpl } from "../../src/core/context.ts";
import { RunLogger } from "../../src/core/logger.ts";
import { ProcedureRegistry } from "../../src/procedure/registry.ts";
import { SessionStore } from "../../src/session/index.ts";
import type { DownstreamAgentConfig, DownstreamAgentSelection, ProcedureApi } from "../../src/core/types.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("procedure API surface", () => {
  test("exposes agent, state, ui, procedures, and session surfaces", () => {
    const expectedConfig: DownstreamAgentConfig = {
      provider: "codex",
      command: "bun",
      args: ["run", "mock-agent.ts"],
      model: "gpt-5.4/high",
    };
    let currentConfig = expectedConfig;
    const ctx: ProcedureApi = createContext({
      getDefaultAgentConfig: () => currentConfig,
      setDefaultAgentSelection: (selection) => {
        currentConfig = {
          ...expectedConfig,
          provider: selection.provider,
          model: selection.model,
        };
        return currentConfig;
      },
    });

    expect(ctx.agent).toBeDefined();
    expect(ctx.state).toBeDefined();
    expect(ctx.ui).toBeDefined();
    expect(ctx.procedures).toBeDefined();
    expect(ctx.session).toBeDefined();
    expect(ctx.state.refs).toBeDefined();
    expect(ctx.state.runs).toBeDefined();
    expect("recent" in ctx.session).toBe(false);
    expect("topLevelRuns" in ctx.session).toBe(false);
    expect("getDefaultAgentConfig" in ctx.state).toBe(false);
    expect(ctx.session.getDefaultAgentConfig()).toEqual(expectedConfig);
    expect(ctx.session.setDefaultAgentSelection({ provider: "copilot", model: "gpt-5.4/xhigh" })).toEqual({
      ...expectedConfig,
      provider: "copilot",
      model: "gpt-5.4/xhigh",
    });
  });

  test("ctx.agent.session(mode).run binds the session mode for convenience", async () => {
    const ctx: ProcedureApi = createContext();
    const captured: unknown[] = [];

    Reflect.set(ctx.agent as object, "run", async (...args: unknown[]) => {
      captured.push(args);
      return {
        cell: {
          sessionId: "session",
          cellId: "agent-2",
        },
        data: "bound",
      };
    });

    await ctx.agent.session("default").run("continue", { stream: false });

    expect(captured).toEqual([
      [
        "continue",
        {
          session: "default",
          stream: false,
        },
      ],
    ]);
  });
});

function createContext(overrides: {
  getDefaultAgentConfig?: () => DownstreamAgentConfig;
  setDefaultAgentSelection?: (selection: DownstreamAgentSelection) => DownstreamAgentConfig;
} = {}): CommandContextImpl {
  const cwd = mkdtempSync(join(tmpdir(), "nab-context-api-"));
  tempDirs.push(cwd);

  const registry = new ProcedureRegistry({ procedureRoots: [join(cwd, ".nanoboss", "procedures")] });
  const logger = new RunLogger();
  const store = new SessionStore({
    sessionId: crypto.randomUUID(),
    cwd,
  });

  return new CommandContextImpl({
    cwd,
    logger,
    registry,
    procedureName: "default",
    spanId: logger.newSpan(),
    emitter: {
      emit() {},
      async flush() {},
    },
    store,
    cell: store.startCell({
      procedure: "default",
      input: "hello",
      kind: "top_level",
    }),
    getDefaultAgentConfig: overrides.getDefaultAgentConfig,
    setDefaultAgentSelection: overrides.setDefaultAgentSelection,
  });
}

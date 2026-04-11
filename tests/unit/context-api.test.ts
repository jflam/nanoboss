import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CommandContextImpl } from "../../src/core/context.ts";
import { RunLogger } from "../../src/core/logger.ts";
import { ProcedureRegistry } from "../../src/procedure/registry.ts";
import { SessionStore } from "../../src/session/index.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("CommandContextImpl named procedure API", () => {
  test("exposes agent, state, ui, and procedures alongside legacy aliases", () => {
    const ctx = createContext();

    expect(ctx.agent).toBeDefined();
    expect(ctx.state).toBeDefined();
    expect(ctx.ui).toBeDefined();
    expect(ctx.procedures).toBeDefined();
    expect(ctx.state.refs).toBe(ctx.refs);
    expect(ctx.state.runs).toBe(ctx.session);
  });

  test("compatibility shims delegate to the named sub-apis", async () => {
    const ctx = createContext();
    const agentResult = {
      cell: {
        sessionId: "session",
        cellId: "agent-1",
      },
      data: "ok",
    };
    const procedureResult = {
      cell: {
        sessionId: "session",
        cellId: "proc-1",
      },
      data: { done: true },
    };
    const seen: string[] = [];

    Reflect.set(ctx.agent as object, "run", async () => {
      seen.push("agent.run");
      return agentResult;
    });
    Reflect.set(ctx.procedures as object, "run", async () => {
      seen.push("procedures.run");
      return procedureResult;
    });
    Reflect.set(ctx.ui as object, "text", (text: string) => {
      seen.push(`ui.text:${text}`);
    });

    expect(await ctx.callAgent("hello")).toBe(agentResult);
    expect(await ctx.callProcedure("child", "hello")).toBe(procedureResult);
    ctx.print("progress");

    expect(seen).toEqual([
      "agent.run",
      "procedures.run",
      "ui.text:progress",
    ]);
  });

  test("ctx.agent.session(mode).run binds the session mode for convenience", async () => {
    const ctx = createContext();
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

function createContext(): CommandContextImpl {
  const cwd = mkdtempSync(join(tmpdir(), "nab-context-api-"));
  tempDirs.push(cwd);

  const registry = new ProcedureRegistry(join(cwd, ".nanoboss", "procedures"));
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
  });
}

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CommandContextImpl } from "../../src/core/context.ts";
import type { ProcedureUiEvent } from "../../src/core/context-shared.ts";
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

describe("CommandContextImpl UI", () => {
  test("print delegates through the UI layer without changing stream, log, or emitted update behavior", () => {
    const { ctx, cell, updates, logger } = createContext();

    ctx.print("streamed text");

    expect(cell.streamChunks.join("")).toBe("streamed text");
    expect(updates).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "streamed text",
        },
      },
    ]);

    const logText = readFileSync(logger.filePath, "utf8");
    expect(logText).toContain('"kind":"print"');
    expect(logText).toContain('"raw":"streamed text"');
  });

  test("info, warning, error, status, and card use the expected UI emission channels", () => {
    const { ctx, cell, updates, uiEvents } = createContext();

    ctx.ui.info("Heads up");
    ctx.ui.warning("Check this");
    ctx.ui.error("Boom");
    ctx.ui.status({
      phase: "research",
      message: "Gathering sources",
      iteration: "2/3",
      autoApprove: true,
      waiting: true,
    });
    ctx.ui.card({
      kind: "report",
      title: "Research checkpoint",
      markdown: "- source A\n- source B",
    });

    expect(cell.streamChunks).toEqual([]);
    expect(updates).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Info: Heads up",
        },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Warning: Check this",
        },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Error: Boom",
        },
      },
    ]);
    expect(uiEvents).toEqual([
      {
        type: "status",
        procedure: "default",
        phase: "research",
        message: "Gathering sources",
        iteration: "2/3",
        autoApprove: true,
        waiting: true,
      },
      {
        type: "card",
        procedure: "default",
        kind: "report",
        title: "Research checkpoint",
        markdown: "- source A\n- source B",
      },
    ] satisfies ProcedureUiEvent[]);
  });
});

function createContext(): {
  ctx: CommandContextImpl;
  cell: ReturnType<SessionStore["startCell"]>;
  updates: unknown[];
  uiEvents: ProcedureUiEvent[];
  logger: RunLogger;
} {
  const cwd = mkdtempSync(join(tmpdir(), "nab-context-ui-"));
  tempDirs.push(cwd);

  const registry = new ProcedureRegistry(join(cwd, ".nanoboss", "procedures"));
  const logger = new RunLogger(crypto.randomUUID(), mkdtempSync(join(tmpdir(), "nab-context-ui-log-")));
  const store = new SessionStore({
    sessionId: crypto.randomUUID(),
    cwd,
  });
  const cell = store.startCell({
    procedure: "default",
    input: "hello",
    kind: "top_level",
  });
  const updates: unknown[] = [];
  const uiEvents: ProcedureUiEvent[] = [];
  const ctx = new CommandContextImpl({
    cwd,
    logger,
    registry,
    procedureName: "default",
    spanId: logger.newSpan(),
    emitter: {
      emit(update) {
        updates.push(update);
      },
      emitUiEvent(event) {
        uiEvents.push(event);
      },
      async flush() {},
    },
    store,
    cell,
  });

  return { ctx, cell, updates, uiEvents, logger };
}

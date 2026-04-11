import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

describe("CommandContextImpl print", () => {
  test("delegates through the UI layer without changing stream, log, or emitted update behavior", () => {
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
        async flush() {},
      },
      store,
      cell,
    });

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
});

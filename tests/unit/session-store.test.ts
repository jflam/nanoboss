import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { SessionStore } from "../../src/session-store.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("SessionStore", () => {
  test("loads persisted cells from disk", () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-session-store-"));
    tempDirs.push(rootDir);

    const original = new SessionStore({
      sessionId: "session-1",
      cwd: process.cwd(),
      rootDir,
    });
    const cell = original.startCell({
      procedure: "demo",
      input: "hello",
      kind: "top_level",
    });
    const result = original.finalizeCell(cell, {
      data: {
        count: 3,
        text: "hi",
      },
      display: "hi\n",
      summary: "demo summary",
    });

    const reloaded = new SessionStore({
      sessionId: "session-1",
      cwd: process.cwd(),
      rootDir,
    });

    const dataRef = result.dataRef;
    if (!dataRef) {
      throw new Error("Missing dataRef");
    }

    expect(reloaded.readRef(dataRef)).toEqual({
      count: 3,
      text: "hi",
    });

    const last = reloaded.last();
    expect(last?.procedure).toBe("demo");
    expect(last?.dataRef).toEqual(result.dataRef);
    expect(last?.displayRef).toEqual(result.displayRef);
    expect(last?.summary).toBe("demo summary");
  });
});

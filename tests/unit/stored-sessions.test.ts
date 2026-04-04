import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  listSessionSummaries,
  resolveMostRecentSessionSummary,
  writeSessionMetadata,
} from "../../src/session/index.ts";

let tempHome: string | undefined;

afterEach(() => {
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  }
});

describe("session persistence", () => {
  test("lists persisted session metadata", () => {
    const originalHome = process.env.HOME;
    tempHome = mkdtempSync(join(tmpdir(), "nanoboss-stored-sessions-"));
    process.env.HOME = tempHome;

    try {
      writeSessionMetadata({
        sessionId: "session-123",
        cwd: "/repo",
        rootDir: join(tempHome, ".nanoboss", "sessions", "session-123"),
        createdAt: "2026-04-01T10:00:00.000Z",
        updatedAt: "2026-04-01T11:00:00.000Z",
        initialPrompt: "first prompt",
        defaultAcpSessionId: "acp-123",
      });

      const sessions = listSessionSummaries();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        sessionId: "session-123",
        cwd: "/repo",
        initialPrompt: "first prompt",
        hasNativeResume: true,
      });
      expect(resolveMostRecentSessionSummary("/repo")?.sessionId).toBe("session-123");
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  test("uses stored metadata without traversing cells", () => {
    const originalHome = process.env.HOME;
    tempHome = mkdtempSync(join(tmpdir(), "nanoboss-stored-metadata-fastpath-"));
    process.env.HOME = tempHome;

    try {
      const sessionRoot = join(tempHome, ".nanoboss", "sessions", "session-fast");
      mkdirSync(sessionRoot, { recursive: true });
      writeSessionMetadata({
        sessionId: "session-fast",
        cwd: "/repo",
        rootDir: sessionRoot,
        createdAt: "2026-04-01T10:00:00.000Z",
        updatedAt: "2026-04-01T11:00:00.000Z",
        initialPrompt: "first prompt",
      });
      writeFileSync(join(sessionRoot, "cells"), "not-a-directory\n", "utf8");

      const sessions = listSessionSummaries();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        sessionId: "session-fast",
        cwd: "/repo",
        initialPrompt: "first prompt",
      });
      expect(resolveMostRecentSessionSummary("/repo")?.sessionId).toBe("session-fast");
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  test("ignores sessions that have cells but no session metadata", () => {
    const originalHome = process.env.HOME;
    tempHome = mkdtempSync(join(tmpdir(), "nanoboss-metadata-required-"));
    process.env.HOME = tempHome;

    try {
      const sessionRoot = join(tempHome, ".nanoboss", "sessions", "session-456");
      const cellsDir = join(sessionRoot, "cells");
      mkdirSync(cellsDir, { recursive: true });
      writeFileSync(join(cellsDir, "1-top-level.json"), `${JSON.stringify({
        cellId: "cell-1",
        procedure: "default",
        input: "hello world",
        meta: {
          createdAt: "2026-04-01T12:00:00.000Z",
          kind: "top_level",
        },
      }, null, 2)}\n`);
      writeFileSync(join(cellsDir, "2-top-level.json"), `${JSON.stringify({
        cellId: "cell-2",
        procedure: "default",
        input: "follow up",
        meta: {
          createdAt: "2026-04-01T13:00:00.000Z",
          kind: "top_level",
          defaultAgentSelection: {
            provider: "codex",
            model: "gpt-5.4/high",
          },
        },
      }, null, 2)}\n`);

      expect(listSessionSummaries()).toEqual([]);
      expect(resolveMostRecentSessionSummary("/repo")).toBeUndefined();
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });
});

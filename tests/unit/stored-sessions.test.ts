import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  listStoredSessions,
  readStoredSessionMetadata,
  writeStoredSessionMetadata,
} from "@nanoboss/store";

let tempHome: string | undefined;

afterEach(() => {
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  }
});

describe("session persistence", () => {
  test("lists persisted session metadata sorted by most recent update", () => {
    const originalHome = process.env.HOME;
    tempHome = mkdtempSync(join(tmpdir(), "nanoboss-stored-sessions-"));
    process.env.HOME = tempHome;

    try {
      writeStoredSessionMetadata({
        session: { sessionId: "session-older" },
        cwd: "/repo",
        rootDir: join(tempHome, ".nanoboss", "sessions", "session-older"),
        createdAt: "2026-04-01T09:00:00.000Z",
        updatedAt: "2026-04-01T10:00:00.000Z",
      });
      writeStoredSessionMetadata({
        session: { sessionId: "session-123" },
        cwd: "/repo",
        rootDir: join(tempHome, ".nanoboss", "sessions", "session-123"),
        createdAt: "2026-04-01T10:00:00.000Z",
        updatedAt: "2026-04-01T11:00:00.000Z",
        initialPrompt: "first prompt",
        defaultAgentSessionId: "acp-123",
      });

      const sessions = listStoredSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions.map((session) => session.session.sessionId)).toEqual([
        "session-123",
        "session-older",
      ]);
      expect(sessions[0]).toMatchObject({
        session: { sessionId: "session-123" },
        cwd: "/repo",
        initialPrompt: "first prompt",
        defaultAgentSessionId: "acp-123",
      });
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  test("parses stored metadata from session.json without traversing cells", () => {
    const originalHome = process.env.HOME;
    tempHome = mkdtempSync(join(tmpdir(), "nanoboss-stored-metadata-fastpath-"));
    process.env.HOME = tempHome;

    try {
      const sessionRoot = join(tempHome, ".nanoboss", "sessions", "session-fast");
      mkdirSync(sessionRoot, { recursive: true });
      writeFileSync(join(sessionRoot, "session.json"), `${JSON.stringify({
        session: { sessionId: "session-fast" },
        cwd: "/repo",
        rootDir: sessionRoot,
        createdAt: "2026-04-01T10:00:00.000Z",
        updatedAt: "2026-04-01T11:00:00.000Z",
        initialPrompt: "first prompt",
      }, null, 2)}\n`, "utf8");
      writeFileSync(join(sessionRoot, "cells"), "not-a-directory\n", "utf8");

      const sessions = listStoredSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        session: { sessionId: "session-fast" },
        cwd: "/repo",
        rootDir: sessionRoot,
        initialPrompt: "first prompt",
      });
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  test("keeps optional stored default agent models and ignores invalid providers", () => {
    const originalHome = process.env.HOME;
    tempHome = mkdtempSync(join(tmpdir(), "nanoboss-stored-agent-selection-"));
    process.env.HOME = tempHome;

    try {
      const validSessionRoot = join(tempHome, ".nanoboss", "sessions", "session-valid");
      mkdirSync(validSessionRoot, { recursive: true });
      writeFileSync(join(validSessionRoot, "session.json"), `${JSON.stringify({
        session: { sessionId: "session-valid" },
        cwd: "/repo",
        rootDir: validSessionRoot,
        createdAt: "2026-04-01T10:00:00.000Z",
        updatedAt: "2026-04-01T11:00:00.000Z",
        defaultAgentSelection: {
          provider: "codex",
        },
      }, null, 2)}\n`, "utf8");

      const invalidSessionRoot = join(tempHome, ".nanoboss", "sessions", "session-invalid");
      mkdirSync(invalidSessionRoot, { recursive: true });
      writeFileSync(join(invalidSessionRoot, "session.json"), `${JSON.stringify({
        session: { sessionId: "session-invalid" },
        cwd: "/repo",
        rootDir: invalidSessionRoot,
        createdAt: "2026-04-01T12:00:00.000Z",
        updatedAt: "2026-04-01T13:00:00.000Z",
        defaultAgentSelection: {
          provider: "cursor",
          model: "bad-model",
        },
      }, null, 2)}\n`, "utf8");

      const sessions = listStoredSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions.find((session) => session.session.sessionId === "session-valid")?.defaultAgentSelection).toEqual({
        provider: "codex",
      });
      expect(sessions.find((session) => session.session.sessionId === "session-invalid")?.defaultAgentSelection).toBeUndefined();
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

      expect(listStoredSessions()).toEqual([]);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  test("throws when session.json contains malformed JSON", () => {
    const originalHome = process.env.HOME;
    tempHome = mkdtempSync(join(tmpdir(), "nanoboss-bad-session-metadata-"));
    process.env.HOME = tempHome;

    try {
      const sessionRoot = join(tempHome, ".nanoboss", "sessions", "session-bad");
      mkdirSync(sessionRoot, { recursive: true });
      writeFileSync(join(sessionRoot, "session.json"), "{bad json\n", "utf8");

      expect(() => readStoredSessionMetadata("session-bad", sessionRoot)).toThrow("Failed to parse session metadata");
      expect(() => listStoredSessions()).toThrow("Failed to parse session metadata");
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { resolveWorkspaceKey } from "@nanoboss/app-support";

import { runResumeCommand, type StoredSessionSelectionResult } from "../../resume.ts";
import { writeStoredSessionMetadata } from "@nanoboss/store";

let tempHome: string | undefined;

afterEach(() => {
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  }
});

describe("runResumeCommand", () => {
  test("returns quietly when the session picker is cancelled", async () => {
    const launches: string[] = [];

    await expect(runResumeCommand(["--list"], {
      assertInteractiveTty: () => {},
      selectStoredSession: async (): Promise<StoredSessionSelectionResult> => ({ kind: "cancelled" }),
      runTuiCli: async (params) => {
        if (params.sessionId) {
          launches.push(params.sessionId);
        }
      },
    })).resolves.toBeUndefined();

    expect(launches).toEqual([]);
  });

  test("still throws when there are no saved sessions to list", async () => {
    await expect(runResumeCommand(["--list"], {
      assertInteractiveTty: () => {},
      selectStoredSession: async (): Promise<StoredSessionSelectionResult> => ({ kind: "empty" }),
    })).rejects.toThrow(`No saved nanoboss sessions found for ${process.cwd()}`);
  });

  test("resumes explicit sessions using the stored session workspace", async () => {
    const originalHome = process.env.HOME;
    tempHome = mkdtempSync(join(tmpdir(), "nanoboss-resume-workspace-"));
    process.env.HOME = tempHome;
    let launchCwd: string | undefined;

    try {
      writeStoredSessionMetadata({
        session: { sessionId: "session-123" },
        cwd: "/repo-one",
        rootDir: join(tempHome, ".nanoboss", "sessions", "session-123"),
        createdAt: "2026-04-01T10:00:00.000Z",
        updatedAt: "2026-04-01T11:00:00.000Z",
      });

      await runResumeCommand(["session-123"], {
        assertInteractiveTty: () => {},
        runTuiCli: async (params) => {
          launchCwd = params.cwd;
        },
      });

      expect(launchCwd).toBe("/repo-one");
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  test("prefers the current workspace session when resuming without an explicit id", async () => {
    const originalHome = process.env.HOME;
    tempHome = mkdtempSync(join(tmpdir(), "nanoboss-resume-current-"));
    process.env.HOME = tempHome;
    let launchedSessionId: string | undefined;
    const cwd = process.cwd();

    try {
      writeStoredSessionMetadata({
        session: { sessionId: "session-most-recent" },
        cwd,
        rootDir: join(tempHome, ".nanoboss", "sessions", "session-most-recent"),
        createdAt: "2026-04-01T10:00:00.000Z",
        updatedAt: "2026-04-01T12:00:00.000Z",
      });
      writeStoredSessionMetadata({
        session: { sessionId: "session-current" },
        cwd,
        rootDir: join(tempHome, ".nanoboss", "sessions", "session-current"),
        createdAt: "2026-04-01T09:00:00.000Z",
        updatedAt: "2026-04-01T11:30:00.000Z",
      });

      await runResumeCommand([], {
        assertInteractiveTty: () => {},
        runTuiCli: async (params) => {
          launchedSessionId = params.sessionId;
        },
      });

      expect(launchedSessionId).toBe("session-current");
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  test("falls back to the most recent stored session for the current workspace", async () => {
    const originalHome = process.env.HOME;
    tempHome = mkdtempSync(join(tmpdir(), "nanoboss-resume-fallback-"));
    process.env.HOME = tempHome;
    let launchedSessionId: string | undefined;
    const cwd = process.cwd();

    try {
      writeStoredSessionMetadata({
        session: { sessionId: "session-other-workspace" },
        cwd: "/repo-one",
        rootDir: join(tempHome, ".nanoboss", "sessions", "session-other-workspace"),
        createdAt: "2026-04-01T08:00:00.000Z",
        updatedAt: "2026-04-01T13:00:00.000Z",
      });
      writeStoredSessionMetadata({
        session: { sessionId: "session-older" },
        cwd,
        rootDir: join(tempHome, ".nanoboss", "sessions", "session-older"),
        createdAt: "2026-04-01T09:00:00.000Z",
        updatedAt: "2026-04-01T10:00:00.000Z",
      });
      writeStoredSessionMetadata({
        session: { sessionId: "session-latest" },
        cwd,
        rootDir: join(tempHome, ".nanoboss", "sessions", "session-latest"),
        createdAt: "2026-04-01T10:00:00.000Z",
        updatedAt: "2026-04-01T12:00:00.000Z",
      });
      mkdirSync(join(tempHome, ".nanoboss"), { recursive: true });
      writeFileSync(
        join(tempHome, ".nanoboss", "current-sessions.json"),
        `${JSON.stringify({
          workspaces: {
            [resolveWorkspaceKey(cwd)]: {
              session: { sessionId: "session-missing" },
              cwd,
              rootDir: join(tempHome, ".nanoboss", "sessions", "session-missing"),
              createdAt: "2026-04-01T11:00:00.000Z",
              updatedAt: "2026-04-01T11:30:00.000Z",
            },
          },
        }, null, 2)}\n`,
        "utf8",
      );

      await runResumeCommand([], {
        assertInteractiveTty: () => {},
        runTuiCli: async (params) => {
          launchedSessionId = params.sessionId;
        },
      });

      expect(launchedSessionId).toBe("session-latest");
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { runResumeCommand, type StoredSessionSelectionResult } from "../../resume.ts";
import { writeSessionMetadata } from "../../src/session/index.ts";

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
        launches.push(params.sessionId);
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
      writeSessionMetadata({
        sessionId: "session-123",
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
});

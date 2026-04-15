import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import { resolveWorkspaceKey } from "../../src/core/workspace-identity.ts";
import {
  readCurrentWorkspaceSessionMetadata,
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

test("derives the current session metadata from the stored session snapshot", () => {
  const originalHome = process.env.HOME;
  tempHome = mkdtempSync(join(tmpdir(), "nanoboss-current-session-"));
  process.env.HOME = tempHome;

  try {
    const rootDir = join(tempHome, ".nanoboss", "sessions", "session-123");
    const metadata = writeStoredSessionMetadata({
      session: { sessionId: "session-123" },
      cwd: "/repo",
      rootDir,
      createdAt: "2026-04-01T10:00:00.000Z",
      updatedAt: "2026-04-01T11:00:00.000Z",
      initialPrompt: "review this patch",
    });

    expect(readStoredSessionMetadata("session-123", rootDir)).toEqual(metadata);
    expect(readCurrentWorkspaceSessionMetadata("/repo")).toEqual(metadata);
    expect(readCurrentWorkspaceSessionMetadata("/other-repo")).toBeUndefined();
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

test("keeps derived current session cache entries isolated by workspace", () => {
  const originalHome = process.env.HOME;
  tempHome = mkdtempSync(join(tmpdir(), "nanoboss-current-session-workspaces-"));
  process.env.HOME = tempHome;

  try {
    writeStoredSessionMetadata({
      session: { sessionId: "session-one" },
      cwd: "/repo-one",
      rootDir: join(tempHome, ".nanoboss", "sessions", "session-one"),
      createdAt: "2026-04-01T10:00:00.000Z",
      updatedAt: "2026-04-01T11:00:00.000Z",
    });
    writeStoredSessionMetadata({
      session: { sessionId: "session-two" },
      cwd: "/repo-two",
      rootDir: join(tempHome, ".nanoboss", "sessions", "session-two"),
      createdAt: "2026-04-01T12:00:00.000Z",
      updatedAt: "2026-04-01T13:00:00.000Z",
    });

    expect(readCurrentWorkspaceSessionMetadata("/repo-one")?.session.sessionId).toBe("session-one");
    expect(readCurrentWorkspaceSessionMetadata("/repo-two")?.session.sessionId).toBe("session-two");
    expect(readCurrentWorkspaceSessionMetadata("/repo-three")).toBeUndefined();
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

test("round-trips continuation UI metadata through stored session snapshots", () => {
  const originalHome = process.env.HOME;
  tempHome = mkdtempSync(join(tmpdir(), "nanoboss-current-session-continuation-ui-"));
  process.env.HOME = tempHome;

  try {
    const rootDir = join(tempHome, ".nanoboss", "sessions", "session-ui");
    const metadata = writeStoredSessionMetadata({
      session: { sessionId: "session-ui" },
      cwd: "/repo",
      rootDir,
      createdAt: "2026-04-01T10:00:00.000Z",
      updatedAt: "2026-04-01T11:00:00.000Z",
      pendingContinuation: {
        procedure: "simplify2",
        run: {
          sessionId: "session-ui",
          runId: "cell-1",
        },
        question: "Approve this simplify2 slice?",
        state: {
          step: 1,
        },
        ui: {
          kind: "simplify2_checkpoint",
          title: "Simplify2 checkpoint",
          actions: [
            { id: "approve", label: "Continue", reply: "approve it" },
            { id: "other", label: "Something Else" },
          ],
        },
      },
    });

    expect(readStoredSessionMetadata("session-ui", rootDir)).toEqual(metadata);
    expect(readCurrentWorkspaceSessionMetadata("/repo")).toEqual(metadata);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

test("ignores current session workspace entries missing createdAt", () => {
  const originalHome = process.env.HOME;
  tempHome = mkdtempSync(join(tmpdir(), "nanoboss-current-session-invalid-"));
  process.env.HOME = tempHome;

  try {
    mkdirSync(join(tempHome, ".nanoboss"), { recursive: true });
    writeFileSync(
      join(tempHome, ".nanoboss", "current-sessions.json"),
      `${JSON.stringify({
        workspaces: {
          [resolveWorkspaceKey("/repo")]: {
            session: { sessionId: "session-123" },
            cwd: "/repo",
            rootDir: "/repo/.nanoboss/session-123",
            updatedAt: "2026-04-01T11:00:00.000Z",
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );

    expect(readCurrentWorkspaceSessionMetadata("/repo")).toBeUndefined();
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

test("ignores current session cache entries when the canonical session snapshot is missing", () => {
  const originalHome = process.env.HOME;
  tempHome = mkdtempSync(join(tmpdir(), "nanoboss-current-session-stale-"));
  process.env.HOME = tempHome;

  try {
    mkdirSync(join(tempHome, ".nanoboss"), { recursive: true });
    writeFileSync(
      join(tempHome, ".nanoboss", "current-sessions.json"),
      `${JSON.stringify({
        workspaces: {
          [resolveWorkspaceKey("/repo")]: {
            session: { sessionId: "session-missing" },
            cwd: "/repo",
            rootDir: join(tempHome, ".nanoboss", "sessions", "session-missing"),
            createdAt: "2026-04-01T10:00:00.000Z",
            updatedAt: "2026-04-01T11:00:00.000Z",
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );

    expect(readCurrentWorkspaceSessionMetadata("/repo")).toBeUndefined();
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

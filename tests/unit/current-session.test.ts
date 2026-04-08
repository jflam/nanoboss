import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import {
  readCurrentSessionMetadata,
  writeCurrentSessionMetadata,
} from "../../src/session/index.ts";

let tempHome: string | undefined;

afterEach(() => {
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  }
});

test("writes and reads the current session metadata", () => {
  const originalHome = process.env.HOME;
  tempHome = mkdtempSync(join(tmpdir(), "nanoboss-current-session-"));
  process.env.HOME = tempHome;

  try {
    writeCurrentSessionMetadata({
      sessionId: "session-123",
      cwd: "/repo",
      rootDir: "/repo/.nanoboss/session-123",
      createdAt: "2026-04-01T10:00:00.000Z",
      updatedAt: "2026-04-01T11:00:00.000Z",
    });

    expect(readCurrentSessionMetadata("/repo")).toMatchObject({
      sessionId: "session-123",
      cwd: "/repo",
    });
    expect(readCurrentSessionMetadata("/other-repo")).toBeUndefined();
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

test("keeps current session pointers isolated by workspace", () => {
  const originalHome = process.env.HOME;
  tempHome = mkdtempSync(join(tmpdir(), "nanoboss-current-session-workspaces-"));
  process.env.HOME = tempHome;

  try {
    writeCurrentSessionMetadata({
      sessionId: "session-one",
      cwd: "/repo-one",
      rootDir: "/repo-one/.nanoboss/session-one",
      createdAt: "2026-04-01T10:00:00.000Z",
      updatedAt: "2026-04-01T11:00:00.000Z",
    });
    writeCurrentSessionMetadata({
      sessionId: "session-two",
      cwd: "/repo-two",
      rootDir: "/repo-two/.nanoboss/session-two",
      createdAt: "2026-04-01T12:00:00.000Z",
      updatedAt: "2026-04-01T13:00:00.000Z",
    });

    expect(readCurrentSessionMetadata("/repo-one")?.sessionId).toBe("session-one");
    expect(readCurrentSessionMetadata("/repo-two")?.sessionId).toBe("session-two");
    expect(readCurrentSessionMetadata("/repo-three")).toBeUndefined();
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

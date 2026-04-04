import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import {
  getCurrentSessionMetadataPath,
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

    expect(readCurrentSessionMetadata()).toMatchObject({
      sessionId: "session-123",
      cwd: "/repo",
      rootDir: "/repo/.nanoboss/session-123",
    });
    expect(readFileSync(getCurrentSessionMetadataPath(), "utf8")).toContain("\"sessionId\": \"session-123\"");
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

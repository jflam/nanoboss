import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { inspectSessionCleanupCandidates, selectCleanupCandidates } from "../../src/session-cleanup.ts";

describe("session cleanup inspection", () => {
  test("classifies empty directories, temp cwd sessions, and fixture prompts", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "nanoboss-cleanup-"));

    mkdirSync(join(baseDir, "empty-dir"), { recursive: true });

    const tempSessionDir = join(baseDir, "temp-session");
    mkdirSync(tempSessionDir, { recursive: true });
    writeFileSync(join(tempSessionDir, "session.json"), `${JSON.stringify({
      sessionId: "temp-session",
      cwd: "/var/folders/8v/s_xb_zrn41q8zf2sxwycl0z40000gn/T/nab-workspace-test",
      initialPrompt: "/review patch",
      createdAt: "2026-04-03T00:00:00.000Z",
      updatedAt: "2026-04-03T00:00:00.000Z",
    })}\n`);

    const emptySessionDir = join(baseDir, "session-from-client");
    mkdirSync(emptySessionDir, { recursive: true });
    writeFileSync(join(emptySessionDir, "session.json"), `${JSON.stringify({
      sessionId: "session-from-client",
      cwd: "/repo",
      createdAt: "2026-04-03T00:00:00.000Z",
      updatedAt: "2026-04-03T00:00:00.000Z",
    })}\n`);

    const legacyFixtureDir = join(baseDir, "legacy-fixture");
    mkdirSync(join(legacyFixtureDir, "cells"), { recursive: true });
    writeFileSync(join(legacyFixtureDir, "cells", "001.json"), `${JSON.stringify({
      procedure: "callAgent",
      input: "compute",
      meta: {
        kind: "agent",
        createdAt: "2026-04-03T00:00:00.000Z",
      },
    })}\n`);

    const candidates = inspectSessionCleanupCandidates(baseDir);
    const selected = selectCleanupCandidates(candidates, [
      "empty_dir",
      "empty_session",
      "temp_cwd",
      "fixture_session_id",
      "fixture_prompt",
    ]);

    expect(selected).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: "empty-dir",
        reasons: expect.arrayContaining(["empty_dir", "unknown_cwd"]),
      }),
      expect.objectContaining({
        sessionId: "temp-session",
        reasons: expect.arrayContaining(["temp_cwd", "fixture_prompt"]),
      }),
      expect.objectContaining({
        sessionId: "session-from-client",
        reasons: expect.arrayContaining(["empty_session", "fixture_session_id"]),
      }),
      expect.objectContaining({
        sessionId: "legacy-fixture",
        initialPrompt: "/callAgent compute",
        reasons: expect.arrayContaining(["fixture_prompt", "unknown_cwd"]),
      }),
    ]));
  });
});

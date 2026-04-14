import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  inspectSessionCleanupCandidates,
  selectCleanupCandidates,
  type SessionCleanupCandidate,
} from "../../src/session/cleanup.ts";

function expectCandidates(value: unknown): SessionCleanupCandidate[] {
  if (!Array.isArray(value)) {
    throw new Error("Expected session cleanup candidates");
  }
  return value as SessionCleanupCandidate[];
}

function findCandidate(candidates: SessionCleanupCandidate[], sessionId: string): SessionCleanupCandidate {
  const candidate = candidates.find((entry) => entry.sessionId === sessionId);
  if (candidate === undefined) {
    throw new Error(`Expected candidate ${sessionId}`);
  }
  return candidate;
}

describe("session cleanup inspection", () => {
  test("classifies empty directories, temp cwd sessions, and fixture prompts", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "nanoboss-cleanup-"));

    mkdirSync(join(baseDir, "empty-dir"), { recursive: true });

    const tempSessionDir = join(baseDir, "temp-session");
    mkdirSync(tempSessionDir, { recursive: true });
    writeFileSync(join(tempSessionDir, "session.json"), `${JSON.stringify({
      session: { sessionId: "temp-session" },
      cwd: "/var/folders/8v/s_xb_zrn41q8zf2sxwycl0z40000gn/T/nab-workspace-test",
      rootDir: tempSessionDir,
      initialPrompt: "/review patch",
      createdAt: "2026-04-03T00:00:00.000Z",
      updatedAt: "2026-04-03T00:00:00.000Z",
    })}\n`);

    const namespaceFixtureDir = join(baseDir, "namespace-fixture");
    mkdirSync(namespaceFixtureDir, { recursive: true });
    writeFileSync(join(namespaceFixtureDir, "session.json"), `${JSON.stringify({
      session: { sessionId: "namespace-fixture" },
      cwd: "/repo",
      rootDir: namespaceFixtureDir,
      initialPrompt: "/research how we use typia to enforce types in ctx.agent.run() calls in nanoboss procedures",
      createdAt: "2026-04-03T00:00:00.000Z",
      updatedAt: "2026-04-03T00:00:00.000Z",
    })}\n`);

    const emptySessionDir = join(baseDir, "session-from-client");
    mkdirSync(emptySessionDir, { recursive: true });
    writeFileSync(join(emptySessionDir, "session.json"), `${JSON.stringify({
      session: { sessionId: "session-from-client" },
      cwd: "/repo",
      rootDir: emptySessionDir,
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

    const candidates = expectCandidates(inspectSessionCleanupCandidates(baseDir));
    const selected = expectCandidates(selectCleanupCandidates(candidates, [
      "empty_dir",
      "empty_session",
      "temp_cwd",
      "fixture_session_id",
      "fixture_prompt",
    ]));
    const emptyDir = findCandidate(selected, "empty-dir");
    const tempSession = findCandidate(selected, "temp-session");
    const namespaceFixture = findCandidate(selected, "namespace-fixture");
    const emptySession = findCandidate(selected, "session-from-client");
    const legacyFixture = findCandidate(candidates, "legacy-fixture");

    expect(emptyDir.reasons).toContain("empty_dir");
    expect(emptyDir.reasons).toContain("unknown_cwd");
    expect(tempSession.reasons).toContain("temp_cwd");
    expect(tempSession.reasons).toContain("fixture_prompt");
    expect(namespaceFixture.reasons).toContain("fixture_prompt");
    expect(emptySession.reasons).toContain("empty_session");
    expect(emptySession.reasons).toContain("fixture_session_id");
    expect(legacyFixture.reasons).toContain("unknown_cwd");
    expect(selected.some((candidate) => candidate.sessionId === "legacy-fixture")).toBe(false);
  });
});

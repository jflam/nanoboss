import { describe, expect, test } from "bun:test";

import {
  formatSessionInitialPrompt,
  formatSessionLine,
} from "@nanoboss/store";
import type { SessionMetadata } from "@nanoboss/contracts";

function session(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    session: { sessionId: "session-12345678" },
    cwd: "/repo",
    rootDir: "/repo/.nanoboss/sessions/session-12345678",
    createdAt: "2026-04-03T10:00:00.000Z",
    updatedAt: "2026-04-03T11:00:00.000Z",
    ...overrides,
  };
}

describe("session-picker-format", () => {
  test("formats the full initial prompt for the selected-session preview", () => {
    expect(formatSessionInitialPrompt(session({
      initialPrompt: "  /research investigate the pi-tui migration and identify regressions  ",
    }))).toBe("/research investigate the pi-tui migration and identify regressions");
  });

  test("falls back when a session has no turns yet", () => {
    expect(formatSessionInitialPrompt(session())).toBe("(no turns yet)");
  });

  test("keeps the list row compact while the preview can show the full prompt", () => {
    const initialPrompt = "/research " + "x".repeat(160);
    const line = formatSessionLine(session({ initialPrompt }), "/repo");

    expect(line.length).toBeLessThan(initialPrompt.length);
    expect(line).toContain("...");
  });
});

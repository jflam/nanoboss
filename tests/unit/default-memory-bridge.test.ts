import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProcedureRegistry } from "../../src/registry.ts";
import { NanobossService } from "../../src/service.ts";
import type { DownstreamAgentConfig, Procedure } from "../../src/types.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path && existsSync(path)) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

function createMockConfig(
  cwd: string,
  options: {
    sessionStoreDir: string;
  },
): DownstreamAgentConfig {
  return {
    command: "bun",
    args: ["run", "tests/fixtures/mock-agent.ts"],
    cwd,
    env: {
      MOCK_AGENT_SUPPORT_LOAD_SESSION: "1",
      MOCK_AGENT_SESSION_STORE_DIR: options.sessionStoreDir,
    },
  };
}

function readStoredMockSession(sessionStoreDir: string): {
  turns: Array<{ role: "user" | "assistant"; text: string }>;
} {
  const files = readdirSync(sessionStoreDir).filter((file) => file.endsWith(".json"));
  expect(files).toHaveLength(1);
  const fileName = files[0];
  if (!fileName) {
    throw new Error("Expected stored mock session file");
  }
  return JSON.parse(readFileSync(join(sessionStoreDir, fileName), "utf8")) as {
    turns: Array<{ role: "user" | "assistant"; text: string }>;
  };
}

describe("default session memory bridge", () => {
  test("injects unsynced procedure memory once before the next default turn", async () => {
    const registry = new ProcedureRegistry(mkdtempSync(join(tmpdir(), "nab-memory-registry-")));
    tempDirs.push(registry.commandsDir);
    registry.loadBuiltins();

    const reviewProcedure: Procedure = {
      name: "review",
      description: "store a durable review result",
      async execute(prompt) {
        return {
          data: {
            subject: prompt,
            verdict: "mixed",
            critiqueMainIssue: `missing edge-case analysis for ${prompt}`,
          },
          display: "full rendered review output that should stay out of the default prompt",
          summary: `review summary for ${prompt}`,
          memory: `The most important issue for ${prompt} was missing edge-case analysis.`,
        };
      },
    };
    registry.register(reviewProcedure);

    const mockSessionStoreDir = mkdtempSync(join(tmpdir(), "nab-memory-agent-"));
    tempDirs.push(mockSessionStoreDir);

    const service = new NanobossService(
      registry,
      (cwd) => createMockConfig(cwd, { sessionStoreDir: mockSessionStoreDir }),
    );
    const session = service.createSession({ cwd: process.cwd() });

    try {
      await service.prompt(session.sessionId, "/review the code");
      await service.prompt(session.sessionId, "what mattered most?");

      const storedAfterFirstDefault = readStoredMockSession(mockSessionStoreDir);
      const firstUserPrompt = storedAfterFirstDefault.turns[0]?.text;
      expect(firstUserPrompt).toContain("Nanoboss session memory update:");
      expect(firstUserPrompt).toContain("procedure: /review");
      expect(firstUserPrompt).toContain("The most important issue for the code was missing edge-case analysis.");
      expect(firstUserPrompt).toContain("critiqueMainIssue");
      expect(firstUserPrompt).toContain("Use top_level_runs(...) to find prior chat-visible commands");
      expect(firstUserPrompt).toContain("Use session_recent(...) only for true global recency scans across the whole session; it is not the primary retrieval path.");
      expect(firstUserPrompt).toContain("If ref_read(...) returns nested refs such as critique or answer, call ref_read(...) on those refs too.");
      expect(firstUserPrompt).toContain("Do not treat not-found results from a bounded scan as proof of absence unless the search scope was exhaustive.");
      expect(firstUserPrompt).toContain("Do not inspect ~/.nanoboss/sessions directly unless the session MCP tools fail.");
      expect(firstUserPrompt).toContain("User message:\nwhat mattered most?");
      expect(firstUserPrompt).not.toContain("full rendered review output that should stay out of the default prompt");

      await service.prompt(session.sessionId, "and now?");

      const storedAfterSecondDefault = readStoredMockSession(mockSessionStoreDir);
      const secondUserPrompt = storedAfterSecondDefault.turns[2]?.text;
      expect(secondUserPrompt).toContain("Nanoboss session tool guidance:");
      expect(secondUserPrompt).toContain("Use cell_descendants(...) to inspect nested procedure and agent calls under one run; set maxDepth: 1 when you only want direct children.");
      expect(secondUserPrompt).toContain("User message:\nand now?");
    } finally {
      service.destroySession(session.sessionId);
    }
  }, 30_000);
});

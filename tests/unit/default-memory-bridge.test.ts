import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MOCK_AGENT_PATH = join(process.cwd(), "tests/fixtures/mock-agent.ts");
const SELF_COMMAND_PATH = join(process.cwd(), "dist", "nanoboss");

import { ProcedureRegistry } from "../../src/procedure/registry.ts";
import { NanobossService } from "../../src/core/service.ts";
import type { DownstreamAgentConfig } from "../../src/core/types.ts";

const tempDirs: string[] = [];
let originalSelfCommand = process.env.NANOBOSS_SELF_COMMAND;

beforeAll(() => {
  const build = spawnSync("bun", ["run", "build"], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    stdio: "pipe",
  });

  if (build.status !== 0) {
    throw new Error([build.stdout, build.stderr].filter(Boolean).join("\n"));
  }

  originalSelfCommand = process.env.NANOBOSS_SELF_COMMAND;
  process.env.NANOBOSS_SELF_COMMAND = SELF_COMMAND_PATH;
});

afterAll(() => {
  if (originalSelfCommand === undefined) {
    delete process.env.NANOBOSS_SELF_COMMAND;
  } else {
    process.env.NANOBOSS_SELF_COMMAND = originalSelfCommand;
  }
});

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
    args: ["run", MOCK_AGENT_PATH],
    cwd,
    env: {
      MOCK_AGENT_SUPPORT_LOAD_SESSION: "1",
      MOCK_AGENT_SESSION_STORE_DIR: options.sessionStoreDir,
      NANOBOSS_SELF_COMMAND: SELF_COMMAND_PATH,
    },
  };
}

function readStoredMockSession(sessionStoreDir: string): {
  turns: Array<{ role: "user" | "assistant"; text: string }>;
  mcpServers?: Array<{ name?: string; type?: string }>;
} {
  const files = readdirSync(sessionStoreDir).filter((file) => file.endsWith(".json"));
  expect(files).toHaveLength(1);
  const fileName = files[0];
  if (!fileName) {
    throw new Error("Expected stored mock session file");
  }
  return JSON.parse(readFileSync(join(sessionStoreDir, fileName), "utf8")) as {
    turns: Array<{ role: "user" | "assistant"; text: string }>;
    mcpServers?: Array<{ name?: string; type?: string }>;
  };
}

describe("default session memory bridge", () => {
  test("routes slash commands through async procedure dispatch polling and skips delayed memory injection", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "nab-memory-workspace-"));
    const commandsDir = join(cwd, "commands");
    mkdirSync(commandsDir, { recursive: true });
    writeFileSync(join(commandsDir, "review.ts"), [
      "export default {",
      '  name: "review",',
      '  description: "store a durable review result",',
      '  async execute(prompt) {',
      '    return {',
      '      data: {',
      '        subject: prompt,',
      '        verdict: "mixed",',
      '        critiqueMainIssue: `missing edge-case analysis for ${prompt}`,',
      '      },',
      '      display: "full rendered review output that should stay out of the default prompt",',
      '      summary: `review summary for ${prompt}`,',
      '      memory: `The most important issue for ${prompt} was missing edge-case analysis.`,',
      '    };',
      '  },',
      "};",
    ].join("\n"), "utf8");
    tempDirs.push(cwd);

    const registry = new ProcedureRegistry(commandsDir);
    registry.loadBuiltins();
    await registry.loadFromDisk();

    const mockSessionStoreDir = mkdtempSync(join(tmpdir(), "nab-memory-agent-"));
    tempDirs.push(mockSessionStoreDir);

    const service = new NanobossService(
      registry,
      (workspaceCwd) => createMockConfig(workspaceCwd, { sessionStoreDir: mockSessionStoreDir }),
    );
    const session = service.createSession({ cwd });

    try {
      await service.prompt(session.sessionId, "/review the code");

      const storedAfterReview = readStoredMockSession(mockSessionStoreDir);
      const dispatchPrompt = storedAfterReview.turns[0]?.text;
      expect(storedAfterReview.mcpServers?.some((server) => server.name === "nanoboss" && server.type === "stdio")).toBe(true);
      expect(dispatchPrompt).toContain("Nanoboss internal slash-command dispatch.");
      expect(dispatchPrompt).toContain('"name":"review"');
      expect(dispatchPrompt).toContain('"prompt":"the code"');
      expect(dispatchPrompt).not.toContain("Nanoboss internal session synchronization.");
      expect(dispatchPrompt).not.toContain("full rendered review output that should stay out of the default prompt");

      await service.prompt(session.sessionId, "what mattered most?");

      const storedAfterFirstDefault = readStoredMockSession(mockSessionStoreDir);
      const firstUserPrompt = storedAfterFirstDefault.turns[2]?.text;
      expect(firstUserPrompt).toContain("what mattered most?");
      expect(firstUserPrompt).not.toContain("Nanoboss session memory update:");
      expect(firstUserPrompt).not.toContain("procedure: /review");

      await service.prompt(session.sessionId, "and now?");

      const storedAfterSecondDefault = readStoredMockSession(mockSessionStoreDir);
      const secondUserPrompt = storedAfterSecondDefault.turns[4]?.text;
      expect(secondUserPrompt).toContain("and now?");
      expect(secondUserPrompt).not.toContain("Nanoboss session memory update:");
    } finally {
      service.destroySession(session.sessionId);
    }
  }, 30_000);
});

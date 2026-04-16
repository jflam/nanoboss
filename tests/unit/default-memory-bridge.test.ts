import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MOCK_AGENT_PATH = join(process.cwd(), "tests/fixtures/mock-agent.ts");
const SELF_COMMAND_PATH = join(process.cwd(), "dist", "nanoboss");
const BUILD_HOOK_TIMEOUT_MS = 30_000;

import { NanobossService } from "@nanoboss/app-runtime";
import { ProcedureRegistry } from "@nanoboss/procedure-catalog";
import type { DownstreamAgentConfig } from "@nanoboss/contracts";

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
}, BUILD_HOOK_TIMEOUT_MS);

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

async function waitForStoredMockSession(
  sessionStoreDir: string,
  timeoutMs = 5_000,
): Promise<{
  turns: Array<{ role: "user" | "assistant"; text: string }>;
  mcpServers?: Array<{ name?: string; type?: string }>;
}> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = readdirSync(sessionStoreDir).filter((file) => file.endsWith(".json"));
    if (files.length === 1) {
      return readStoredMockSession(sessionStoreDir);
    }

    await Bun.sleep(20);
  }

  return readStoredMockSession(sessionStoreDir);
}

describe("default session memory bridge", () => {
  test("injects slash-command memory into the first default follow-up without replaying full output", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "nab-memory-workspace-"));
    const procedureRoot = join(cwd, ".nanoboss", "procedures");
    const reviewPackageDir = join(procedureRoot, "review");
    mkdirSync(reviewPackageDir, { recursive: true });
    writeFileSync(join(reviewPackageDir, "index.ts"), [
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

    const registry = new ProcedureRegistry({ procedureRoots: [procedureRoot] });
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
      await service.promptSession(session.sessionId, "/review the code");

      const storedAfterReview = await waitForStoredMockSession(mockSessionStoreDir);
      expect(storedAfterReview.mcpServers?.some((server) => server.name === "nanoboss" && server.type === "stdio")).toBe(true);
      expect(storedAfterReview.turns).toHaveLength(0);

      await service.promptSession(session.sessionId, "what mattered most?");

      const storedAfterFirstDefault = await waitForStoredMockSession(mockSessionStoreDir);
      const firstUserPrompt = storedAfterFirstDefault.turns[0]?.text ?? "";
      expect(firstUserPrompt).toContain("what mattered most?");
      expect(firstUserPrompt).toContain("Nanoboss session memory update:");
      expect(firstUserPrompt).toContain("procedure: /review");
      expect(firstUserPrompt).toContain("The most important issue for the code was missing edge-case analysis.");
      expect(firstUserPrompt).toContain("Nanoboss session tool guidance:");
      expect(firstUserPrompt).not.toContain("Nanoboss internal slash-command dispatch.");
      expect(firstUserPrompt).not.toContain("full rendered review output that should stay out of the default prompt");

      await service.promptSession(session.sessionId, "and now?");

      const storedAfterSecondDefault = await waitForStoredMockSession(mockSessionStoreDir);
      const secondUserPrompt = storedAfterSecondDefault.turns[2]?.text ?? "";
      expect(secondUserPrompt).toContain("and now?");
      expect(secondUserPrompt).not.toContain("Nanoboss session memory update:");
      expect(secondUserPrompt).not.toContain("procedure: /review");
    } finally {
      service.destroySession(session.sessionId);
    }
  }, 30_000);
});

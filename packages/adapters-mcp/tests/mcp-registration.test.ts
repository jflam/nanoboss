import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  buildGlobalMcpStdioServer,
  registerSupportedAgentMcp,
} from "@nanoboss/adapters-mcp";

const tempDirs: string[] = [];
const TEST_COMMAND = {
  command: "bun",
  args: ["/repo/nanoboss.ts", "mcp"],
};
const originalSelfCommand = process.env.NANOBOSS_SELF_COMMAND;

afterEach(() => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
  restoreEnv("NANOBOSS_SELF_COMMAND", originalSelfCommand);
});

describe("mcp registration", () => {
  test("builds the session-attached nanoboss stdio MCP server config", () => {
    expect(buildGlobalMcpStdioServer(TEST_COMMAND)).toEqual({
      type: "stdio",
      name: "nanoboss",
      command: "bun",
      args: ["/repo/nanoboss.ts", "mcp"],
      env: [],
    });
  });

  test("uses the shared self-command resolver for the default mcp command", () => {
    process.env.NANOBOSS_SELF_COMMAND = "nanoboss-test";

    expect(buildGlobalMcpStdioServer()).toMatchObject({
      command: "nanoboss-test",
      args: ["mcp"],
    });
  });

  test("writes gemini and copilot registration configs", () => {
    const home = mkdtempSync(join(tmpdir(), "nanoboss-mcp-home-"));
    tempDirs.push(home);
    const pathDir = mkdtempSync(join(tmpdir(), "nanoboss-mcp-path-"));
    tempDirs.push(pathDir);

    const originalHome = process.env.HOME;
    const originalPath = process.env.PATH;
    process.env.HOME = home;
    process.env.PATH = pathDir;

    writeExecutable(join(pathDir, "gemini"));
    writeExecutable(join(pathDir, "copilot"));

    try {
      const results = registerSupportedAgentMcp(TEST_COMMAND);
      expect(resultFor(results, "gemini")).toMatchObject({ status: "registered" });
      expect(resultFor(results, "copilot")).toMatchObject({ status: "registered" });

      const geminiConfig = JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      const copilotConfig = JSON.parse(readFileSync(join(home, ".copilot", "mcp-config.json"), "utf8")) as {
        mcpServers: Record<string, unknown>;
      };

      expect(geminiConfig.mcpServers.nanoboss).toMatchObject({
        command: "bun",
        args: ["/repo/nanoboss.ts", "mcp"],
        timeout: 30_000,
      });
      expect(copilotConfig.mcpServers.nanoboss).toMatchObject({
        type: "stdio",
        command: "bun",
        args: ["/repo/nanoboss.ts", "mcp"],
      });
    } finally {
      restoreEnv("HOME", originalHome);
      restoreEnv("PATH", originalPath);
    }
  });

  test("uses agent CLIs for claude and codex registration", () => {
    const home = mkdtempSync(join(tmpdir(), "nanoboss-mcp-home-"));
    tempDirs.push(home);
    const pathDir = mkdtempSync(join(tmpdir(), "nanoboss-mcp-path-"));
    tempDirs.push(pathDir);
    const logPath = join(home, "calls.log");

    const originalHome = process.env.HOME;
    const originalPath = process.env.PATH;
    process.env.HOME = home;
    process.env.PATH = pathDir;
    writeFileSync(logPath, "", "utf8");

    writeExecutable(join(pathDir, "claude"), `#!/bin/sh\necho \"$0 $@\" >> \"${logPath}\"\nexit 0\n`);
    writeExecutable(join(pathDir, "codex"), `#!/bin/sh\necho \"$0 $@\" >> \"${logPath}\"\nexit 0\n`);

    try {
      const results = registerSupportedAgentMcp(TEST_COMMAND);
      expect(resultFor(results, "claude")).toMatchObject({ status: "registered" });
      expect(resultFor(results, "codex")).toMatchObject({ status: "registered" });

      const calls = readFileSync(logPath, "utf8");
      expect(calls).toContain("mcp add -s user nanoboss -- bun /repo/nanoboss.ts mcp");
      expect(calls).toContain("mcp add nanoboss -- bun /repo/nanoboss.ts mcp");
    } finally {
      restoreEnv("HOME", originalHome);
      restoreEnv("PATH", originalPath);
    }
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
  } else {
    process.env[name] = value;
  }
}

function writeExecutable(path: string, content = "#!/bin/sh\nexit 0\n"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

function resultFor(
  results: ReturnType<typeof registerSupportedAgentMcp>,
  id: ReturnType<typeof registerSupportedAgentMcp>[number]["id"],
): ReturnType<typeof registerSupportedAgentMcp>[number] | undefined {
  return results.find((result) => result.id === id);
}

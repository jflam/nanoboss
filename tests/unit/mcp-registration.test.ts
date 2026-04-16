import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  buildGlobalMcpStdioServer,
  registerMcpClaude,
  registerMcpCodex,
  registerMcpCopilot,
  registerMcpGemini,
} from "@nanoboss/adapters-mcp";
import { resolveSelfCommandWithRuntime } from "@nanoboss/procedure-engine";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("mcp registration", () => {
  test("builds the session-attached nanoboss stdio MCP server config", () => {
    const scriptPath = join(process.cwd(), "nanoboss.ts");
    const command = resolveSelfCommandWithRuntime("mcp", [], {
      executable: "bun",
      scriptPath,
    });

    expect(buildGlobalMcpStdioServer(command)).toEqual({
      type: "stdio",
      name: "nanoboss",
      command: "bun",
      args: [scriptPath, "mcp"],
      env: [],
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

    const scriptPath = join(process.cwd(), "nanoboss.ts");
    const command = resolveSelfCommandWithRuntime("mcp", [], {
      executable: "bun",
      scriptPath,
    });

    try {
      expect(registerMcpGemini(command)).toMatchObject({ status: "registered" });
      expect(registerMcpCopilot(command)).toMatchObject({ status: "registered" });

      const geminiConfig = JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      const copilotConfig = JSON.parse(readFileSync(join(home, ".copilot", "mcp-config.json"), "utf8")) as {
        mcpServers: Record<string, unknown>;
      };

      expect(geminiConfig.mcpServers.nanoboss).toMatchObject({
        command: "bun",
        args: [scriptPath, "mcp"],
        timeout: 30_000,
      });
      expect(copilotConfig.mcpServers.nanoboss).toMatchObject({
        type: "stdio",
        command: "bun",
        args: [scriptPath, "mcp"],
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

    writeExecutable(join(pathDir, "claude"), `#!/bin/sh\necho "$0 $@" >> "${logPath}"\nexit 0\n`);
    writeExecutable(join(pathDir, "codex"), `#!/bin/sh\necho "$0 $@" >> "${logPath}"\nexit 0\n`);

    const scriptPath = join(process.cwd(), "nanoboss.ts");
    const command = resolveSelfCommandWithRuntime("mcp", [], {
      executable: "bun",
      scriptPath,
    });

    try {
      expect(registerMcpClaude(command)).toMatchObject({ status: "registered" });
      expect(registerMcpCodex(command)).toMatchObject({ status: "registered" });

      const calls = readFileSync(logPath, "utf8");
      expect(calls).toContain(`mcp add -s user nanoboss -- bun ${scriptPath} mcp`);
      expect(calls).toContain(`mcp add nanoboss -- bun ${scriptPath} mcp`);
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

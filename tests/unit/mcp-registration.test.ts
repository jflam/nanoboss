import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  STDIO_PROXY_DESC,
  getMcpConfigClaude,
  getMcpConfigCodex,
  getMcpConfigCopilot,
  getMcpConfigGemini,
  registerMcpClaude,
  registerMcpCodex,
  registerMcpCopilot,
  registerMcpGemini,
} from "../../src/mcp-registration.ts";
import { resolveSelfCommandWithRuntime } from "../../src/self-command.ts";

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
    const command = resolveSelfCommandWithRuntime("mcp", ["proxy"], {
      executable: "bun",
      scriptPath,
    });

    try {
      expect(registerMcpGemini(command)).toEqual({ kind: "success" });
      expect(registerMcpCopilot(command)).toEqual({ kind: "success" });

      const geminiConfig = JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      const copilotConfig = JSON.parse(readFileSync(join(home, ".copilot", "mcp-config.json"), "utf8")) as {
        mcpServers: Record<string, unknown>;
      };

      expect(geminiConfig.mcpServers.nanoboss).toMatchObject({
        command: "bun",
        args: [scriptPath, "mcp", "proxy"],
        timeout: 30_000,
      });
      expect(copilotConfig.mcpServers.nanoboss).toMatchObject({
        type: "stdio",
        command: "bun",
        args: [scriptPath, "mcp", "proxy"],
      });

      expect(getMcpConfigGemini()).toEqual({ kind: "configured", description: STDIO_PROXY_DESC });
      expect(getMcpConfigCopilot()).toEqual({ kind: "configured", description: STDIO_PROXY_DESC });
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
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

    writeExecutable(join(pathDir, "claude"), `#!/bin/sh\necho \"$0 $@\" >> "${logPath}"\nexit 0\n`);
    writeExecutable(join(pathDir, "codex"), `#!/bin/sh\necho \"$0 $@\" >> "${logPath}"\nexit 0\n`);

    const scriptPath = join(process.cwd(), "nanoboss.ts");
    const command = resolveSelfCommandWithRuntime("mcp", ["proxy"], {
      executable: "bun",
      scriptPath,
    });

    try {
      expect(registerMcpClaude(command)).toEqual({ kind: "success" });
      expect(registerMcpCodex(command)).toEqual({ kind: "success" });

      const calls = readFileSync(logPath, "utf8");
      expect(calls).toContain(`mcp add -s user nanoboss -- bun ${scriptPath} mcp proxy`);
      expect(calls).toContain(`mcp add nanoboss -- bun ${scriptPath} mcp proxy`);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });

  test("reads claude and codex MCP config status", () => {
    const home = mkdtempSync(join(tmpdir(), "nanoboss-mcp-home-"));
    tempDirs.push(home);

    const originalHome = process.env.HOME;
    process.env.HOME = home;

    try {
      writeFileSync(join(home, ".claude.json"), JSON.stringify({
        mcpServers: {
          nanoboss: {
            command: "nanoboss",
            args: ["mcp", "proxy"],
          },
        },
      }), "utf8");

      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(join(home, ".codex", "config.toml"), [
        "[mcp_servers.nanoboss]",
        'command = "nanoboss"',
        'args = ["mcp", "proxy"]',
        "",
      ].join("\n"), "utf8");

      expect(getMcpConfigClaude()).toEqual({ kind: "configured", description: STDIO_PROXY_DESC });
      expect(getMcpConfigCodex()).toEqual({ kind: "configured", description: STDIO_PROXY_DESC });
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });
});

function writeExecutable(path: string, content = "#!/bin/sh\nexit 0\n"): void {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

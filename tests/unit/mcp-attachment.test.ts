import { describe, expect, test } from "bun:test";

import { buildSessionMcpServers } from "../../src/mcp-attachment.ts";

describe("session MCP attachment", () => {
  test("uses loopback HTTP for codex/claude ACP sessions", () => {
    const servers = buildSessionMcpServers({
      config: {
        provider: "codex",
        command: "codex-acp",
        args: [],
        cwd: process.cwd(),
      },
      sessionId: "session-1",
      cwd: process.cwd(),
    });

    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      type: "http",
      name: "nanoboss-session",
    });
    expect(servers[0]?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  test("uses loopback HTTP for gemini ACP sessions", () => {
    const servers = buildSessionMcpServers({
      config: {
        provider: "gemini",
        command: "gemini",
        args: ["--acp"],
        cwd: process.cwd(),
      },
      sessionId: "session-2",
      cwd: process.cwd(),
    });

    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      type: "http",
      name: "nanoboss-session",
    });
    expect(servers[0]?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });
});

import { describe, expect, test } from "bun:test";

import { buildSessionMcpServers } from "../../src/mcp-attachment.ts";

describe("session MCP attachment", () => {
  for (const provider of ["claude", "codex", "gemini", "copilot"] as const) {
    test(`uses loopback HTTP for ${provider} ACP sessions`, () => {
      const servers = buildSessionMcpServers({
        config: {
          provider,
          command: provider,
          args: [],
          cwd: process.cwd(),
        },
        sessionId: `session-${provider}`,
        cwd: process.cwd(),
      });

      expect(servers).toHaveLength(1);
      const server = servers[0];
      expect(server).toBeDefined();
      expect(server).toMatchObject({
        type: "http",
        name: "nanoboss-session",
      });
      expect(server && "url" in server ? server.url : undefined).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    });
  }
});

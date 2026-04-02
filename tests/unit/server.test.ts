import { describe, expect, test } from "bun:test";

import {
  buildTopLevelSessionMeta,
  extractNanobossSessionId,
  hasTopLevelSessionMcp,
} from "../../src/server.ts";

describe("top-level ACP session diagnostics", () => {
  test("reports command-only exposure when top-level MCP is absent", () => {
    expect(buildTopLevelSessionMeta({ topLevelMcpAttached: false })).toEqual({
      nanoboss: {
        sessionInspection: {
          topLevelMcpAttached: false,
          surface: "commands",
          commandNames: [
            "top_level_runs",
            "session_recent",
            "cell_get",
            "cell_ancestors",
            "cell_descendants",
            "ref_read",
            "ref_stat",
            "get_schema",
          ],
          note: "ACP top-level sessions can advertise availableCommands, but session MCP must be attached by the creating client through mcpServers.",
        },
      },
    });
  });

  test("reports combined MCP and command exposure when top-level MCP is attached", () => {
    expect(buildTopLevelSessionMeta({ topLevelMcpAttached: true })).toEqual({
      nanoboss: {
        sessionInspection: {
          topLevelMcpAttached: true,
          surface: "mcp+commands",
          commandNames: [
            "top_level_runs",
            "session_recent",
            "cell_get",
            "cell_ancestors",
            "cell_descendants",
            "ref_read",
            "ref_stat",
            "get_schema",
          ],
          note: "Session inspection is available through both top-level MCP tools and slash commands.",
        },
      },
    });
  });

  test("extracts a client-selected nanoboss session id from session metadata", () => {
    expect(extractNanobossSessionId({
      cwd: process.cwd(),
      mcpServers: [],
      _meta: {
        nanobossSessionId: "session-from-client",
      },
    })).toBe("session-from-client");
  });

  test("detects when the client attached top-level nanoboss session MCP", () => {
    expect(hasTopLevelSessionMcp({
      cwd: process.cwd(),
      mcpServers: [
        {
          type: "stdio",
          name: "nanoboss-session",
          command: "nanoboss",
          args: ["session-mcp", "--session-id", "session-from-client"],
          env: [],
        },
      ],
    })).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";

import {
  buildTopLevelSessionMeta,
  extractDefaultAgentSelection,
  extractNanobossSessionId,
  runAcpServerCommand,
} from "@nanoboss/adapters-acp-server";

describe("top-level ACP session diagnostics", () => {
  test("exports the ACP server command through the package boundary", () => {
    expect(runAcpServerCommand).toBeFunction();
  });

  test("reports the global MCP inspection surface", () => {
    expect(buildTopLevelSessionMeta()).toEqual({
      nanoboss: {
        sessionInspection: {
          surface: "global-mcp",
          note: "Session inspection is available through the globally registered `nanoboss` MCP server.",
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

  test("keeps ACP default agent selections when the model is omitted", () => {
    expect(extractDefaultAgentSelection({
      cwd: process.cwd(),
      mcpServers: [],
      _meta: {
        defaultAgentSelection: {
          provider: "gemini",
        },
      },
    })).toEqual({
      provider: "gemini",
    });
  });

  test("ignores ACP default agent selections with invalid providers", () => {
    expect(extractDefaultAgentSelection({
      cwd: process.cwd(),
      mcpServers: [],
      _meta: {
        defaultAgentSelection: {
          provider: "cursor",
          model: "bad-model",
        },
      },
    })).toBeUndefined();
  });
});

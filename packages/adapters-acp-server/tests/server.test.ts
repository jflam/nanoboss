import { describe, expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";

import {
  buildTopLevelSessionMeta,
  extractDefaultAgentSelection,
  extractNanobossSessionId,
  QueuedSessionUpdateEmitter,
  runAcpServerCommand,
} from "../src/server.ts";

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

  test("reclassifies buffered pre-tool assistant commentary as thought chunks for ACP clients", async () => {
    const forwarded: acp.SessionUpdate[] = [];
    const emitter = new QueuedSessionUpdateEmitter(
      {
        sessionUpdate: async ({ update }: { update: acp.SessionUpdate }) => {
          forwarded.push(update);
        },
      } as unknown as acp.AgentSideConnection,
      "session-1",
    );

    emitter.emit({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "I’m tracing the code first.",
      },
    });
    emitter.emit({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "rg",
      kind: "other",
      status: "pending",
    });
    emitter.emit({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "Fixed.",
      },
    });
    await emitter.flush();

    expect(forwarded).toEqual([
      {
        sessionUpdate: "agent_thought_chunk",
        content: {
          type: "text",
          text: "I’m tracing the code first.",
        },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "rg",
        kind: "other",
        status: "pending",
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Fixed.",
        },
      },
    ]);
  });
});

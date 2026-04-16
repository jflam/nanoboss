import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProcedureDispatchProgressEmitter } from "@nanoboss/procedure-engine";

describe("dispatch-progress", () => {
  test("forwards nested tool updates with full fidelity", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nanoboss-dispatch-progress-"));
    const progressPath = join(tempDir, "progress.jsonl");

    try {
      const emitter = new ProcedureDispatchProgressEmitter(progressPath);

      emitter.emit({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Streaming progress\n",
        },
      });

      emitter.emit({
        sessionUpdate: "tool_call",
        toolCallId: "tool-read",
        title: "Read File",
        kind: "read",
        status: "pending",
        rawInput: {
          file_path: "src/mcp/jsonrpc.ts",
          locations: [{ path: "src/mcp/jsonrpc.ts", line: 12 }],
        },
      });

      emitter.emit({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-read",
        title: "Read File",
        status: "completed",
        rawOutput: {
          type: "text",
          file: {
            filePath: "src/mcp/jsonrpc.ts",
            content: "export const hello = 1;\nexport const world = 2;",
          },
          duration_ms: 12,
        },
      });

      emitter.emit({
        sessionUpdate: "usage_update",
        used: 123,
        size: 456,
      });

      const [chunk, started, updated, usage] = readFileSync(progressPath, "utf8")
        .trim()
        .split("\n")
        .map((line): acp.SessionUpdate => JSON.parse(line) as acp.SessionUpdate);

      expect(chunk).toEqual({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Streaming progress\n",
        },
      });

      expect(started).toEqual({
        sessionUpdate: "tool_call",
        toolCallId: "tool-read",
        title: "Read File",
        kind: "read",
        status: "pending",
        rawInput: {
          file_path: "src/mcp/jsonrpc.ts",
          locations: [{ path: "src/mcp/jsonrpc.ts", line: 12 }],
        },
      });

      expect(updated).toEqual({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-read",
        title: "Read File",
        status: "completed",
        rawOutput: {
          type: "text",
          file: {
            filePath: "src/mcp/jsonrpc.ts",
            content: "export const hello = 1;\nexport const world = 2;",
          },
          duration_ms: 12,
        },
      });

      expect(usage).toEqual({
        sessionUpdate: "usage_update",
        used: 123,
        size: 456,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

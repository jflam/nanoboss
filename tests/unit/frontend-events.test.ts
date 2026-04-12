import { describe, expect, test } from "bun:test";

import { formatProcedureStatusText } from "../../src/core/ui-cli.ts";
import {
  mapSessionUpdateToFrontendEvents,
  SessionEventLog,
  toFrontendCommands,
} from "../../src/http/frontend-events.ts";

describe("frontend-events", () => {
  test("maps commands, chunks, token snapshots, and compact tool previews into render events", () => {
    const commands = toFrontendCommands([
      {
        name: "review",
        description: "Review the diff",
        input: { hint: "what to review" },
      },
    ]);

    expect(commands).toEqual([
      {
        name: "review",
        description: "Review the diff",
        inputHint: "what to review",
      },
    ]);

    expect(
      mapSessionUpdateToFrontendEvents("run-1", {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "hello",
        },
      }),
    ).toEqual([
      {
        type: "text_delta",
        runId: "run-1",
        text: "hello",
        stream: "agent",
      },
    ]);

    expect(
      mapSessionUpdateToFrontendEvents("run-1", {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Info: Operation cancelled by user\n",
        },
      }),
    ).toEqual([
      {
        type: "assistant_notice",
        runId: "run-1",
        text: "Operation cancelled by user",
        tone: "info",
      },
    ]);

    expect(
      mapSessionUpdateToFrontendEvents("run-1", {
        sessionUpdate: "usage_update",
        size: 258400,
        used: 12824,
      }),
    ).toEqual([
      {
        type: "token_usage",
        runId: "run-1",
        usage: {
          source: "acp_usage_update",
          currentContextTokens: 12824,
          maxContextTokens: 258400,
        },
        sourceUpdate: "usage_update",
      },
    ]);

    expect(
      mapSessionUpdateToFrontendEvents("run-1", {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Mock read README.md",
        kind: "read",
        status: "in_progress",
        rawInput: {
          path: "README.md",
        },
      }),
    ).toEqual([
      {
        type: "tool_started",
        runId: "run-1",
        toolCallId: "tool-1",
        title: "Mock read README.md",
        kind: "read",
        status: "in_progress",
        callPreview: {
          header: "read README.md",
        },
        rawInput: {
          path: "README.md",
        },
      },
    ]);

    expect(
      mapSessionUpdateToFrontendEvents("run-1", {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: {
          text: "The quick brown fox jumps over the lazy dog.",
          durationMs: 37,
          tokenUsage: {
            source: "copilot_log",
            currentContextTokens: 24236,
            maxContextTokens: 272000,
          },
        },
      }),
    ).toEqual([
      {
        type: "tool_updated",
        runId: "run-1",
        toolCallId: "tool-1",
        title: undefined,
        status: "completed",
        resultPreview: {
          bodyLines: ["The quick brown fox jumps over the lazy dog."],
        },
        errorPreview: undefined,
        durationMs: 37,
        rawOutput: {
          text: "The quick brown fox jumps over the lazy dog.",
          durationMs: 37,
          tokenUsage: {
            source: "copilot_log",
            currentContextTokens: 24236,
            maxContextTokens: 272000,
          },
        },
      },
      {
        type: "token_usage",
        runId: "run-1",
        usage: {
          source: "copilot_log",
          currentContextTokens: 24236,
          maxContextTokens: 272000,
        },
        sourceUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
      },
    ]);
  });

  test("normalizes namespaced bash tool titles to bash-like previews", () => {
    const [started] = mapSessionUpdateToFrontendEvents("run-1", {
      sessionUpdate: "tool_call",
      toolCallId: "tool-bash",
      title: "functions.bash",
      kind: "other",
      status: "pending",
      rawInput: {
        command: "git show --stat HEAD",
      },
    });

    expect(started).toEqual({
      type: "tool_started",
      runId: "run-1",
      toolCallId: "tool-bash",
      title: "functions.bash",
      kind: "other",
      status: "pending",
      callPreview: {
        header: "$ git show --stat HEAD",
      },
      rawInput: {
        command: "git show --stat HEAD",
      },
    });
  });

  test("tool previews are bounded and failed tool updates surface compact errors", () => {
    const [started] = mapSessionUpdateToFrontendEvents("run-1", {
      sessionUpdate: "tool_call",
      toolCallId: "tool-bash",
      title: "bash",
      kind: "other",
      status: "pending",
      rawInput: {
        command: `printf '${"x".repeat(400)}'`,
      },
    });
    const [updated] = mapSessionUpdateToFrontendEvents("run-1", {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-bash",
      title: "bash",
      status: "failed",
      rawOutput: {
        error: `stderr: ${"boom ".repeat(80)}`,
      },
    });

    expect(started?.type).toBe("tool_started");
    expect(started?.type === "tool_started" && started.callPreview?.header?.length).toBeLessThanOrEqual(140);

    expect(updated?.type).toBe("tool_updated");
    expect(updated?.type === "tool_updated" && updated.errorPreview?.bodyLines?.[0]).toContain("stderr:");
    expect(updated?.type === "tool_updated" && updated.errorPreview?.bodyLines?.[0]?.length).toBeLessThanOrEqual(160);
  });

  test("maps nanoboss ui markers into structured procedure status and card events", () => {
    expect(
      mapSessionUpdateToFrontendEvents("run-1", {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: '[[nanoboss-ui]] {"type":"status","procedure":"research","phase":"collect","message":"Gathering sources","iteration":"2/3","waiting":true}\n',
        },
      }),
    ).toEqual([
      {
        type: "procedure_status",
        runId: "run-1",
        procedure: "research",
        phase: "collect",
        message: "Gathering sources",
        iteration: "2/3",
        autoApprove: undefined,
        waiting: true,
      },
    ]);

    expect(
      mapSessionUpdateToFrontendEvents("run-1", {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: '[[nanoboss-ui]] {"type":"card","procedure":"research","kind":"report","title":"Checkpoint","markdown":"- cited source"}\n',
        },
      }),
    ).toEqual([
      {
        type: "procedure_card",
        runId: "run-1",
        procedure: "research",
        kind: "report",
        title: "Checkpoint",
        markdown: "- cited source",
      },
    ]);
  });

  test("formats procedure status text from one shared status matrix", () => {
    expect(formatProcedureStatusText({
      type: "status",
      procedure: "research",
      message: "Gathering sources",
    })).toBe("[status] /research - Gathering sources");

    expect(formatProcedureStatusText({
      type: "status",
      procedure: "research",
      phase: "collect",
      message: "Gathering sources",
      iteration: "2/3",
      autoApprove: true,
      waiting: true,
    })).toBe("[status] /research collect 2/3 - Gathering sources (auto-approve, waiting)");
  });

  test("normalizes provider-specific read payloads into consistent previews", () => {
    const [started] = mapSessionUpdateToFrontendEvents("run-1", {
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

    const [updated] = mapSessionUpdateToFrontendEvents("run-1", {
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

    expect(started).toEqual({
      type: "tool_started",
      runId: "run-1",
      toolCallId: "tool-read",
      title: "Read File",
      kind: "read",
      status: "pending",
      callPreview: {
        header: "read src/mcp/jsonrpc.ts:12",
      },
      rawInput: {
        file_path: "src/mcp/jsonrpc.ts",
        locations: [{ path: "src/mcp/jsonrpc.ts", line: 12 }],
      },
    });

    expect(updated).toEqual({
      type: "tool_updated",
      runId: "run-1",
      toolCallId: "tool-read",
      title: "Read File",
      status: "completed",
      resultPreview: {
        bodyLines: [
          "export const hello = 1;",
          "export const world = 2;",
        ],
      },
      errorPreview: undefined,
      durationMs: 12,
      rawOutput: {
        type: "text",
        file: {
          filePath: "src/mcp/jsonrpc.ts",
          content: "export const hello = 1;\nexport const world = 2;",
        },
        duration_ms: 12,
      },
    });
  });

  test("stores replayable session events with increasing sequence numbers", () => {
    const log = new SessionEventLog(2);
    const first = log.publish("session-1", {
      type: "commands_updated",
      commands: [],
    });
    const second = log.publish("session-1", {
      type: "run_started",
      runId: "run-1",
      procedure: "default",
      prompt: "hello",
      startedAt: "2026-03-31T00:00:00.000Z",
    });
    const third = log.publish("session-1", {
      type: "run_failed",
      runId: "run-1",
      procedure: "default",
      completedAt: "2026-03-31T00:00:01.000Z",
      error: "boom",
    });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(third.seq).toBe(3);
    expect(log.after(-1).map((event) => event.seq)).toEqual([2, 3]);
    expect(log.after(2).map((event) => event.seq)).toEqual([3]);
  });
});

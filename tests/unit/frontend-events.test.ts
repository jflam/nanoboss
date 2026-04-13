import { describe, expect, test } from "bun:test";

import type { ProcedureUiEvent } from "../../src/core/context-shared.ts";
import { formatProcedureStatusText } from "../../src/core/ui-cli.ts";
import {
  mapProcedureUiEventToFrontendEvent,
  mapSessionUpdateToFrontendEvents,
  SessionEventLog,
  toReplayableFrontendEvent,
  toFrontendCommands,
} from "../../src/http/frontend-events.ts";

describe("frontend-events", () => {
  const statusEvent = {
    type: "status",
    procedure: "research",
    phase: "collect",
    message: "Gathering sources",
    iteration: "2/3",
    waiting: true,
  } satisfies Extract<ProcedureUiEvent, { type: "status" }>;
  const cardEvent = {
    type: "card",
    procedure: "research",
    kind: "report",
    title: "Checkpoint",
    markdown: "- cited source",
  } satisfies Extract<ProcedureUiEvent, { type: "card" }>;

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
        toolName: "read",
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
      toolName: "bash",
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

  test("maps failed ACP tool updates with explicit cancelled output to cancelled frontend tool status", () => {
    expect(
      mapSessionUpdateToFrontendEvents("run-1", {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "failed",
        rawOutput: {
          error: "Stopped.",
          cancelled: true,
        },
      }),
    ).toEqual([
      {
        type: "tool_updated",
        runId: "run-1",
        toolCallId: "tool-1",
        title: undefined,
        status: "cancelled",
        resultPreview: undefined,
        errorPreview: {
          bodyLines: ["Stopped."],
        },
        durationMs: undefined,
        rawOutput: {
          error: "Stopped.",
          cancelled: true,
        },
      },
    ]);
  });

  test("treats raw procedure ui marker text as plain text at the frontend event boundary", () => {
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
        type: "text_delta",
        runId: "run-1",
        text: '[[nanoboss-ui]] {"type":"status","procedure":"research","phase":"collect","message":"Gathering sources","iteration":"2/3","waiting":true}\n',
        stream: "agent",
      },
    ]);

    expect(
      mapSessionUpdateToFrontendEvents("run-1", {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `[[nanoboss-ui]] ${JSON.stringify(cardEvent)}\n`,
        },
      }),
    ).toEqual([
      {
        type: "text_delta",
        runId: "run-1",
        text: `[[nanoboss-ui]] ${JSON.stringify(cardEvent)}\n`,
        stream: "agent",
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

  test("maps typed procedure status events into shared frontend events without transport reshaping", () => {
    const event = mapProcedureUiEventToFrontendEvent("run-1", statusEvent);

    expect(event).toEqual({
      type: "procedure_status",
      runId: "run-1",
      status: statusEvent,
    });
    expect(event.type === "procedure_status" && formatProcedureStatusText(event.status)).toBe("[status] /research collect 2/3 - Gathering sources (waiting)");
  });

  test("maps typed procedure card events into shared frontend events without transport reshaping", () => {
    const event = mapProcedureUiEventToFrontendEvent("run-1", cardEvent);

    expect(event).toEqual({
      type: "procedure_card",
      runId: "run-1",
      card: cardEvent,
    });
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
      toolName: "read",
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
      toolName: "read",
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

  test("preserves producer-owned wrapper kind without title heuristics", () => {
    expect(
      mapSessionUpdateToFrontendEvents("run-1", {
        sessionUpdate: "tool_call",
        toolCallId: "tool-wrapper",
        title: "callAgent: summarize the diff",
        kind: "other",
        _meta: {
          nanoboss: {
            toolKind: "wrapper",
          },
        },
        status: "pending",
      }),
    ).toEqual([
      {
        type: "tool_started",
        runId: "run-1",
        toolCallId: "tool-wrapper",
        title: "callAgent: summarize the diff",
        kind: "wrapper",
        toolName: "agent",
        status: "pending",
        callPreview: undefined,
        rawInput: undefined,
      },
    ]);
  });

  test("maps producer-owned parentage and visibility metadata onto frontend tool events", () => {
    expect(
      mapSessionUpdateToFrontendEvents("run-1", {
        sessionUpdate: "tool_call",
        toolCallId: "tool-child",
        title: "procedure_dispatch_wait",
        kind: "other",
        _meta: {
          nanoboss: {
            parentToolCallId: "tool-parent",
            transcriptVisible: false,
            removeOnTerminal: true,
          },
        },
      }),
    ).toEqual([
      {
        type: "tool_started",
        runId: "run-1",
        toolCallId: "tool-child",
        parentToolCallId: "tool-parent",
        transcriptVisible: false,
        removeOnTerminal: true,
        title: "procedure_dispatch_wait",
        kind: "other",
        toolName: "procedure_dispatch_wait",
        status: undefined,
        callPreview: undefined,
        rawInput: undefined,
      },
    ]);

    expect(
      mapSessionUpdateToFrontendEvents("run-1", {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-child",
        title: "procedure_dispatch_wait",
        status: "completed",
        _meta: {
          nanoboss: {
            parentToolCallId: "tool-parent",
            transcriptVisible: false,
            removeOnTerminal: true,
          },
        },
      }),
    ).toEqual([
      {
        type: "tool_updated",
        runId: "run-1",
        toolCallId: "tool-child",
        parentToolCallId: "tool-parent",
        transcriptVisible: false,
        removeOnTerminal: true,
        title: "procedure_dispatch_wait",
        toolName: "procedure_dispatch_wait",
        status: "completed",
        resultPreview: undefined,
        errorPreview: undefined,
        durationMs: undefined,
        rawOutput: undefined,
      },
    ]);
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

  test("flattens replayable frontend envelopes without re-copying payload semantics", () => {
    const log = new SessionEventLog();
    const started = log.publish("session-1", {
      type: "run_started",
      runId: "run-1",
      procedure: "default",
      prompt: "hello",
      startedAt: "2026-03-31T00:00:00.000Z",
    });
    const toolStarted = log.publish("session-1", {
      type: "tool_started",
      runId: "run-1",
      toolCallId: "tool-1",
      parentToolCallId: "wrapper-1",
      title: "Mock read README.md",
      kind: "read",
    });
    const completed = log.publish("session-1", {
      type: "run_completed",
      runId: "run-1",
      procedure: "default",
      completedAt: "2026-03-31T00:00:01.000Z",
      cell: {
        sessionId: "session-1",
        cellId: "cell-1",
      },
      summary: "done",
      display: "done\n",
    });

    expect(toReplayableFrontendEvent(started, "run-1")).toBeUndefined();
    expect(toReplayableFrontendEvent(completed, "other-run")).toBeUndefined();
    expect(toReplayableFrontendEvent(toolStarted, "run-1")).toEqual({
      type: "tool_started",
      runId: "run-1",
      toolCallId: "tool-1",
      parentToolCallId: "wrapper-1",
      title: "Mock read README.md",
      kind: "read",
    });
    expect(toReplayableFrontendEvent(completed, "run-1")).toEqual({
      type: "run_completed",
      runId: "run-1",
      procedure: "default",
      completedAt: "2026-03-31T00:00:01.000Z",
      cell: {
        sessionId: "session-1",
        cellId: "cell-1",
      },
      summary: "done",
      display: "done\n",
    });
  });
});

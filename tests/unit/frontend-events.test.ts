import { describe, expect, test } from "bun:test";

import {
  mapSessionUpdateToFrontendEvents,
  SessionEventLog,
  toFrontendCommands,
} from "../../src/frontend-events.ts";

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
        inputSummary: "README.md",
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
        outputSummary: "The quick brown fox jumps over the lazy dog.",
        errorSummary: undefined,
        durationMs: 37,
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

  test("tool previews are truncated and failed tool updates surface compact errors", () => {
    const [started] = mapSessionUpdateToFrontendEvents("run-1", {
      sessionUpdate: "tool_call",
      toolCallId: "tool-bash",
      title: "bash",
      kind: "bash",
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
    expect(started?.type === "tool_started" && started.inputSummary?.length).toBeLessThanOrEqual(140);

    expect(updated?.type).toBe("tool_updated");
    expect(updated?.type === "tool_updated" && updated.errorSummary).toContain("stderr:");
    expect(updated?.type === "tool_updated" && updated.errorSummary?.length).toBeLessThanOrEqual(180);
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

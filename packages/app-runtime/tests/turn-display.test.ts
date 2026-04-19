import { describe, expect, test } from "bun:test";

import { buildTurnDisplay, type PersistedRuntimeEvent } from "@nanoboss/app-runtime";

type Event = PersistedRuntimeEvent;

function textDelta(text: string): Event {
  return { type: "text_delta", runId: "run-1", text, stream: "agent" };
}

function toolStarted(toolCallId: string): Event {
  return {
    type: "tool_started",
    runId: "run-1",
    toolCallId,
    title: `tool ${toolCallId}`,
    kind: "read",
    status: "pending",
  };
}

function toolUpdated(toolCallId: string): Event {
  return {
    type: "tool_updated",
    runId: "run-1",
    toolCallId,
    status: "completed",
  };
}

describe("buildTurnDisplay", () => {
  test("projects text deltas and a tool call into three boundary-preserving blocks", () => {
    const display = buildTurnDisplay(
      [
        textDelta("a"),
        toolStarted("t1"),
        toolUpdated("t1"),
        textDelta("b"),
      ],
      { origin: "replay" },
    );

    expect(display.blocks).toEqual([
      { kind: "text", text: "a", origin: "replay" },
      { kind: "tool_call", toolCallId: "t1" },
      { kind: "text", text: "b", origin: "replay" },
    ]);
  });

  test("coalesces consecutive text deltas without an intervening tool event", () => {
    const display = buildTurnDisplay(
      [textDelta("hello "), textDelta("world"), textDelta("!")],
      { origin: "stream" },
    );

    expect(display.blocks).toEqual([
      { kind: "text", text: "hello world!", origin: "stream" },
    ]);
  });

  test("does not duplicate a tool_call block when tool_updated follows tool_started", () => {
    const display = buildTurnDisplay([
      toolStarted("t1"),
      toolUpdated("t1"),
      toolUpdated("t1"),
    ]);

    expect(display.blocks).toEqual([
      { kind: "tool_call", toolCallId: "t1" },
    ]);
  });
});

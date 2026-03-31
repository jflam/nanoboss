import { describe, expect, test } from "bun:test";

import {
  mapSessionUpdateToFrontendEvents,
  SessionEventLog,
  toFrontendCommands,
} from "../../src/frontend-events.ts";

describe("frontend-events", () => {
  test("maps commands and chunks into render events", () => {
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

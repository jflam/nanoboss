import { describe, expect, test } from "bun:test";

import type { RenderedFrontendEventEnvelope } from "@nanoboss/adapters-http";
import { createInitialUiState, reduceUiState } from "@nanoboss/adapters-tui";

describe("tui turn blocks regression", () => {
  test("two interstitials plus a final message render three text blocks without duplicating the final message on run_completed", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });

    state = reduceUiState(state, {
      type: "session_ready",
      sessionId: "session-1",
      cwd: "/repo",
      buildLabel: "nanoboss-test",
      agentLabel: "copilot/default",
      autoApprove: false,
      commands: [],
    });
    state = reduceUiState(state, {
      type: "local_user_submitted",
      text: "go",
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: envelope("run_started", {
        runId: "run-1",
        procedure: "default",
        prompt: "go",
        startedAt: new Date(0).toISOString(),
      }),
    });

    // interstitial 1
    state = reduceUiState(state, {
      type: "frontend_event",
      event: envelope("text_delta", { runId: "run-1", text: "thinking about step one", stream: "agent" }),
    });
    // tool 1
    state = reduceUiState(state, {
      type: "frontend_event",
      event: envelope("tool_started", {
        runId: "run-1",
        toolCallId: "tool-1",
        title: "read a.txt",
        kind: "read",
        callPreview: { header: "read a.txt" },
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: envelope("tool_updated", {
        runId: "run-1",
        toolCallId: "tool-1",
        status: "completed",
        resultPreview: { bodyLines: ["ok"] },
      }),
    });

    // interstitial 2
    state = reduceUiState(state, {
      type: "frontend_event",
      event: envelope("text_delta", { runId: "run-1", text: "now calling another tool", stream: "agent" }),
    });
    // tool 2
    state = reduceUiState(state, {
      type: "frontend_event",
      event: envelope("tool_started", {
        runId: "run-1",
        toolCallId: "tool-2",
        title: "read b.txt",
        kind: "read",
        callPreview: { header: "read b.txt" },
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: envelope("tool_updated", {
        runId: "run-1",
        toolCallId: "tool-2",
        status: "completed",
        resultPreview: { bodyLines: ["ok"] },
      }),
    });

    // final message
    state = reduceUiState(state, {
      type: "frontend_event",
      event: envelope("text_delta", { runId: "run-1", text: "all done", stream: "agent" }),
    });

    // run_completed with a display fallback that matches the already-streamed final message
    state = reduceUiState(state, {
      type: "frontend_event",
      event: envelope("run_completed", {
        runId: "run-1",
        procedure: "default",
        completedAt: new Date(1).toISOString(),
        run: { sessionId: "session-1", runId: "cell-1" },
        display: "all done",
      }),
    });

    const assistantTurns = state.turns.filter((turn) => turn.role === "assistant");
    expect(assistantTurns.map((turn) => turn.markdown)).toEqual([
      "thinking about step one",
      "now calling another tool",
      "all done",
    ]);

    // Each assistant turn should carry a single streamed text block.
    for (const turn of assistantTurns) {
      expect(turn.blocks).toBeDefined();
      const textBlocks = (turn.blocks ?? []).filter((block) => block.kind === "text");
      expect(textBlocks).toHaveLength(1);
      expect(textBlocks[0]).toMatchObject({ kind: "text", origin: "stream" });
    }

    // Transcript interleaves text turns with tool cards: user, turn, tool, turn, tool, turn.
    expect(state.transcriptItems).toEqual([
      { type: "turn", id: "user-1" },
      { type: "turn", id: "assistant-2" },
      { type: "tool_call", id: "tool-1" },
      { type: "turn", id: "assistant-3" },
      { type: "tool_call", id: "tool-2" },
      { type: "turn", id: "assistant-4" },
    ]);

    // Final message must not be duplicated: only one assistant turn whose
    // markdown equals the run-completed display string.
    const duplicatedFinal = assistantTurns.filter((turn) => turn.markdown === "all done");
    expect(duplicatedFinal).toHaveLength(1);
  });
});

function envelope<EventType extends RenderedFrontendEventEnvelope["type"]>(
  type: EventType,
  data: Extract<RenderedFrontendEventEnvelope, { type: EventType }>["data"],
): RenderedFrontendEventEnvelope {
  return {
    sessionId: "session-1",
    seq: 1,
    type,
    data,
  } as RenderedFrontendEventEnvelope;
}

import { describe, expect, test } from "bun:test";

import type { FrontendEventEnvelope } from "../../src/frontend-events.ts";
import { reduceUiState } from "../../src/tui/reducer.ts";
import { createInitialUiState } from "../../src/tui/state.ts";

describe("tui reducer", () => {
  test("tracks a streamed run lifecycle, interleaves tool cards in the transcript, and reenables input on completion", () => {
    let state = createInitialUiState({ cwd: "/repo", buildLabel: "nanoboss-test", showToolCalls: true });

    state = reduceUiState(state, {
      type: "session_ready",
      sessionId: "session-1",
      buildLabel: "nanoboss-test",
      agentLabel: "copilot/default",
      commands: [{ name: "tokens", description: "show tokens" }],
    });
    state = reduceUiState(state, {
      type: "local_user_submitted",
      text: "hello",
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_started", {
        runId: "run-1",
        procedure: "default",
        prompt: "hello",
        startedAt: new Date(0).toISOString(),
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("text_delta", {
        runId: "run-1",
        text: "hi",
        stream: "agent",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_started", {
        runId: "run-1",
        toolCallId: "tool-1",
        title: "Mock read README.md",
        kind: "read",
        status: "pending",
        inputSummary: "README.md",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_updated", {
        runId: "run-1",
        toolCallId: "tool-1",
        status: "completed",
        outputSummary: "hello from read",
        durationMs: 17,
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("text_delta", {
        runId: "run-1",
        text: " there",
        stream: "agent",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_completed", {
        runId: "run-1",
        procedure: "default",
        completedAt: new Date(1).toISOString(),
        cell: { sessionId: "session-1", cellId: "cell-1" },
        tokenUsage: {
          source: "acp_usage_update",
          currentContextTokens: 512,
          maxContextTokens: 8192,
        },
      }),
    });

    expect(state.turns.map((turn) => ({ role: turn.role, markdown: turn.markdown, status: turn.status }))).toEqual([
      { role: "user", markdown: "hello", status: "complete" },
      { role: "assistant", markdown: "hi", status: "complete" },
      { role: "assistant", markdown: " there", status: "complete" },
    ]);
    expect(state.transcriptItems).toEqual([
      { type: "turn", id: "user-1" },
      { type: "turn", id: "assistant-2" },
      { type: "tool_call", id: "tool-1" },
      { type: "turn", id: "assistant-3" },
    ]);
    expect(state.toolCalls).toEqual([
      {
        id: "tool-1",
        runId: "run-1",
        title: "Mock read README.md",
        kind: "read",
        status: "completed",
        depth: 0,
        isWrapper: false,
        inputSummary: "README.md",
        outputSummary: "hello from read",
        errorSummary: undefined,
        durationMs: 17,
      },
    ]);
    expect(state.turns[2]?.meta?.tokenUsageLine).toContain("[tokens] 512 / 8,192");
    expect(state.inputDisabled).toBe(false);
    expect(state.activeRunId).toBeUndefined();
  });

  test("completed tool cards persist after run completion", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });

    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_started", {
        runId: "run-1",
        procedure: "default",
        prompt: "hello",
        startedAt: new Date(0).toISOString(),
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_started", {
        runId: "run-1",
        toolCallId: "tool-1",
        title: "Running tests",
        kind: "bash",
        inputSummary: "bun test",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_updated", {
        runId: "run-1",
        toolCallId: "tool-1",
        status: "completed",
        outputSummary: "12 passed",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_completed", {
        runId: "run-1",
        procedure: "default",
        completedAt: new Date(1).toISOString(),
        cell: { sessionId: "session-1", cellId: "cell-1" },
      }),
    });

    expect(state.toolCalls).toHaveLength(1);
    expect(state.toolCalls[0]).toMatchObject({
      id: "tool-1",
      status: "completed",
      outputSummary: "12 passed",
    });
    expect(state.transcriptItems).toContainEqual({ type: "tool_call", id: "tool-1" });
  });

  test("suppresses async dispatch wait traces while preserving nested activity depth", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });

    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_started", {
        runId: "run-1",
        procedure: "probe",
        prompt: "",
        startedAt: new Date(0).toISOString(),
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_started", {
        runId: "run-1",
        toolCallId: "dispatch-wait",
        title: "nanoboss-procedure_dispatch_wait",
        kind: "other",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_started", {
        runId: "run-1",
        toolCallId: "nested-child",
        title: "Mock read README.md",
        kind: "read",
      }),
    });

    expect(state.toolCalls).toEqual([
      {
        id: "nested-child",
        runId: "run-1",
        title: "Mock read README.md",
        kind: "read",
        status: "pending",
        depth: 1,
        isWrapper: false,
        inputSummary: undefined,
        outputSummary: undefined,
        errorSummary: undefined,
        durationMs: undefined,
      },
    ]);
    expect(state.hiddenToolCallIds).toEqual(["dispatch-wait"]);
    expect(state.activeWrapperToolCallIds).toEqual(["dispatch-wait"]);

    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_updated", {
        runId: "run-1",
        toolCallId: "dispatch-wait",
        status: "completed",
      }),
    });

    expect(state.hiddenToolCallIds).toEqual([]);
    expect(state.activeWrapperToolCallIds).toEqual([]);
    expect(state.toolCalls[0]).toMatchObject({ id: "nested-child", depth: 0 });
  });

  test("removes completed visible wrapper cards while retaining and reparents descendants", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });

    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_started", {
        runId: "run-1",
        procedure: "default",
        prompt: "hello",
        startedAt: new Date(0).toISOString(),
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_started", {
        runId: "run-1",
        toolCallId: "wrapper",
        title: "defaultSession: hello",
        kind: "wrapper",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_started", {
        runId: "run-1",
        toolCallId: "leaf",
        title: "Mock read README.md",
        kind: "read",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_updated", {
        runId: "run-1",
        toolCallId: "wrapper",
        status: "completed",
      }),
    });

    expect(state.toolCalls.map((toolCall) => toolCall.id)).toEqual(["leaf"]);
    expect(state.toolCalls[0]).toMatchObject({ depth: 0 });
    expect(state.transcriptItems).not.toContainEqual({ type: "tool_call", id: "wrapper" });
    expect(state.transcriptItems).toContainEqual({ type: "tool_call", id: "leaf" });
  });

  test("out-of-order tool updates synthesize a placeholder card", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });

    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_updated", {
        runId: "run-1",
        toolCallId: "tool-missing",
        title: "write",
        status: "failed",
        errorSummary: "permission denied",
      }),
    });

    expect(state.toolCalls).toEqual([
      {
        id: "tool-missing",
        runId: "run-1",
        title: "write",
        kind: "other",
        status: "failed",
        depth: 0,
        isWrapper: false,
        inputSummary: undefined,
        outputSummary: undefined,
        errorSummary: "permission denied",
        durationMs: undefined,
      },
    ]);
    expect(state.transcriptItems).toContainEqual({ type: "tool_call", id: "tool-missing" });
  });

  test("does not create tool cards or split assistant text when tool cards are hidden by preference", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: false });

    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_started", {
        runId: "run-1",
        procedure: "default",
        prompt: "hello",
        startedAt: new Date(0).toISOString(),
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("text_delta", {
        runId: "run-1",
        text: "First sentence.",
        stream: "agent",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_started", {
        runId: "run-1",
        toolCallId: "tool-1",
        title: "Mock read README.md",
        kind: "read",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("text_delta", {
        runId: "run-1",
        text: "Second sentence.",
        stream: "agent",
      }),
    });

    expect(state.toolCalls).toEqual([]);
    expect(state.turns.at(-1)?.markdown).toBe("First sentence.Second sentence.");
    expect(state.transcriptItems).toEqual([{ type: "turn", id: "assistant-1" }]);
  });

  test("session_ready resets retained transcript state and merges local slash commands with server commands", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });

    state = reduceUiState(state, {
      type: "local_user_submitted",
      text: "hello",
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_started", {
        runId: "run-1",
        toolCallId: "tool-parent",
        title: "defaultSession: hello",
        kind: "wrapper",
      }),
    });
    state = reduceUiState(state, {
      type: "local_status",
      text: "stale status",
    });

    state = reduceUiState(state, {
      type: "session_ready",
      sessionId: "session-1",
      buildLabel: "nanoboss-test",
      agentLabel: "copilot/default",
      commands: [{ name: "tokens", description: "show tokens" }],
    });

    expect(state.turns).toEqual([]);
    expect(state.toolCalls).toEqual([]);
    expect(state.transcriptItems).toEqual([]);
    expect(state.statusLine).toBeUndefined();
    expect(state.availableCommands).toEqual([
      "/tokens",
      "/new",
      "/end",
      "/quit",
      "/exit",
      "/model",
    ]);
  });
});

function eventEnvelope<EventType extends FrontendEventEnvelope["type"]>(
  type: EventType,
  data: Extract<FrontendEventEnvelope, { type: EventType }>['data'],
): FrontendEventEnvelope {
  return {
    sessionId: "session-1",
    seq: 1,
    type,
    data,
  } as FrontendEventEnvelope;
}

import { describe, expect, test } from "bun:test";

import { reduceUiState } from "../../src/tui/reducer.ts";
import { createInitialUiState } from "../../src/tui/state.ts";
import type { FrontendEventEnvelope } from "../../src/frontend-events.ts";

describe("tui reducer", () => {
  test("tracks a streamed run lifecycle and reenables input on completion", () => {
    let state = createInitialUiState({ cwd: "/repo", buildLabel: "nanoboss-test" });

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
      { role: "assistant", markdown: "hi there", status: "complete" },
    ]);
    expect(state.turns[1]?.meta?.tokenUsageLine).toContain("[tokens] 512 / 8,192");
    expect(state.inputDisabled).toBe(false);
    expect(state.activeRunId).toBeUndefined();
  });

  test("tracks nested wrapper tool depth", () => {
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
        toolCallId: "tool-parent",
        title: "defaultSession: hello",
        kind: "wrapper",
      }),
    });

    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_started", {
        runId: "run-1",
        toolCallId: "tool-child",
        title: "Mock read README.md",
        kind: "read",
      }),
    });

    expect(state.toolCalls).toEqual([
      {
        id: "tool-parent",
        title: "defaultSession: hello",
        status: "pending",
        depth: 0,
        isWrapper: true,
      },
      {
        id: "tool-child",
        title: "Mock read README.md",
        status: "pending",
        depth: 1,
        isWrapper: false,
      },
    ]);
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
        toolCallId: "dispatch-start",
        title: "procedure_dispatch_start",
        kind: "other",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_updated", {
        runId: "run-1",
        toolCallId: "dispatch-start",
        status: "completed",
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
        title: "Mock read README.md",
        status: "pending",
        depth: 1,
        isWrapper: false,
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
    expect(state.toolCalls).toEqual([
      {
        id: "nested-child",
        title: "Mock read README.md",
        status: "pending",
        depth: 0,
        isWrapper: false,
      },
    ]);
  });

  test("reparents retained activity after a suppressed wrapper completes", () => {
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
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_updated", {
        runId: "run-1",
        toolCallId: "dispatch-wait",
        status: "completed",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_updated", {
        runId: "run-1",
        toolCallId: "nested-child",
        status: "completed",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_started", {
        runId: "run-1",
        toolCallId: "root-tool",
        title: "Running tests",
        kind: "thought",
      }),
    });

    expect(state.toolCalls).toEqual([
      {
        id: "root-tool",
        title: "Running tests",
        status: "pending",
        depth: 0,
        isWrapper: false,
      },
    ]);
  });

  test("stores prompt diagnostics and token usage lines from frontend events", () => {
    let state = createInitialUiState({ cwd: "/repo" });

    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("prompt_diagnostics", {
        runId: "run-1",
        diagnostics: {
          method: "tiktoken",
          encoding: "o200k_base",
          totalTokens: 321,
          guidanceTokens: 21,
          userMessageTokens: 100,
          cards: [],
        },
      }),
    });

    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("token_usage", {
        runId: "run-1",
        usage: {
          source: "acp_usage_update",
          currentContextTokens: 512,
          maxContextTokens: 8192,
        },
        sourceUpdate: "usage_update",
      }),
    });

    expect(state.promptDiagnosticsLine).toContain("[prompt]");
    expect(state.promptDiagnosticsLine).toContain("321");
    expect(state.tokenUsageLine).toContain("[tokens] 512 / 8,192");
  });

  test("keeps the latest completed leaf tool visible until the next sibling replaces it", () => {
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
        toolCallId: "tool-parent",
        title: "defaultSession: hello",
        kind: "wrapper",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_started", {
        runId: "run-1",
        toolCallId: "tool-leaf-1",
        title: "Reviewing changed code",
        kind: "thought",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_updated", {
        runId: "run-1",
        toolCallId: "tool-leaf-1",
        status: "completed",
      }),
    });

    expect(state.toolCalls).toContainEqual({
      id: "tool-leaf-1",
      title: "Reviewing changed code",
      status: "completed",
      depth: 1,
      isWrapper: false,
    });

    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_started", {
        runId: "run-1",
        toolCallId: "tool-leaf-2",
        title: "Running tests",
        kind: "thought",
      }),
    });

    expect(state.toolCalls.some((toolCall) => toolCall.id === "tool-leaf-1")).toBe(false);
    expect(state.toolCalls).toContainEqual({
      id: "tool-leaf-2",
      title: "Running tests",
      status: "pending",
      depth: 1,
      isWrapper: false,
    });
  });

  test("removes completed wrapper tool calls, clears retained descendants, and reenables input on run failure", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });

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
      event: eventEnvelope("tool_started", {
        runId: "run-1",
        toolCallId: "tool-parent",
        title: "defaultSession: hello",
        kind: "wrapper",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_started", {
        runId: "run-1",
        toolCallId: "tool-leaf",
        title: "Reviewing changed code",
        kind: "thought",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_updated", {
        runId: "run-1",
        toolCallId: "tool-leaf",
        status: "completed",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_updated", {
        runId: "run-1",
        toolCallId: "tool-parent",
        status: "completed",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_failed", {
        runId: "run-1",
        procedure: "default",
        completedAt: new Date(1).toISOString(),
        error: "boom",
      }),
    });

    expect(state.toolCalls).toEqual([]);
    expect(state.activeWrapperToolCallIds).toEqual([]);
    expect(state.inputDisabled).toBe(false);
    expect(state.turns.at(-1)).toMatchObject({
      role: "assistant",
      markdown: "boom",
      status: "failed",
    });
    expect(state.turns.at(-1)?.meta?.failureMessage).toBeUndefined();
  });

  test("preserves streamed assistant text on failure and stores the failure message separately", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });

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
        text: "partial useful answer",
        stream: "agent",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_failed", {
        runId: "run-1",
        procedure: "default",
        completedAt: new Date(1).toISOString(),
        error: "boom",
      }),
    });

    expect(state.turns.at(-1)).toMatchObject({
      role: "assistant",
      markdown: "partial useful answer",
      status: "failed",
      meta: {
        failureMessage: "boom",
      },
    });
  });

  test("inserts a paragraph break before new assistant status text after tool activity", () => {
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

    expect(state.turns.at(-1)?.markdown).toBe("First sentence.\n\nSecond sentence.");
  });

  test("does not insert a paragraph break when tool activity is hidden by preference", () => {
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

    expect(state.turns.at(-1)?.markdown).toBe("First sentence.Second sentence.");
  });

  test("does not insert a paragraph break when tool activity is suppressed", () => {
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
        toolCallId: "dispatch-wait",
        title: "nanoboss-procedure_dispatch_wait",
        kind: "other",
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

    expect(state.turns.at(-1)?.markdown).toBe("First sentence.Second sentence.");
  });

  test("session_ready resets transient run state and merges local slash commands with server commands", () => {
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
  data: Extract<FrontendEventEnvelope, { type: EventType }>["data"],
): FrontendEventEnvelope {
  return {
    sessionId: "session-1",
    seq: 1,
    type,
    data,
  } as FrontendEventEnvelope;
}

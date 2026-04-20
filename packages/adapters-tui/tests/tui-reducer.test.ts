import { describe, expect, test } from "bun:test";

import type { RenderedFrontendEventEnvelope } from "@nanoboss/adapters-http";
import { createInitialUiState, reduceUiState } from "@nanoboss/adapters-tui";

describe("tui reducer", () => {
  test("tracks a streamed run lifecycle, interleaves tool cards in the transcript, and reenables input on completion", () => {
    let state = createInitialUiState({ cwd: "/repo", buildLabel: "nanoboss-test", showToolCalls: true });

    state = reduceUiState(state, {
      type: "session_ready",
      sessionId: "session-1",
      cwd: "/repo",
      buildLabel: "nanoboss-test",
      agentLabel: "copilot/default",
      autoApprove: false,
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
        toolName: "read",
        status: "pending",
        callPreview: { header: "read README.md" },
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_updated", {
        runId: "run-1",
        toolCallId: "tool-1",
        status: "completed",
        resultPreview: { bodyLines: ["hello from read"] },
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
        run: { sessionId: "session-1", runId: "cell-1" },
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
        toolName: "read",
        status: "completed",
        depth: 0,
        isWrapper: false,
        callPreview: { header: "read README.md" },
        resultPreview: { bodyLines: ["hello from read"] },
        errorPreview: undefined,
        durationMs: 17,
      },
    ]);
    expect(state.turns[2]?.meta?.tokenUsageLine).toContain("[tokens] 512 / 8,192");
    expect(state.inputDisabled).toBe(false);
    expect(state.activeRunId).toBeUndefined();
  });

  test("keeps the local tool card theme mode across session resets and exposes local theme commands", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });

    state = reduceUiState(state, {
      type: "local_tool_card_theme_mode",
      mode: "light",
    });
    state = reduceUiState(state, {
      type: "session_ready",
      sessionId: "session-1",
      cwd: "/repo",
      buildLabel: "nanoboss-test",
      agentLabel: "copilot/default",
      autoApprove: false,
      commands: [{ name: "tokens", description: "show tokens" }],
    });

    expect(state.toolCardThemeMode).toBe("light");
    expect(state.availableCommands).toContain("/dark");
    expect(state.availableCommands).toContain("/light");
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
        callPreview: { header: "$ bun test" },
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_updated", {
        runId: "run-1",
        toolCallId: "tool-1",
        status: "completed",
        resultPreview: { bodyLines: ["12 passed"] },
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_completed", {
        runId: "run-1",
        procedure: "default",
        completedAt: new Date(1).toISOString(),
        run: { sessionId: "session-1", runId: "cell-1" },
      }),
    });

    expect(state.toolCalls).toHaveLength(1);
    expect(state.toolCalls[0]).toMatchObject({
      id: "tool-1",
      status: "completed",
      resultPreview: { bodyLines: ["12 passed"] },
    });
    expect(state.transcriptItems).toContainEqual({ type: "tool_call", id: "tool-1" });
  });

  test("records turn completion stats using the session prompt number", () => {
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
        text: "done",
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
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_updated", {
        runId: "run-1",
        toolCallId: "tool-1",
        status: "completed",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_started", {
        runId: "run-1",
        toolCallId: "tool-2",
        title: "Mock write notes.txt",
        kind: "write",
        status: "pending",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_updated", {
        runId: "run-1",
        toolCallId: "tool-2",
        status: "failed",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_completed", {
        runId: "run-1",
        procedure: "default",
        completedAt: new Date(2_500).toISOString(),
        run: { sessionId: "session-1", runId: "cell-1" },
      }),
    });

    expect(state.turns.at(-1)?.meta?.completionNote).toBe("turn #1 completed in 2.5s | tools 1/2 succeeded");
    expect(state.activeRunAttemptedToolCallIds).toEqual([]);
    expect(state.activeRunSucceededToolCallIds).toEqual([]);
  });

  test("preserves the last token usage line until a newer run update arrives", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });

    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("token_usage", {
        runId: "run-0",
        usage: {
          source: "acp_usage_update",
          currentContextTokens: 512,
          maxContextTokens: 8192,
        },
        sourceUpdate: "usage_update",
      }),
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

    expect(state.tokenUsageLine).toBe("[tokens] 512 / 8,192 (6.3%)");
  });

  test("uses the current session prompt number in completion notes when no text streamed before cancellation", () => {
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
      event: eventEnvelope("run_cancelled", {
        runId: "run-1",
        procedure: "default",
        completedAt: new Date(2_000).toISOString(),
        message: "Stopped.",
      }),
    });

    expect(state.turns.at(-1)).toMatchObject({
      id: "assistant-2",
      role: "assistant",
      markdown: "Stopped.",
      status: "cancelled",
      displayStyle: "card",
      cardTone: "warning",
      meta: {
        completionNote: "turn #1 stopped in 2.0s | tools 0/0 succeeded",
      },
    });
  });

  test("completion note numbering resets after session_ready", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });

    state = reduceUiState(state, {
      type: "local_user_submitted",
      text: "first session prompt",
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_started", {
        runId: "run-1",
        procedure: "default",
        prompt: "first session prompt",
        startedAt: new Date(0).toISOString(),
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("text_delta", {
        runId: "run-1",
        text: "First response.",
        stream: "agent",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_completed", {
        runId: "run-1",
        procedure: "default",
        completedAt: new Date(1_000).toISOString(),
        run: { sessionId: "session-1", runId: "cell-1" },
      }),
    });

    expect(state.turns.at(-1)?.meta?.completionNote).toBe("turn #1 completed in 1.0s | tools 0/0 succeeded");

    state = reduceUiState(state, {
      type: "session_ready",
      sessionId: "session-2",
      cwd: "/repo",
      buildLabel: "nanoboss-test",
      agentLabel: "copilot/default",
      autoApprove: false,
      commands: [],
    });
    state = reduceUiState(state, {
      type: "local_user_submitted",
      text: "second session prompt",
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_started", {
        runId: "run-2",
        procedure: "default",
        prompt: "second session prompt",
        startedAt: new Date(2_000).toISOString(),
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("text_delta", {
        runId: "run-2",
        text: "Second response.",
        stream: "agent",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_completed", {
        runId: "run-2",
        procedure: "default",
        completedAt: new Date(3_500).toISOString(),
        run: { sessionId: "session-2", runId: "cell-2" },
      }),
    });

    expect(state.turns.at(-1)?.meta?.completionNote).toBe("turn #1 completed in 1.5s | tools 0/0 succeeded");
  });

  test("renders streamed procedure notice panels inline with transcript ordering and keeps later text separate", () => {
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
        text: "Working.",
        stream: "agent",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("procedure_panel", {
        runId: "run-1",
        procedure: "default",
        panelId: "panel-1",
        rendererId: "nb/notice@1",
        payload: {
          message: "Operation cancelled by user",
          severity: "info",
        },
        severity: "info",
        dismissible: true,
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("text_delta", {
        runId: "run-1",
        text: "Done.",
        stream: "agent",
      }),
    });

    expect(state.turns).toMatchObject([
      {
        id: "assistant-1",
        role: "assistant",
        markdown: "Working.",
        status: "complete",
      },
      {
        id: "assistant-2",
        role: "assistant",
        markdown: "Done.",
        status: "streaming",
      },
    ]);
    expect(state.procedurePanels).toMatchObject([
      {
        panelId: "panel-1",
        rendererId: "nb/notice@1",
        payload: {
          message: "Operation cancelled by user",
          severity: "info",
        },
        severity: "info",
      },
    ]);
    expect(state.transcriptItems).toEqual([
      { type: "turn", id: "assistant-1" },
      { type: "procedure_panel", id: "panel-1" },
      { type: "turn", id: "assistant-2" },
    ]);
    expect(state.activeAssistantTurnId).toBe("assistant-2");
  });

  test("renders procedure cards as markdown-oriented assistant cards", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });

    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_started", {
        runId: "run-1",
        procedure: "research",
        prompt: "hello",
        startedAt: new Date(0).toISOString(),
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("procedure_card", {
        runId: "run-1",
        card: {
          type: "card",
          procedure: "research",
          kind: "report",
          title: "Research checkpoint",
          markdown: "- cited source\n- open question",
        },
      }),
    });

    expect(state.turns.at(-1)).toMatchObject({
      role: "assistant",
      displayStyle: "card",
      cardTone: "info",
      markdown: "## Research checkpoint\n\n_report_\n\n- cited source\n- open question",
      meta: {
        procedure: "research",
      },
    });
  });

  test("renders procedure status lines from the shared formatter", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });

    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_started", {
        runId: "run-1",
        procedure: "research",
        prompt: "hello",
        startedAt: new Date(0).toISOString(),
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("procedure_status", {
        runId: "run-1",
        status: {
          type: "status",
          procedure: "research",
          phase: "collect",
          message: "Gathering sources",
          iteration: "2/3",
          autoApprove: true,
          waiting: true,
        },
      }),
    });

    expect(state.statusLine).toBe("[status] /research collect 2/3 - Gathering sources (auto-approve, waiting)");
  });

  test("ignores stale run events after a newer run has started", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });

    state = reduceUiState(state, {
      type: "local_user_submitted",
      text: "first",
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_started", {
        runId: "run-1",
        procedure: "default",
        prompt: "first",
        startedAt: new Date(0).toISOString(),
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("text_delta", {
        runId: "run-1",
        text: "one",
        stream: "agent",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_completed", {
        runId: "run-1",
        procedure: "default",
        completedAt: new Date(1).toISOString(),
        run: { sessionId: "session-1", runId: "cell-1" },
      }),
    });

    state = reduceUiState(state, {
      type: "local_user_submitted",
      text: "second",
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_started", {
        runId: "run-2",
        procedure: "default",
        prompt: "second",
        startedAt: new Date(2).toISOString(),
      }),
    });

    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("text_delta", {
        runId: "run-1",
        text: " stale",
        stream: "agent",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_started", {
        runId: "run-1",
        toolCallId: "stale-tool",
        title: "Stale tool",
        kind: "read",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_completed", {
        runId: "run-1",
        procedure: "default",
        completedAt: new Date(3).toISOString(),
        run: { sessionId: "session-1", runId: "cell-2" },
        display: "stale",
      }),
    });

    expect(state.turns.map((turn) => ({
      role: turn.role,
      markdown: turn.markdown,
      status: turn.status,
      runId: turn.runId,
    }))).toEqual([
      { role: "user", markdown: "first", status: "complete", runId: undefined },
      { role: "assistant", markdown: "one", status: "complete", runId: "run-1" },
      { role: "user", markdown: "second", status: "complete", runId: undefined },
    ]);
    expect(state.toolCalls).toEqual([]);
    expect(state.activeRunId).toBe("run-2");
    expect(state.inputDisabled).toBe(true);
  });

  test("latches a local stop request, preserves it across heartbeats, and finishes the run as cancelled", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });

    state = reduceUiState(state, {
      type: "local_user_submitted",
      text: "hello",
    });
    state = reduceUiState(state, {
      type: "local_stop_requested",
    });

    expect(state.pendingStopRequest).toBe(true);
    expect(state.statusLine).toBe("[run] ESC received - stopping at next tool boundary...");

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
      event: eventEnvelope("run_heartbeat", {
        runId: "run-1",
        procedure: "default",
        at: new Date(1_000).toISOString(),
      }),
    });

    expect(state.pendingStopRequest).toBe(false);
    expect(state.stopRequestedRunId).toBe("run-1");
    expect(state.statusLine).toBe("[run] ESC received - stopping at next tool boundary...");

    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_cancelled", {
        runId: "run-1",
        procedure: "default",
        completedAt: new Date(2_000).toISOString(),
        message: "Stopped.",
      }),
    });

    expect(state.turns.at(-1)).toMatchObject({
      role: "assistant",
      markdown: "Stopped.",
      status: "cancelled",
    });
    expect(state.pendingStopRequest).toBe(false);
    expect(state.stopRequestedRunId).toBeUndefined();
    expect(state.statusLine).toBe("[run] default stopped");
    expect(state.inputDisabled).toBe(false);
  });

  test("restores persisted runs into transcript history", () => {
    let state = createInitialUiState({ cwd: "/wrong", showToolCalls: true });

    state = reduceUiState(state, {
      type: "session_ready",
      sessionId: "session-1",
      cwd: "/repo",
      buildLabel: "nanoboss-test",
      agentLabel: "copilot/default",
      autoApprove: false,
      commands: [{ name: "tokens", description: "show tokens" }],
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_restored", {
        runId: "run-1",
        procedure: "default",
        prompt: "hello",
        completedAt: new Date(1).toISOString(),
        run: { sessionId: "session-1", runId: "cell-1" },
        status: "complete",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_started", {
        runId: "run-1",
        toolCallId: "tool-1",
        title: "Mock read README.md",
        kind: "read",
        toolName: "read",
        status: "pending",
        callPreview: { header: "read README.md" },
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_updated", {
        runId: "run-1",
        toolCallId: "tool-1",
        status: "completed",
        resultPreview: { bodyLines: ["hello from read"] },
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
      event: eventEnvelope("run_completed", {
        runId: "run-1",
        procedure: "default",
        completedAt: new Date(1).toISOString(),
        run: { sessionId: "session-1", runId: "cell-1" },
      }),
    });

    expect(state.cwd).toBe("/repo");
    expect(state.turns).toEqual([
      {
        id: "user-1",
        role: "user",
        markdown: "hello",
        status: "complete",
      },
      {
        id: "assistant-2",
        role: "assistant",
        markdown: "hi",
        blocks: [{ kind: "text", text: "hi", origin: "stream" }],
        status: "complete",
        runId: "run-1",
        meta: {
          procedure: "default",
          tokenUsageLine: undefined,
          failureMessage: undefined,
        },
      },
    ]);
    expect(state.transcriptItems).toEqual([
      { type: "turn", id: "user-1" },
      { type: "tool_call", id: "tool-1" },
      { type: "turn", id: "assistant-2" },
    ]);
    expect(state.toolCalls).toEqual([
      {
        id: "tool-1",
        runId: "run-1",
        title: "Mock read README.md",
        kind: "read",
        toolName: "read",
        status: "completed",
        depth: 0,
        isWrapper: false,
        callPreview: { header: "read README.md" },
        resultPreview: { bodyLines: ["hello from read"] },
        errorPreview: undefined,
        durationMs: undefined,
      },
    ]);
  });

  test("tracks invoked procedures in status state instead of requiring a default wrapper card", () => {
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
    expect(state.activeProcedure).toBe("default");
    expect(state.statusLine).toBe("[run] invoking /default…");
    expect(state.toolCalls).toEqual([]);
    expect(state.transcriptItems).toEqual([]);
  });

  test("obeys producer-owned hidden tool metadata while retaining parent-linked hierarchy", () => {
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
        toolCallId: "wrapper",
        title: "nanoboss-procedure_dispatch_wait",
        kind: "wrapper",
        transcriptVisible: false,
        removeOnTerminal: true,
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_started", {
        runId: "run-1",
        toolCallId: "leaf",
        parentToolCallId: "wrapper",
        title: "Mock read README.md",
        kind: "read",
      }),
    });

    expect(state.toolCalls.find((toolCall) => toolCall.id === "leaf")).toMatchObject({
      id: "leaf",
      parentToolCallId: "wrapper",
      depth: 1,
    });
    expect(state.transcriptItems).toContainEqual({ type: "tool_call", id: "leaf" });
    expect(state.transcriptItems).not.toContainEqual({ type: "tool_call", id: "wrapper" });
  });

  test("treats wrapper semantics as producer-owned metadata instead of title inference", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });

    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_started", {
        runId: "run-1",
        toolCallId: "tool-1",
        title: "callAgent: summarize the diff",
        kind: "other",
        toolName: "agent",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_updated", {
        runId: "run-1",
        toolCallId: "tool-1",
        status: "completed",
      }),
    });

    expect(state.toolCalls).toEqual([
      {
        id: "tool-1",
        runId: "run-1",
        title: "callAgent: summarize the diff",
        kind: "other",
        toolName: "agent",
        status: "completed",
        depth: 0,
        isWrapper: false,
        callPreview: undefined,
        resultPreview: undefined,
        errorPreview: undefined,
        rawInput: undefined,
        rawOutput: undefined,
        durationMs: undefined,
      },
    ]);
    expect(state.transcriptItems).toContainEqual({ type: "tool_call", id: "tool-1" });
  });

  test("preserves the original tool identity when later updates rename the card", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });

    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_started", {
        runId: "run-1",
        toolCallId: "tool-1",
        title: "Read File",
        kind: "read",
        toolName: "read",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_updated", {
        runId: "run-1",
        toolCallId: "tool-1",
        title: "Write File",
        toolName: "write",
        status: "completed",
        resultPreview: { bodyLines: ["kept original semantics"] },
      }),
    });

    expect(state.toolCalls).toEqual([
      {
        id: "tool-1",
        runId: "run-1",
        title: "Write File",
        kind: "read",
        toolName: "read",
        status: "completed",
        depth: 0,
        isWrapper: false,
        callPreview: undefined,
        resultPreview: { bodyLines: ["kept original semantics"] },
        errorPreview: undefined,
        rawInput: undefined,
        rawOutput: undefined,
        durationMs: undefined,
      },
    ]);
  });

  test("removes terminal wrappers and reparents descendants through explicit parentToolCallId links", () => {
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
        title: "Mock read package.json",
        kind: "read",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_started", {
        runId: "run-1",
        toolCallId: "wrapper",
        parentToolCallId: "tool-parent",
        title: "defaultSession: hello",
        kind: "wrapper",
        removeOnTerminal: true,
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_started", {
        runId: "run-1",
        toolCallId: "leaf",
        parentToolCallId: "wrapper",
        title: "Mock read README.md",
        kind: "read",
      }),
    });

    expect(state.toolCalls.find((toolCall) => toolCall.id === "leaf")).toMatchObject({
      id: "leaf",
      parentToolCallId: "wrapper",
      depth: 2,
    });
    expect(state.transcriptItems).toContainEqual({ type: "tool_call", id: "wrapper" });

    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_updated", {
        runId: "run-1",
        toolCallId: "wrapper",
        status: "completed",
      }),
    });

    expect(state.toolCalls.map((toolCall) => toolCall.id)).toEqual(["tool-parent", "leaf"]);
    expect(state.toolCalls.find((toolCall) => toolCall.id === "leaf")).toMatchObject({
      id: "leaf",
      parentToolCallId: "tool-parent",
      depth: 1,
    });
    expect(state.transcriptItems).not.toContainEqual({ type: "tool_call", id: "wrapper" });
    expect(state.transcriptItems).toContainEqual({ type: "tool_call", id: "tool-parent" });
    expect(state.transcriptItems).toContainEqual({ type: "tool_call", id: "leaf" });
  });

  test("out-of-order tool updates synthesize a placeholder card from canonical toolName", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });

    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_updated", {
        runId: "run-1",
        toolCallId: "tool-missing",
        title: "write",
        toolName: "write",
        status: "failed",
        errorPreview: { bodyLines: ["permission denied"] },
      }),
    });

    expect(state.toolCalls).toEqual([
      {
        id: "tool-missing",
        runId: "run-1",
        title: "write",
        kind: "other",
        toolName: "write",
        status: "failed",
        depth: 0,
        isWrapper: false,
        callPreview: undefined,
        resultPreview: undefined,
        errorPreview: { bodyLines: ["permission denied"] },
        durationMs: undefined,
      },
    ]);
    expect(state.transcriptItems).toContainEqual({ type: "tool_call", id: "tool-missing" });
  });

  test("title-only tool updates stay presentation-only when semantic identity is missing", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });

    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("tool_updated", {
        runId: "run-1",
        toolCallId: "tool-missing",
        title: "write",
        status: "failed",
        errorPreview: { bodyLines: ["permission denied"] },
      }),
    });

    expect(state.toolCalls).toEqual([
      {
        id: "tool-missing",
        runId: "run-1",
        title: "write",
        kind: "other",
        toolName: undefined,
        status: "failed",
        depth: 0,
        isWrapper: false,
        callPreview: undefined,
        resultPreview: undefined,
        errorPreview: { bodyLines: ["permission denied"] },
        durationMs: undefined,
      },
    ]);
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

  test("session_ready resets retained transcript state, keeps tool expansion preference, and merges local slash commands", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true, expandedToolOutput: true });

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
      cwd: "/repo",
      buildLabel: "nanoboss-test",
      agentLabel: "copilot/default",
      autoApprove: false,
      commands: [{ name: "tokens", description: "show tokens" }],
    });

    expect(state.turns).toEqual([]);
    expect(state.toolCalls).toEqual([]);
    expect(state.transcriptItems).toEqual([]);
    expect(state.statusLine).toBeUndefined();
    expect(state.expandedToolOutput).toBe(true);
    expect(state.availableCommands).toEqual([
      "/tokens",
      "/new",
      "/end",
      "/quit",
      "/exit",
      "/model",
      "/extensions",
      "/dark",
      "/light",
    ]);
  });

  test("dismiss completion clears the pending continuation and leaves the cleared status visible", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });

    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("continuation_updated", {
        continuation: {
          procedure: "simplify",
          question: "What would you like instead?",
        },
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_started", {
        runId: "run-1",
        procedure: "dismiss",
        prompt: "",
        startedAt: new Date(0).toISOString(),
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("continuation_updated", {
        continuation: undefined,
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_completed", {
        runId: "run-1",
        procedure: "dismiss",
        completedAt: new Date(1).toISOString(),
        run: { sessionId: "session-1", runId: "cell-1" },
        display: "Cleared the pending continuation for /simplify.",
      }),
    });

    expect(state.pendingContinuation).toBeUndefined();
    expect(state.statusLine).toBe("[continuation] cleared /simplify");
  });

  test("toggle_tool_output flips the global expansion flag", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });

    state = reduceUiState(state, { type: "toggle_tool_output" });
    expect(state.expandedToolOutput).toBe(true);

    state = reduceUiState(state, { type: "toggle_tool_output" });
    expect(state.expandedToolOutput).toBe(false);
  });

  test("toggle_tool_cards_hidden flips the tool-cards-hidden flag without mutating transcript data", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });
    // Seed a tool call in state so we can confirm it's preserved across toggles.
    state = {
      ...state,
      toolCalls: [
        {
          id: "tc-1",
          runId: "run-1",
          title: "example",
          kind: "other",
          status: "pending",
          depth: 0,
          isWrapper: false,
        },
      ],
      transcriptItems: [{ type: "tool_call", id: "tc-1" }],
    };

    expect(state.toolCardsHidden).toBe(false);

    state = reduceUiState(state, { type: "toggle_tool_cards_hidden" });
    expect(state.toolCardsHidden).toBe(true);
    // Data is preserved — hiding is view-only.
    expect(state.toolCalls).toHaveLength(1);
    expect(state.transcriptItems).toHaveLength(1);

    state = reduceUiState(state, { type: "toggle_tool_cards_hidden" });
    expect(state.toolCardsHidden).toBe(false);
    expect(state.toolCalls).toHaveLength(1);
    expect(state.transcriptItems).toHaveLength(1);
  });

  test("session_ready preserves toolCardsHidden across session restarts", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });
    state = reduceUiState(state, { type: "toggle_tool_cards_hidden" });
    expect(state.toolCardsHidden).toBe(true);

    state = reduceUiState(state, {
      type: "session_ready",
      sessionId: "session-2",
      cwd: "/repo",
      buildLabel: "nanoboss-test",
      agentLabel: "copilot/default",
      autoApprove: false,
      commands: [],
    });

    expect(state.toolCardsHidden).toBe(true);
  });

  test("tracks local simplify2 auto-approve mode", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });

    state = reduceUiState(state, {
      type: "local_simplify2_auto_approve",
      enabled: true,
    });

    expect(state.simplify2AutoApprove).toBe(true);
    expect(state.statusLine).toBe("[simplify2] auto-approve on");
  });

  test("tracks session-backed auto-approve mode", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });

    state = reduceUiState(state, {
      type: "session_auto_approve",
      enabled: true,
    });

    expect(state.simplify2AutoApprove).toBe(true);
    expect(state.statusLine).toBe("[session] auto-approve on");
  });

  test("keybindingOverlayVisible defaults to false and toggles via keybindingOverlay/toggle", () => {
    let state = createInitialUiState({ cwd: "/repo" });
    expect(state.keybindingOverlayVisible).toBe(false);

    state = reduceUiState(state, { type: "keybindingOverlay/toggle" });
    expect(state.keybindingOverlayVisible).toBe(true);

    state = reduceUiState(state, { type: "keybindingOverlay/toggle" });
    expect(state.keybindingOverlayVisible).toBe(false);
  });

  test("keybindingOverlay/dismiss hides the overlay and is a no-op when already hidden", () => {
    let state = createInitialUiState({ cwd: "/repo" });

    state = reduceUiState(state, { type: "keybindingOverlay/toggle" });
    expect(state.keybindingOverlayVisible).toBe(true);

    state = reduceUiState(state, { type: "keybindingOverlay/dismiss" });
    expect(state.keybindingOverlayVisible).toBe(false);

    const before = state;
    state = reduceUiState(state, { type: "keybindingOverlay/dismiss" });
    expect(state).toBe(before);
    expect(state.keybindingOverlayVisible).toBe(false);
  });

  test("resume error does not trap user in paused state (execute-plan regression)", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });

    state = reduceUiState(state, { type: "local_user_submitted", text: "go" });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_started", {
        runId: "run-1",
        procedure: "execute-plan",
        prompt: "go",
        startedAt: new Date(0).toISOString(),
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_paused", {
        runId: "run-1",
        procedure: "execute-plan",
        pausedAt: new Date(1_000).toISOString(),
        run: { sessionId: "session-1", runId: "run-1" },
        question: "Approve next step?",
      }),
    });

    expect(state.pendingContinuation).toMatchObject({ procedure: "execute-plan" });

    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_failed", {
        runId: "run-1",
        procedure: "execute-plan",
        completedAt: new Date(2_000).toISOString(),
        error: "resume threw",
      }),
    });

    expect(state.pendingContinuation).toBeUndefined();
  });

  test("run_cancelled clears pendingContinuation after a pause", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });

    state = reduceUiState(state, { type: "local_user_submitted", text: "go" });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_started", {
        runId: "run-2",
        procedure: "execute-plan",
        prompt: "go",
        startedAt: new Date(0).toISOString(),
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_paused", {
        runId: "run-2",
        procedure: "execute-plan",
        pausedAt: new Date(1_000).toISOString(),
        run: { sessionId: "session-1", runId: "run-2" },
        question: "Approve next step?",
      }),
    });

    expect(state.pendingContinuation).toMatchObject({ procedure: "execute-plan" });

    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_cancelled", {
        runId: "run-2",
        procedure: "execute-plan",
        completedAt: new Date(2_000).toISOString(),
        message: "Stopped.",
      }),
    });

    expect(state.pendingContinuation).toBeUndefined();
  });

  test("procedure_panel event appends a block to the active turn and a procedure_panel transcript item", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_started", {
        runId: "run-1",
        procedure: "demo",
        prompt: "hi",
        startedAt: new Date(0).toISOString(),
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("text_delta", {
        runId: "run-1",
        text: "hello",
        stream: "agent",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("procedure_panel", {
        runId: "run-1",
        procedure: "demo",
        panelId: "panel-1",
        rendererId: "nb/card@1",
        payload: { kind: "summary", title: "t", markdown: "m" },
        severity: "info",
        dismissible: true,
      }),
    });

    expect(state.procedurePanels.map((p) => p.panelId)).toEqual(["panel-1"]);
    expect(state.transcriptItems.some((i) => i.type === "procedure_panel" && i.id === "panel-1")).toBe(true);
    const activeTurn = state.turns.find((t) => t.id === state.activeAssistantTurnId);
    expect(activeTurn?.blocks?.some((b) => b.kind === "procedure_panel" && b.panelId === "panel-1")).toBe(true);
  });

  test("toolCardsHidden does not hide procedure_panel transcript items", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true, toolCardsHidden: true });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_started", {
        runId: "run-1",
        procedure: "demo",
        prompt: "hi",
        startedAt: new Date(0).toISOString(),
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("procedure_panel", {
        runId: "run-1",
        procedure: "demo",
        panelId: "panel-1",
        rendererId: "nb/error@1",
        payload: { procedure: "demo", message: "boom" },
        severity: "error",
        dismissible: false,
      }),
    });

    // The transcript item is present regardless of the tool-card toggle.
    expect(state.toolCardsHidden).toBe(true);
    expect(state.transcriptItems.some((i) => i.type === "procedure_panel")).toBe(true);
  });

  test("procedure_panel with an existing key replaces in place and preserves ordering", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_started", {
        runId: "run-1",
        procedure: "demo",
        prompt: "hi",
        startedAt: new Date(0).toISOString(),
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("text_delta", {
        runId: "run-1",
        text: "hello",
        stream: "agent",
      }),
    });
    const emitPanel = (panelId: string, payload: unknown, key?: string) => {
      state = reduceUiState(state, {
        type: "frontend_event",
        event: eventEnvelope("procedure_panel", {
          runId: "run-1",
          procedure: "demo",
          panelId,
          rendererId: "nb/card@1",
          payload,
          severity: "info",
          dismissible: true,
          ...(key !== undefined ? { key } : {}),
        }),
      });
    };
    emitPanel("p-a", { kind: "summary", title: "A", markdown: "a" }, "keyA");
    emitPanel("p-b", { kind: "summary", title: "B", markdown: "b" });
    emitPanel("p-a2", { kind: "summary", title: "A2", markdown: "a2" }, "keyA");

    // Still two panels (A replaced, B preserved) and ordering preserved.
    expect(state.procedurePanels.map((p) => p.panelId)).toEqual(["p-a", "p-b"]);
    expect((state.procedurePanels[0]!.payload as { title: string }).title).toBe("A2");
    const activeTurn = state.turns.find((turn) => turn.id === "assistant-1");
    const panelBlock = activeTurn?.blocks?.find((block) => block.kind === "procedure_panel" && block.panelId === "p-a");
    expect(panelBlock?.kind).toBe("procedure_panel");
    if (panelBlock?.kind === "procedure_panel") {
      expect((panelBlock.payload as { title: string }).title).toBe("A2");
    }
    const transcriptPanelIds = state.transcriptItems
      .filter((i) => i.type === "procedure_panel")
      .map((i) => i.id);
    expect(transcriptPanelIds).toEqual(["p-a", "p-b"]);
  });

  test("procedure_panel key replacement is scoped to the originating run", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });

    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_started", {
        runId: "run-1",
        procedure: "demo",
        prompt: "first",
        startedAt: new Date(0).toISOString(),
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("procedure_panel", {
        runId: "run-1",
        procedure: "demo",
        panelId: "panel-run-1",
        rendererId: "nb/card@1",
        payload: { kind: "summary", title: "Run 1", markdown: "first" },
        severity: "info",
        dismissible: true,
        key: "same-key",
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_completed", {
        runId: "run-1",
        procedure: "demo",
        completedAt: new Date(1_000).toISOString(),
        run: { sessionId: "session-1", runId: "stored-run-1" },
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_started", {
        runId: "run-2",
        procedure: "demo",
        prompt: "second",
        startedAt: new Date(2_000).toISOString(),
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("procedure_panel", {
        runId: "run-2",
        procedure: "demo",
        panelId: "panel-run-2",
        rendererId: "nb/card@1",
        payload: { kind: "summary", title: "Run 2", markdown: "second" },
        severity: "info",
        dismissible: true,
        key: "same-key",
      }),
    });

    expect(state.procedurePanels.map((panel) => panel.panelId)).toEqual(["panel-run-1", "panel-run-2"]);
    expect(state.transcriptItems.filter((item) => item.type === "procedure_panel").map((item) => item.id)).toEqual([
      "panel-run-1",
      "panel-run-2",
    ]);
  });

  test("procedure_panel error severity defaults to non-dismissible when emitted with dismissible=false", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_started", {
        runId: "run-1",
        procedure: "demo",
        prompt: "hi",
        startedAt: new Date(0).toISOString(),
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("procedure_panel", {
        runId: "run-1",
        procedure: "demo",
        panelId: "panel-err",
        rendererId: "nb/error@1",
        payload: { procedure: "demo", message: "boom" },
        severity: "error",
        dismissible: false,
      }),
    });

    expect(state.procedurePanels[0]).toMatchObject({
      severity: "error",
      dismissible: false,
    });
  });
  test("local_procedure_panel does NOT bind to active assistant turn or mark text boundary", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });
    // Start a run with an active assistant turn and streamed text.
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_started", {
        runId: "run-1",
        procedure: "demo",
        prompt: "hi",
        startedAt: new Date(0).toISOString(),
      }),
    });
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("text_delta", { runId: "run-1", text: "streaming…", stream: "agent" }),
    });
    const preActiveTurnId = state.activeAssistantTurnId;
    const preBoundaryPending = state.assistantParagraphBreakPending;
    expect(preActiveTurnId).toBeDefined();

    state = reduceUiState(state, {
      type: "local_procedure_panel",
      panelId: "panel-local-1",
      rendererId: "nb/card@1",
      payload: { kind: "notice", title: "Extensions", markdown: "..." },
      severity: "info",
      dismissible: true,
      key: "local:extensions",
    });

    // Panel is recorded and transcript item appended.
    expect(state.procedurePanels).toHaveLength(1);
    expect(state.procedurePanels[0]!.panelId).toBe("panel-local-1");
    expect(state.procedurePanels[0]!.runId).toBeUndefined();
    expect(state.procedurePanels[0]!.turnId).toBeUndefined();
    expect(state.transcriptItems.some((it) => it.type === "procedure_panel" && it.id === "panel-local-1")).toBe(true);

    // Critically: the active assistant turn is untouched — no block is
    // appended, and the paragraph-break boundary is not marked.
    const activeTurn = state.turns.find((turn) => turn.id === preActiveTurnId)!;
    const hasPanelBlock = (activeTurn.blocks ?? []).some(
      (block) => block.kind === "procedure_panel" && block.panelId === "panel-local-1",
    );
    expect(hasPanelBlock).toBe(false);
    expect(state.activeAssistantTurnId).toBe(preActiveTurnId);
    expect(state.assistantParagraphBreakPending).toBe(preBoundaryPending);
  });

  test("local_procedure_panel replaces in place when key matches and runId is absent", () => {
    let state = createInitialUiState({ cwd: "/repo", showToolCalls: true });
    state = reduceUiState(state, {
      type: "local_procedure_panel",
      panelId: "panel-local-a",
      rendererId: "nb/card@1",
      payload: { kind: "notice", title: "Extensions", markdown: "first" },
      severity: "info",
      dismissible: true,
      key: "local:extensions",
    });
    state = reduceUiState(state, {
      type: "local_procedure_panel",
      panelId: "panel-local-b",
      rendererId: "nb/card@1",
      payload: { kind: "notice", title: "Extensions", markdown: "second" },
      severity: "warn",
      dismissible: true,
      key: "local:extensions",
    });

    expect(state.procedurePanels).toHaveLength(1);
    expect(state.procedurePanels[0]!.panelId).toBe("panel-local-a");
    expect(state.procedurePanels[0]!.severity).toBe("warn");
    expect((state.procedurePanels[0]!.payload as { markdown: string }).markdown).toBe("second");
  });
});

function eventEnvelope<EventType extends RenderedFrontendEventEnvelope["type"]>(
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

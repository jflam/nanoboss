import { describe, expect, test } from "bun:test";

import {
  createRef,
  createRunRef,
  createSessionRef,
} from "../../src/core/contracts.ts";
import {
  runRecordFromCellRecord,
  runSummaryFromCellSummary,
} from "../../src/session/store-records.ts";

describe("core contracts", () => {
  test("uses canonical run, ref, and session shapes directly", () => {
    const run = createRunRef("session-1", "run-1");
    const ref = createRef(run, "output.data.answer");
    const session = createSessionRef("session-1");

    expect(run).toEqual({ sessionId: "session-1", runId: "run-1" });
    expect(ref).toEqual({
      run,
      path: "output.data.answer",
    });
    expect(session).toEqual({ sessionId: "session-1" });
  });

  test("uses canonical continuation families directly", () => {
    const continuation = {
      question: "Approve this change?",
      state: { step: 2 },
      inputHint: "reply",
      suggestedReplies: ["approve", "stop"],
      ui: {
        kind: "simplify2_checkpoint" as const,
        title: "Checkpoint",
        actions: [{ id: "approve" as const, label: "Approve", reply: "approve" }],
      },
    };

    expect(continuation).toEqual({
      question: "Approve this change?",
      state: { step: 2 },
      inputHint: "reply",
      suggestedReplies: ["approve", "stop"],
      ui: continuation.ui,
    });

    const pending = {
      procedure: "simplify2",
      run: { sessionId: "session-1", runId: "run-1" },
      question: "Approve this change?",
      state: { step: 2 },
      inputHint: "reply",
      suggestedReplies: ["approve", "stop"],
      ui: continuation.ui,
    };

    expect(pending).toEqual({
      procedure: "simplify2",
      run: { sessionId: "session-1", runId: "run-1" },
      question: "Approve this change?",
      state: { step: 2 },
      inputHint: "reply",
      suggestedReplies: ["approve", "stop"],
      ui: continuation.ui,
    });
  });

  test("maps run records and summaries onto the canonical run family", () => {
    const cellRecord = {
      cellId: "cell-1",
      procedure: "review",
      input: "inspect this patch",
      output: {
        data: { verdict: "sound" },
        display: "Looks good",
        summary: "Patch reviewed",
        memory: "User wanted a risk review",
        pause: {
          question: "Continue?",
          state: { step: 1 },
        },
      },
      meta: {
        createdAt: "2026-04-13T10:00:00.000Z",
        parentCellId: "cell-0",
        kind: "procedure" as const,
        dispatchCorrelationId: "dispatch-1",
      },
    };

    const runRecord = runRecordFromCellRecord("session-1", cellRecord);
    expect(runRecord).toEqual({
      run: { sessionId: "session-1", runId: "cell-1" },
      kind: "procedure",
      procedure: "review",
      input: "inspect this patch",
      output: {
        data: { verdict: "sound" },
        display: "Looks good",
        stream: undefined,
        summary: "Patch reviewed",
        memory: "User wanted a risk review",
        pause: {
          question: "Continue?",
          state: { step: 1 },
          inputHint: undefined,
          suggestedReplies: undefined,
          ui: undefined,
        },
        explicitDataSchema: undefined,
        replayEvents: undefined,
      },
      meta: {
        createdAt: "2026-04-13T10:00:00.000Z",
        parentRunId: "cell-0",
        dispatchCorrelationId: "dispatch-1",
        defaultAgentSelection: undefined,
        promptImages: undefined,
      },
    });
    const summary = {
      cell: { sessionId: "session-1", cellId: "cell-1" },
      procedure: "review",
      kind: "procedure" as const,
      parentCellId: "cell-0",
      summary: "Patch reviewed",
      memory: "User wanted a risk review",
      dataRef: { cell: { sessionId: "session-1", cellId: "cell-1" }, path: "output.data" },
      displayRef: { cell: { sessionId: "session-1", cellId: "cell-1" }, path: "output.display" },
      streamRef: undefined,
      dataShape: { verdict: "sound" },
      explicitDataSchema: { type: "object" },
      createdAt: "2026-04-13T10:00:00.000Z",
    };

    const runSummary = runSummaryFromCellSummary(summary);
    expect(runSummary).toEqual({
      run: { sessionId: "session-1", runId: "cell-1" },
      procedure: "review",
      kind: "procedure",
      parentRunId: "cell-0",
      summary: "Patch reviewed",
      memory: "User wanted a risk review",
      dataRef: { run: { sessionId: "session-1", runId: "cell-1" }, path: "output.data" },
      displayRef: { run: { sessionId: "session-1", runId: "cell-1" }, path: "output.display" },
      streamRef: undefined,
      dataShape: { verdict: "sound" },
      explicitDataSchema: { type: "object" },
      createdAt: "2026-04-13T10:00:00.000Z",
    });
  });

  test("uses canonical session family shapes directly", () => {
    expect({
      session: { sessionId: "session-1" },
      cwd: "/repo",
      defaultAgentSelection: { provider: "codex", model: "gpt-5" },
    }).toEqual({
      session: { sessionId: "session-1" },
      cwd: "/repo",
      defaultAgentSelection: { provider: "codex", model: "gpt-5" },
    });

    expect({
      session: { sessionId: "session-1" },
      cwd: "/repo",
      rootDir: "/repo/.nanoboss/session-1",
      createdAt: "2026-04-13T10:00:00.000Z",
      updatedAt: "2026-04-13T11:00:00.000Z",
      defaultAgentSelection: { provider: "codex", model: "gpt-5" },
      defaultAgentSessionId: "agent-session-1",
      pendingContinuation: {
        procedure: "review",
        run: { sessionId: "session-1", runId: "run-7" },
        question: "Continue the review?",
        state: { step: 3 },
        inputHint: undefined,
        suggestedReplies: undefined,
        ui: undefined,
      },
    });
  });
});

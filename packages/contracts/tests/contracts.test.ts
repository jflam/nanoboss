import { describe, expect, test } from "bun:test";

import {
  createRef,
  createRunRef,
  createSessionRef,
} from "@nanoboss/contracts";

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

  test("uses canonical run record and summary shapes directly", () => {
    const run = createRunRef("session-1", "run-1");

    expect({
      run,
      kind: "procedure" as const,
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
        parentRunId: "run-0",
        dispatchCorrelationId: "dispatch-1",
      },
    }).toEqual({
      run: { sessionId: "session-1", runId: "run-1" },
      kind: "procedure",
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
        parentRunId: "run-0",
        dispatchCorrelationId: "dispatch-1",
      },
    });

    expect({
      run,
      procedure: "review",
      kind: "procedure" as const,
      parentRunId: "run-0",
      summary: "Patch reviewed",
      memory: "User wanted a risk review",
      dataRef: createRef(run, "output.data"),
      displayRef: createRef(run, "output.display"),
      dataShape: { verdict: "sound" },
      explicitDataSchema: { type: "object" },
      createdAt: "2026-04-13T10:00:00.000Z",
    }).toEqual({
      run: { sessionId: "session-1", runId: "run-1" },
      procedure: "review",
      kind: "procedure",
      parentRunId: "run-0",
      summary: "Patch reviewed",
      memory: "User wanted a risk review",
      dataRef: { run: { sessionId: "session-1", runId: "run-1" }, path: "output.data" },
      displayRef: { run: { sessionId: "session-1", runId: "run-1" }, path: "output.display" },
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

import { describe, expect, test } from "bun:test";

import { createInitialUiState } from "../../src/tui/state.ts";
import { createNanobossTuiTheme } from "../../src/tui/theme.ts";
import { NanobossAppView } from "../../src/tui/views.ts";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("NanobossAppView", () => {
  test("shows a busy indicator while a run is active", () => {
    const state = {
      ...createInitialUiState({ cwd: "/repo" }),
      sessionId: "session-1",
      inputDisabled: true,
      defaultAgentSelection: {
        provider: "copilot" as const,
        model: "gpt-5.4/xhigh",
      },
      agentLabel: "copilot/gpt-5.4/x-high",
    };

    const view = new NanobossAppView(
      {
        render: () => [""],
        invalidate() {},
      } as never,
      createNanobossTuiTheme(),
      state,
    );

    const plain = stripAnsi(view.render(120).join("\n"));

    expect(plain).toContain("● busy");
    expect(plain).toContain("agent copilot");
  });

  test("renders tool cards inline in transcript order instead of in the activity area", () => {
    const state = {
      ...createInitialUiState({ cwd: "/repo", showToolCalls: true }),
      sessionId: "session-1",
      turns: [
        {
          id: "user-1",
          role: "user" as const,
          markdown: "review the repo",
          status: "complete" as const,
        },
        {
          id: "assistant-2",
          role: "assistant" as const,
          markdown: "I checked the code.",
          status: "complete" as const,
        },
      ],
      toolCalls: [
        {
          id: "tool-1",
          runId: "run-1",
          title: "Mock read README.md",
          kind: "read",
          status: "completed",
          depth: 0,
          isWrapper: false,
          inputSummary: "README.md",
          outputSummary: "Project instructions",
          errorSummary: undefined,
          durationMs: 12,
        },
      ],
      transcriptItems: [
        { type: "turn" as const, id: "user-1" },
        { type: "tool_call" as const, id: "tool-1" },
        { type: "turn" as const, id: "assistant-2" },
      ],
      runtimeNotes: ["[memory] injected 1 card"],
    };

    const view = new NanobossAppView(
      {
        render: () => [""],
        invalidate() {},
      } as never,
      createNanobossTuiTheme(),
      state,
    );

    const plainLines = view.render(120).map(stripAnsi);
    const joined = plainLines.join("\n");
    const userIndex = plainLines.findIndex((line) => line.trim() === "you");
    const toolIndex = plainLines.findIndex((line) => line.includes("Mock read README.md"));
    const assistantIndex = plainLines.findIndex((line) => line.includes("I checked the code."));
    const activityIndex = plainLines.findIndex((line) => line.trim() === "activity");

    expect(toolIndex).toBeGreaterThan(userIndex);
    expect(assistantIndex).toBeGreaterThan(toolIndex);
    expect(joined).toContain("path: README.md");
    expect(joined).toContain("contents: Project instructions");
    expect(activityIndex).toBeGreaterThan(assistantIndex);
    expect(joined).not.toContain("[tool]");
  });

  test("renders pending, success, and error tool cards as bordered rectangles with distinct status markers", () => {
    const baseState = createInitialUiState({ cwd: "/repo", showToolCalls: true });
    const state = {
      ...baseState,
      sessionId: "session-1",
      toolCalls: [
        {
          id: "pending",
          runId: "run-1",
          title: "bash",
          kind: "bash",
          status: "pending",
          depth: 0,
          isWrapper: false,
          inputSummary: "bun test",
        },
        {
          id: "success",
          runId: "run-1",
          title: "read",
          kind: "read",
          status: "completed",
          depth: 0,
          isWrapper: false,
          inputSummary: "README.md",
          outputSummary: "done",
        },
        {
          id: "error",
          runId: "run-1",
          title: "write",
          kind: "write",
          status: "failed",
          depth: 0,
          isWrapper: false,
          inputSummary: "notes.txt",
          errorSummary: "permission denied",
        },
      ],
      transcriptItems: [
        { type: "tool_call" as const, id: "pending" },
        { type: "tool_call" as const, id: "success" },
        { type: "tool_call" as const, id: "error" },
      ],
    };

    const view = new NanobossAppView(
      {
        render: () => [""],
        invalidate() {},
      } as never,
      createNanobossTuiTheme(),
      state,
    );

    const rendered = view.render(120);
    const pendingLine = rendered.find((line) => stripAnsi(line).includes("bash"));
    const successLine = rendered.find((line) => stripAnsi(line).includes("read"));
    const errorLine = rendered.find((line) => stripAnsi(line).includes("write"));

    const topBorder = rendered.find((line) => stripAnsi(line).includes("┌"));
    const bottomBorder = rendered.find((line) => stripAnsi(line).includes("└"));

    expect(topBorder).toBeDefined();
    expect(bottomBorder).toBeDefined();
    expect(pendingLine).toContain("\u001b[33m●\u001b[0m");
    expect(successLine).toContain("\u001b[32m●\u001b[0m");
    expect(errorLine).toContain("\u001b[31m●\u001b[0m");
  });

  test("does not paint streamed assistant content red after a failed run", () => {
    const state = {
      ...createInitialUiState({ cwd: "/repo" }),
      sessionId: "session-1",
      turns: [
        {
          id: "assistant-1",
          role: "assistant" as const,
          markdown: "partial useful answer",
          status: "failed" as const,
          meta: {
            failureMessage: "boom",
          },
        },
      ],
      transcriptItems: [{ type: "turn" as const, id: "assistant-1" }],
    };

    const view = new NanobossAppView(
      {
        render: () => [""],
        invalidate() {},
      } as never,
      createNanobossTuiTheme(),
      state,
    );

    const rendered = view.render(120);
    const joined = rendered.join("\n");
    const plain = stripAnsi(joined);

    expect(plain).toContain("partial useful answer");
    expect(plain).toContain("Error: boom");

    const contentLine = rendered.find((line) => stripAnsi(line).includes("partial useful answer"));
    const errorLine = rendered.find((line) => stripAnsi(line).includes("Error: boom"));
    const labelLine = rendered.find((line) => stripAnsi(line).trim() === "nanoboss");

    expect(contentLine).toBeDefined();
    expect(contentLine).not.toContain("\u001b[31m");
    expect(errorLine).toContain("\u001b[31m");
    expect(labelLine).toContain("\u001b[31m");
  });
});

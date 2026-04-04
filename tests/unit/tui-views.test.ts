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
          callPreview: { header: "read README.md" },
          resultPreview: { bodyLines: ["Project instructions"] },
          errorPreview: undefined,
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
    const toolIndex = plainLines.findIndex((line) => line.includes("read README.md"));
    const assistantIndex = plainLines.findIndex((line) => line.includes("I checked the code."));
    const activityIndex = plainLines.findIndex((line) => line.trim() === "activity");

    expect(toolIndex).toBeGreaterThan(userIndex);
    expect(assistantIndex).toBeGreaterThan(toolIndex);
    expect(joined).toContain("Project instructions");
    expect(activityIndex).toBeGreaterThan(assistantIndex);
    expect(joined).not.toContain("[tool]");
  });

  test("renders pending, success, and error tool cards with distinct backgrounds", () => {
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
          callPreview: { header: "$ bun test" },
        },
        {
          id: "success",
          runId: "run-1",
          title: "read",
          kind: "read",
          status: "completed",
          depth: 0,
          isWrapper: false,
          callPreview: { header: "read README.md" },
          resultPreview: { bodyLines: ["done"] },
        },
        {
          id: "error",
          runId: "run-1",
          title: "write",
          kind: "write",
          status: "failed",
          depth: 0,
          isWrapper: false,
          callPreview: { header: "write notes.txt" },
          errorPreview: { bodyLines: ["permission denied"] },
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
    const pendingLine = rendered.find((line) => stripAnsi(line).includes("$ bun test"));
    const successLine = rendered.find((line) => stripAnsi(line).includes("read README.md"));
    const errorLine = rendered.find((line) => stripAnsi(line).includes("write notes.txt"));

    expect(pendingLine).toContain("\u001b[48;5;236m");
    expect(successLine).toContain("\u001b[48;5;22m");
    expect(errorLine).toContain("\u001b[48;5;52m");
  });

  test("styled tool header spans preserve the card background", () => {
    const state = {
      ...createInitialUiState({ cwd: "/repo", showToolCalls: true }),
      sessionId: "session-1",
      toolCalls: [
        {
          id: "tool-1",
          runId: "run-1",
          title: "find",
          kind: "find",
          status: "completed",
          depth: 0,
          isWrapper: false,
          callPreview: {
            header: "find /Users/jflam/agentboss/workspaces/nanoboss @ /repo",
          },
        },
      ],
      transcriptItems: [{ type: "tool_call" as const, id: "tool-1" }],
    };

    const view = new NanobossAppView(
      {
        render: () => [""],
        invalidate() {},
      } as never,
      createNanobossTuiTheme(),
      state,
    );

    const headerLine = view.render(160).find((line) => stripAnsi(line).includes("find /Users/jflam/agentboss/workspaces/nanoboss @ /repo"));

    expect(headerLine).toBeDefined();
    expect(headerLine).toContain("\u001b[48;5;22m");
    expect(headerLine).not.toContain("\u001b[0m");
  });

  test("default procedure cards do not repeat the user prompt", () => {
    const view = new NanobossAppView(
      {
        render: () => [""],
        invalidate() {},
      } as never,
      createNanobossTuiTheme(),
      {
        ...createInitialUiState({ cwd: "/repo", showToolCalls: true }),
        sessionId: "session-1",
        toolCalls: [
          {
            id: "tool-1",
            runId: "run-1",
            title: "Calling default procedure",
            kind: "other",
            status: "completed",
            depth: 0,
            isWrapper: true,
            callPreview: { header: "Calling default procedure" },
            resultPreview: { bodyLines: ["explain to me what you fixed in the last commit"] },
            durationMs: 17,
          },
        ],
        transcriptItems: [{ type: "tool_call" as const, id: "tool-1" }],
      },
    );

    const rendered = stripAnsi(view.render(120).join("\n"));
    expect(rendered).toContain("Calling default procedure");
    expect(rendered).not.toContain("explain to me what you fixed in the last commit");
  });

  test("collapsed tool output can be expanded globally", () => {
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    const collapsedView = new NanobossAppView(
      {
        render: () => [""],
        invalidate() {},
      } as never,
      createNanobossTuiTheme(),
      {
        ...createInitialUiState({ cwd: "/repo", showToolCalls: true, expandedToolOutput: false }),
        sessionId: "session-1",
        toolCalls: [
          {
            id: "tool-1",
            runId: "run-1",
            title: "read",
            kind: "read",
            status: "completed",
            depth: 0,
            isWrapper: false,
            callPreview: { header: "read README.md" },
            resultPreview: { bodyLines: lines, truncated: true },
          },
        ],
        transcriptItems: [{ type: "tool_call" as const, id: "tool-1" }],
      },
    );
    const expandedView = new NanobossAppView(
      {
        render: () => [""],
        invalidate() {},
      } as never,
      createNanobossTuiTheme(),
      {
        ...createInitialUiState({ cwd: "/repo", showToolCalls: true, expandedToolOutput: true }),
        sessionId: "session-1",
        toolCalls: [
          {
            id: "tool-1",
            runId: "run-1",
            title: "read",
            kind: "read",
            status: "completed",
            depth: 0,
            isWrapper: false,
            callPreview: { header: "read README.md" },
            resultPreview: { bodyLines: lines, truncated: true },
          },
        ],
        transcriptItems: [{ type: "tool_call" as const, id: "tool-1" }],
      },
    );

    const collapsed = stripAnsi(collapsedView.render(120).join("\n"));
    const expanded = stripAnsi(expandedView.render(120).join("\n"));

    expect(collapsed).toContain("line 1");
    expect(collapsed).toContain("... (2 more lines, ctrl+o to expand)");
    expect(collapsed).not.toContain("line 12");
    expect(expanded).toContain("line 12");
    expect(expanded).not.toContain("... (2 more lines, ctrl+o to expand)");
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

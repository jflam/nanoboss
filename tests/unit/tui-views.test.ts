import { describe, expect, test } from "bun:test";

import { createInitialUiState } from "../../src/tui/state.ts";
import { createNanobossTuiTheme } from "../../src/tui/theme.ts";
import { NanobossAppView } from "../../src/tui/views.ts";

function stripAnsi(text: string): string {
  const esc = String.fromCharCode(27);
  let result = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);

    if (char === esc && text.charAt(index + 1) === "[") {
      let cursor = index + 2;

      while (cursor < text.length) {
        const code = text.charCodeAt(cursor);

        if ((code < 48 || code > 57) && code !== 59) {
          break;
        }

        cursor += 1;
      }

      if (text.charAt(cursor) === "m") {
        index = cursor;
        continue;
      }
    }

    result += char;
  }

  return result;
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

  test("renders tool cards inline in transcript order without a separate activity panel", () => {
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

    expect(toolIndex).toBeGreaterThan(userIndex);
    expect(assistantIndex).toBeGreaterThan(toolIndex);
    expect(joined).toContain("Project instructions");
    expect(joined).not.toContain("activity");
    expect(joined).not.toContain("[memory] injected 1 card");
    expect(joined).not.toContain("[tool]");
  });

  test("renders tool cards with a neutral dark background and marks failures with a red dot", () => {
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

    expect(pendingLine).toContain("\u001b[48;2;32;32;32m");
    expect(successLine).toContain("\u001b[48;2;32;32;32m");
    expect(errorLine).toContain("\u001b[48;2;32;32;32m");
    expect(errorLine).toContain("\u001b[38;2;248;113;113m●\u001b[39m");
    expect(stripAnsi(errorLine ?? "")).toContain("● write notes.txt");
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
    expect(headerLine).toContain("\u001b[48;2;32;32;32m");
    expect(headerLine).not.toContain("\u001b[0m");
  });

  test("renders light tool cards with explicit readable header, body, and meta colors", () => {
    const theme = createNanobossTuiTheme();
    theme.setToolCardMode("light");
    const view = new NanobossAppView(
      {
        render: () => [""],
        invalidate() {},
      } as never,
      theme,
      {
        ...createInitialUiState({ cwd: "/repo", showToolCalls: true }),
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
          },
          {
            id: "tool-2",
            runId: "run-1",
            title: "bash",
            kind: "bash",
            status: "completed",
            depth: 0,
            isWrapper: false,
            callPreview: { header: "$ bun test" },
            resultPreview: {
              bodyLines: Array.from({ length: 12 }, (_, index) => `line ${index + 1}`),
              truncated: true,
            },
          },
        ],
        transcriptItems: [
          { type: "tool_call" as const, id: "tool-1" },
          { type: "tool_call" as const, id: "tool-2" },
        ],
      },
    );

    const rendered = view.render(120);
    const headerLine = rendered.find((entry) => stripAnsi(entry).includes("read README.md"));
    const bodyLine = rendered.find((entry) => stripAnsi(entry).includes("line 1"));
    const metaLine = rendered.find((entry) => stripAnsi(entry).includes("ctrl+o to expand"));

    expect(headerLine).toContain("\u001b[48;2;236;236;236m");
    expect(headerLine).toContain("\u001b[1;38;2;15;23;42mread\u001b[22;39m");
    expect(headerLine).toContain("\u001b[38;2;3;105;161mREADME.md\u001b[39m");
    expect(bodyLine).toContain("\u001b[38;2;31;41;55mline 1\u001b[39m");
    expect(metaLine).toContain("\u001b[38;2;71;85;105m... (");
    expect(metaLine).toContain("ctrl+o to expand)\u001b[39m");
  });

  test("renders light-mode code previews with readable syntax colors", () => {
    const theme = createNanobossTuiTheme();
    theme.setToolCardMode("light");
    const view = new NanobossAppView(
      {
        render: () => [""],
        invalidate() {},
      } as never,
      theme,
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
            callPreview: { header: "read src/example.ts" },
            resultPreview: { bodyLines: ["const answer = 42;"] },
            rawInput: { path: "src/example.ts" },
          },
        ],
        transcriptItems: [{ type: "tool_call" as const, id: "tool-1" }],
      },
    );

    const highlightedLine = view.render(120).find((line) => stripAnsi(line).includes("const answer = 42;"));

    expect(highlightedLine).toContain("\u001b[38;2;29;78;216mconst");
    expect(highlightedLine).toContain("\u001b[38;2;21;101;192m42");
  });

  test("renders light-mode diff output with readable accent and status colors", () => {
    const theme = createNanobossTuiTheme();
    theme.setToolCardMode("light");
    const view = new NanobossAppView(
      {
        render: () => [""],
        invalidate() {},
      } as never,
      theme,
      {
        ...createInitialUiState({ cwd: "/repo", showToolCalls: true, expandedToolOutput: true }),
        sessionId: "session-1",
        toolCalls: [
          {
            id: "tool-1",
            runId: "run-1",
            title: "bash",
            kind: "bash",
            status: "completed",
            depth: 0,
            isWrapper: false,
            callPreview: { header: "$ git diff -- src/example.ts" },
            resultPreview: {
              bodyLines: [
                "diff --git a/src/example.ts b/src/example.ts",
                "@@ -1 +1 @@",
                "-const before = 1;",
                "+const after = 2;",
              ],
            },
          },
        ],
        transcriptItems: [{ type: "tool_call" as const, id: "tool-1" }],
      },
    );

    const rendered = view.render(120);
    const hunkLine = rendered.find((line) => stripAnsi(line).includes("@@ -1 +1 @@"));
    const removedLine = rendered.find((line) => stripAnsi(line).includes("-const before = 1;"));
    const addedLine = rendered.find((line) => stripAnsi(line).includes("+const after = 2;"));

    expect(hunkLine).toContain("\u001b[38;2;3;105;161m");
    expect(removedLine).toContain("\u001b[38;2;153;27;27m");
    expect(addedLine).toContain("\u001b[38;2;22;101;52m");
  });

  test("renders completion notes under completed assistant turns", () => {
    const view = new NanobossAppView(
      {
        render: () => [""],
        invalidate() {},
      } as never,
      createNanobossTuiTheme(),
      {
        ...createInitialUiState({ cwd: "/repo" }),
        sessionId: "session-1",
        turns: [
          {
            id: "assistant-1",
            role: "assistant" as const,
            markdown: "Done.",
            status: "complete" as const,
            meta: {
              completionNote: "turn #1 completed in 2.5s | tools 1/2 succeeded",
            },
          },
        ],
        transcriptItems: [{ type: "turn" as const, id: "assistant-1" }],
      },
    );

    const plain = stripAnsi(view.render(120).join("\n"));
    expect(plain).toContain("Done.");
    expect(plain).toContain("turn #1 completed in 2.5s | tools 1/2 succeeded");
  });

  test("renders read tool code with pi-style syntax colors", () => {
    const view = new NanobossAppView(
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
            callPreview: { header: "read src/example.ts" },
            resultPreview: { bodyLines: ["const answer = 42;"] },
            rawInput: { path: "src/example.ts" },
          },
        ],
        transcriptItems: [{ type: "tool_call" as const, id: "tool-1" }],
      },
    );

    const highlightedLine = view.render(120).find((line) => stripAnsi(line).includes("const answer = 42;"));

    expect(highlightedLine).toContain("\u001b[38;2;86;156;214mconst");
    expect(highlightedLine).toContain("\u001b[38;2;181;206;168m42");
  });

  test("renders unified diff lines with red and green colors in read cards", () => {
    const view = new NanobossAppView(
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
            callPreview: { header: "read changes.diff" },
            resultPreview: {
              bodyLines: [
                "--- a/src/example.ts",
                "+++ b/src/example.ts",
                "@@ -1 +1 @@",
                "-const before = 1;",
                "+const after = 2;",
              ],
            },
            rawInput: { path: "changes.diff" },
          },
        ],
        transcriptItems: [{ type: "tool_call" as const, id: "tool-1" }],
      },
    );

    const rendered = view.render(120);
    const removedLine = rendered.find((line) => stripAnsi(line).includes("-const before = 1;"));
    const addedLine = rendered.find((line) => stripAnsi(line).includes("+const after = 2;"));
    const hunkLine = rendered.find((line) => stripAnsi(line).includes("@@ -1 +1 @@"));

    expect(removedLine).toContain("\u001b[38;2;248;113;113m");
    expect(addedLine).toContain("\u001b[38;2;74;222;128m");
    expect(hunkLine).toContain("\u001b[38;2;125;211;252m");
  });

  test("renders bash diff output with red and green colors", () => {
    const view = new NanobossAppView(
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
            title: "bash",
            kind: "bash",
            status: "completed",
            depth: 0,
            isWrapper: false,
            callPreview: { header: "$ git diff -- src/example.ts" },
            resultPreview: {
              bodyLines: [
                "diff --git a/src/example.ts b/src/example.ts",
                "index 1111111..2222222 100644",
                "--- a/src/example.ts",
                "+++ b/src/example.ts",
                "@@ -1 +1 @@",
                "-const before = 1;",
                "+const after = 2;",
              ],
            },
          },
        ],
        transcriptItems: [{ type: "tool_call" as const, id: "tool-1" }],
      },
    );

    const rendered = view.render(120);
    const removedLine = rendered.find((line) => stripAnsi(line).includes("-const before = 1;"));
    const addedLine = rendered.find((line) => stripAnsi(line).includes("+const after = 2;"));

    expect(removedLine).toContain("\u001b[38;2;248;113;113m");
    expect(addedLine).toContain("\u001b[38;2;74;222;128m");
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

  test("expanded tool output uses preserved raw tool payloads", () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    const view = new NanobossAppView(
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
            title: "Read File",
            kind: "read",
            status: "completed",
            depth: 0,
            isWrapper: false,
            callPreview: { header: "read README.md" },
            resultPreview: { bodyLines: ["line 1"], truncated: true },
            rawInput: {
              file_path: "/very/long/path/to/README.md",
            },
            rawOutput: {
              file: {
                filePath: "/very/long/path/to/README.md",
                content: lines.join("\n"),
              },
            },
          },
        ],
        transcriptItems: [{ type: "tool_call" as const, id: "tool-1" }],
      },
    );

    const expanded = stripAnsi(view.render(160).join("\n"));

    expect(expanded).toContain("read /very/long/path/to/README.md");
    expect(expanded).toContain("line 20");
    expect(expanded).not.toContain("... (19 more lines, ctrl+o to expand)");
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

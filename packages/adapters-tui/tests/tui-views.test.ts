import { describe, expect, test } from "bun:test";

import type { RenderedFrontendEventEnvelope } from "@nanoboss/adapters-http";
import {
  createInitialUiState,
  createNanobossTuiTheme,
  NanobossAppView,
  reduceUiState,
} from "@nanoboss/adapters-tui";

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
  test("can swap the editor area for an inline picker and restore it", () => {
    const state = {
      ...createInitialUiState({ cwd: "/repo" }),
      sessionId: "session-1",
    };

    const view = new NanobossAppView(
      {
        render: () => ["[editor]"],
        invalidate() {},
      } as never,
      createNanobossTuiTheme(),
      state,
    );

    view.showComposer({
      render: () => ["[picker]"],
      invalidate() {},
    });
    expect(stripAnsi(view.render(120).join("\n"))).toContain("[picker]");
    expect(stripAnsi(view.render(120).join("\n"))).not.toContain("[editor]");

    view.showEditor();
    expect(stripAnsi(view.render(120).join("\n"))).toContain("[editor]");
    expect(stripAnsi(view.render(120).join("\n"))).not.toContain("[picker]");
  });

  test("shows a busy indicator while a run is active", () => {
    const state = {
      ...createInitialUiState({ cwd: "/repo" }),
      sessionId: "session-1",
      inputDisabled: true,
      pendingPrompts: [
        { id: "pending-1", text: "steer next", kind: "steering" as const },
        { id: "pending-2", text: "then queue", kind: "queued" as const },
      ],
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

    const plain = stripAnsi(view.render(200).join("\n"));

    expect(plain).toContain("● busy");
    expect(plain).toContain("steer 1");
    expect(plain).toContain("queued 1");
    expect(plain).toContain("agent copilot");
    expect(plain).toContain("enter steer");
    expect(plain).toContain("tab queue");
  });

  test("shows a live run timer next to token usage while a run is active", () => {
    const state = {
      ...createInitialUiState({ cwd: "/repo" }),
      sessionId: "session-1",
      inputDisabled: true,
      runStartedAtMs: 5_000,
      tokenUsageLine: "[tokens] 512 / 8,192 (6.3%)",
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
      () => 70_000,
    );

    const plain = stripAnsi(view.render(200).join("\n"));

    expect(plain).toContain("[time] 1:05");
    expect(plain).toContain("[tokens] 512 / 8,192 (6.3%)");
  });

  test("shows simplify2 auto-approve state in the activity and footer lines", () => {
    const state = {
      ...createInitialUiState({ cwd: "/repo" }),
      sessionId: "session-1",
      simplify2AutoApprove: true,
    };

    const view = new NanobossAppView(
      {
        render: () => [""],
        invalidate() {},
      } as never,
      createNanobossTuiTheme(),
      state,
    );

    const plain = stripAnsi(view.render(200).join("\n"));

    expect(plain).toContain("auto-approve on");
    expect(plain).toContain("ctrl+g auto-approve");
  });

  test("shows the active continuation and the /dismiss escape hatch in the status area", () => {
    const state = {
      ...createInitialUiState({ cwd: "/repo" }),
      sessionId: "session-1",
      statusLine: "[continuation] /simplify active - waiting for your reply",
      pendingContinuation: {
        procedure: "simplify",
        question: "What would you like instead?",
      },
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

    const plain = stripAnsi(view.render(200).join("\n"));

    expect(plain).toContain("[continuation] /simplify active - waiting for your reply");
    expect(plain).toContain("continuation /simplify");
    expect(plain).toContain("/dismiss");
  });

  test("renders the reducer-produced visible transcript contract and resets cleanly on session_ready", () => {
    let state = createTranscriptContractState("live");

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
    const promptIndex = plainLines.findIndex((line) => line.includes("review the repo"));
    const toolIndex = plainLines.findIndex((line) => line.includes("read README.md"));
    const assistantIndex = plainLines.findIndex((line) => line.includes("I checked the code."));

    expect(toolIndex).toBeGreaterThan(promptIndex);
    expect(assistantIndex).toBeGreaterThan(toolIndex);
    expect(joined).toContain("Project instructions");
    expect(joined).not.toContain("stored summary");
    expect(joined).not.toContain("stored memory");

    state = reduceUiState(state, {
      type: "session_ready",
      sessionId: "session-2",
      cwd: "/repo",
      buildLabel: "nanoboss-test",
      agentLabel: "copilot/default",
      autoApprove: false,
      commands: [{ name: "tokens", description: "show tokens" }],
    });
    view.setState(state);

    const resetPlain = stripAnsi(view.render(120).join("\n"));

    expect(resetPlain).toContain("No turns yet. Send a prompt to start.");
    expect(resetPlain).not.toContain("review the repo");
    expect(resetPlain).not.toContain("read README.md");
  });

  test("renders restored replay history with the same visible transcript output as a live run", () => {
    const liveView = new NanobossAppView(
      {
        render: () => [""],
        invalidate() {},
      } as never,
      createNanobossTuiTheme(),
      createTranscriptContractState("live"),
    );
    const restoredView = new NanobossAppView(
      {
        render: () => [""],
        invalidate() {},
      } as never,
      createNanobossTuiTheme(),
      createTranscriptContractState("restored"),
    );

    expect(stripAnsi(restoredView.render(120).join("\n"))).toBe(stripAnsi(liveView.render(120).join("\n")));
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
          toolName: "bash",
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
          toolName: "read",
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
          toolName: "write",
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
          toolName: "find",
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

  test("keeps provider-specific read previews aligned with expanded tool cards", () => {
    const rawInput = {
      file_path: "src/mcp/jsonrpc.ts",
      locations: [{ path: "src/mcp/jsonrpc.ts", line: 12 }],
    };
    const rawOutput = {
      type: "text",
      file: {
        filePath: "src/mcp/jsonrpc.ts",
        content: "export const hello = 1;\nexport const world = 2;",
      },
      duration_ms: 12,
    };
    const toolCall = {
      id: "tool-read",
      runId: "run-1",
      title: "Read File",
      kind: "read",
      toolName: "read",
      status: "completed",
      depth: 0,
      isWrapper: false,
      rawInput,
      rawOutput,
      callPreview: {
        header: "read src/mcp/jsonrpc.ts:12",
      },
      resultPreview: {
        bodyLines: [
          "export const hello = 1;",
          "export const world = 2;",
        ],
      },
      durationMs: 12,
    };

    const baseState = {
      ...createInitialUiState({ cwd: "/repo", showToolCalls: true }),
      sessionId: "session-1",
      toolCalls: [toolCall],
      transcriptItems: [{ type: "tool_call" as const, id: "tool-read" }],
    };

    const collapsedView = new NanobossAppView(
      {
        render: () => [""],
        invalidate() {},
      } as never,
      createNanobossTuiTheme(),
      baseState,
    );
    const expandedView = new NanobossAppView(
      {
        render: () => [""],
        invalidate() {},
      } as never,
      createNanobossTuiTheme(),
      {
        ...baseState,
        expandedToolOutput: true,
      },
    );

    const collapsed = stripAnsi(collapsedView.render(160).join("\n"));
    const expanded = stripAnsi(expandedView.render(160).join("\n"));

    expect(collapsed).toContain("read src/mcp/jsonrpc.ts:12");
    expect(expanded).toContain("read src/mcp/jsonrpc.ts:12");
    expect(collapsed).toContain("export const hello = 1;");
    expect(expanded).toContain("export const hello = 1;");
    expect(collapsed).toContain("export const world = 2;");
    expect(expanded).toContain("export const world = 2;");
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

    expect(headerLine).toContain("\u001b[48;2;245;245;246m");
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

    const rendered = view.render(120);
    const plain = stripAnsi(rendered.join("\n"));
    const noteLine = rendered.find((line) => stripAnsi(line).includes("turn #1 completed in 2.5s | tools 1/2 succeeded"));

    expect(plain).toContain("Done.");
    expect(plain).toContain("turn #1 completed in 2.5s | tools 1/2 succeeded");
    expect(noteLine).toContain("\u001b[48;2;32;32;32m");
  });

  test("renders stopped assistant status messages as cards", () => {
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
            markdown: "Stopped.",
            status: "cancelled" as const,
            displayStyle: "card" as const,
            cardTone: "warning" as const,
          },
        ],
        transcriptItems: [{ type: "turn" as const, id: "assistant-1" }],
      },
    );

    const rendered = view.render(120);
    const stoppedLine = rendered.find((line) => stripAnsi(line).includes("Stopped."));

    expect(stripAnsi(rendered.join("\n"))).toContain("Stopped.");
    expect(stoppedLine).toContain("\u001b[48;2;32;32;32m");
    expect(stoppedLine).toContain("\u001b[38;2;253;186;116mStopped.\u001b[39m");
  });

  test("renders markdown inside assistant cards instead of raw markdown syntax", () => {
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
            markdown: "## Research checkpoint\n\n_report_\n\n- cited source",
            status: "complete" as const,
            displayStyle: "card" as const,
            cardTone: "info" as const,
          },
        ],
        transcriptItems: [{ type: "turn" as const, id: "assistant-1" }],
      },
    );

    const plain = stripAnsi(view.render(120).join("\n"));

    expect(plain).toContain("Research checkpoint");
    expect(plain).not.toContain("## Research checkpoint");
    expect(plain).not.toContain("_report_");
  });

  test("renders info assistant notices as cards", () => {
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
            markdown: "Operation cancelled by user",
            status: "complete" as const,
            displayStyle: "card" as const,
            cardTone: "info" as const,
          },
        ],
        transcriptItems: [{ type: "turn" as const, id: "assistant-1" }],
      },
    );

    const rendered = view.render(120);
    const infoLine = rendered.find((line) => stripAnsi(line).includes("Operation cancelled by user"));

    expect(stripAnsi(rendered.join("\n"))).toContain("Operation cancelled by user");
    expect(infoLine).toContain("\u001b[48;2;32;32;32m");
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

  test("activity bar shows the active procedure while a run is busy", () => {
    const view = new NanobossAppView(
      {
        render: () => [""],
        invalidate() {},
      } as never,
      createNanobossTuiTheme(),
      {
        ...createInitialUiState({ cwd: "/repo", showToolCalls: true }),
        sessionId: "session-1",
        inputDisabled: true,
        activeProcedure: "linter",
      },
    );

    const rendered = stripAnsi(view.render(120).join("\n"));
    expect(rendered).toContain("procedure /linter");
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
            toolName: "read",
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
            toolName: "read",
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
            toolName: "read",
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

  test("expanded cards keep canonical tool rendering even if the title drifts later", () => {
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
            title: "Write File",
            kind: "read",
            toolName: "read",
            status: "completed",
            depth: 0,
            isWrapper: false,
            callPreview: { header: "read src/example.ts" },
            resultPreview: { bodyLines: ["const answer = 42;"], truncated: true },
            rawInput: {
              file_path: "src/example.ts",
            },
            rawOutput: {
              file: {
                filePath: "src/example.ts",
                content: "const answer = 42;\nexport const next = 43;",
              },
            },
          },
        ],
        transcriptItems: [{ type: "tool_call" as const, id: "tool-1" }],
      },
    );

    const expanded = stripAnsi(view.render(160).join("\n"));

    expect(expanded).toContain("read src/example.ts");
    expect(expanded).toContain("export const next = 43;");
    expect(expanded).not.toContain("file_path");
  });

  test("expanded agent tool output uses expanded-only completion content", () => {
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
            title: "callAgent: summarize the diff",
            kind: "other",
            toolName: "agent",
            status: "completed",
            depth: 0,
            isWrapper: false,
            callPreview: { header: "callAgent: summarize the diff" },
            resultPreview: { bodyLines: ["stored result in cell-1"] },
            rawOutput: {
              run: { sessionId: "session-1", runId: "cell-1" },
              dataRef: { run: { sessionId: "session-1", runId: "cell-1" }, path: "data" },
              expandedContent: "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8",
            },
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
            title: "callAgent: summarize the diff",
            kind: "other",
            toolName: "agent",
            status: "completed",
            depth: 0,
            isWrapper: false,
            callPreview: { header: "callAgent: summarize the diff" },
            resultPreview: { bodyLines: ["stored result in cell-1"] },
            rawOutput: {
              run: { sessionId: "session-1", runId: "cell-1" },
              dataRef: { run: { sessionId: "session-1", runId: "cell-1" }, path: "data" },
              expandedContent: "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8",
            },
          },
        ],
        transcriptItems: [{ type: "tool_call" as const, id: "tool-1" }],
      },
    );

    const collapsed = stripAnsi(collapsedView.render(160).join("\n"));
    const expanded = stripAnsi(expandedView.render(160).join("\n"));

    expect(collapsed).toContain("stored result in cell-1");
    expect(collapsed).not.toContain("line 8");
    expect(expanded).toContain("line 8");
    expect(expanded).not.toContain("stored result in cell-1");
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
    expect(errorLine).toContain("\u001b[38;2;248;113;113m");
    expect(errorLine).toContain("\u001b[48;2;32;32;32m");
    expect(labelLine).toContain("\u001b[31m");
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

function createTranscriptContractState(mode: "live" | "restored") {
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

  if (mode === "live") {
    state = reduceUiState(state, {
      type: "local_user_submitted",
      text: "review the repo",
    });
  } else {
    state = reduceUiState(state, {
      type: "frontend_event",
      event: eventEnvelope("run_restored", {
        runId: "run-1",
        procedure: "default",
        prompt: "review the repo",
        completedAt: new Date(1_000).toISOString(),
        run: { sessionId: "session-1", runId: "cell-1" },
        status: "complete",
      }),
    });
  }

  for (const event of createTranscriptContractReplayEvents()) {
    state = reduceUiState(state, {
      type: "frontend_event",
      event,
    });
  }

  return state;
}

function createTranscriptContractReplayEvents(): RenderedFrontendEventEnvelope[] {
  return [
    eventEnvelope("run_started", {
      runId: "run-1",
      procedure: "default",
      prompt: "review the repo",
      startedAt: new Date(0).toISOString(),
    }),
    eventEnvelope("tool_started", {
      runId: "run-1",
      toolCallId: "tool-1",
      title: "Mock read README.md",
      kind: "read",
      callPreview: { header: "read README.md" },
    }),
    eventEnvelope("tool_updated", {
      runId: "run-1",
      toolCallId: "tool-1",
      status: "completed",
      resultPreview: { bodyLines: ["Project instructions"] },
    }),
    eventEnvelope("text_delta", {
      runId: "run-1",
      text: "I checked the code.",
      stream: "agent",
    }),
    eventEnvelope("procedure_card", {
      runId: "run-1",
      card: {
        type: "card",
        procedure: "default",
        kind: "report",
        title: "Checkpoint",
        markdown: "- README reviewed",
      },
    }),
    eventEnvelope("run_completed", {
      runId: "run-1",
      procedure: "default",
      completedAt: new Date(1_000).toISOString(),
      run: { sessionId: "session-1", runId: "cell-1" },
    }),
  ];
}

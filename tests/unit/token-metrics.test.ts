import { expect, test } from "bun:test";

import { collectTokenSnapshot, parseClaudeDebugMetrics, parseCopilotLogMetrics, parseCopilotSessionState } from "../../src/token-metrics.ts";

test("collectTokenSnapshot uses ACP usage_update for codex", async () => {
  const snapshot = await collectTokenSnapshot({
    childPid: 123,
    config: {
      provider: "codex",
      command: "codex-acp",
      args: [],
      model: "gpt-5.2-codex/xhigh",
    },
    sessionId: "codex-session",
    updates: [
      {
        sessionUpdate: "usage_update",
        size: 258400,
        used: 14898,
      },
    ],
  });

  expect(snapshot).toEqual({
    provider: "codex",
    model: "gpt-5.2-codex/xhigh",
    sessionId: "codex-session",
    source: "acp_usage_update",
    contextWindowTokens: 258400,
    usedContextTokens: 14898,
  });
});

test("parseClaudeDebugMetrics extracts the latest autocompact line", () => {
  const snapshot = parseClaudeDebugMetrics(
    [
      "2026-04-02T15:48:46.999Z [DEBUG] autocompact: tokens=1508 threshold=167000 effectiveWindow=180000",
      "2026-04-02T15:48:50.752Z [DEBUG] autocompact: tokens=27685 threshold=167000 effectiveWindow=180000",
      "2026-04-02T15:48:52.694Z [DEBUG] autocompact: tokens=27707 threshold=167000 effectiveWindow=180000",
    ].join("\n"),
    {
      provider: "claude",
      command: "claude-code-acp",
      args: [],
      model: "sonnet",
    },
    "claude-session",
  );

  expect(snapshot).toEqual({
    provider: "claude",
    model: "sonnet",
    sessionId: "claude-session",
    source: "claude_debug",
    capturedAt: "2026-04-02T15:48:52.694Z",
    usedContextTokens: 27707,
    contextWindowTokens: 180000,
  });
});

test("parseCopilotLogMetrics extracts context and turn usage from telemetry logs", () => {
  const text = [
    "2026-04-02T15:48:30.942Z [INFO] [Telemetry] cli.telemetry:",
    JSON.stringify({
      kind: "session_usage_info",
      created_at: "2026-04-02T15:48:30.942Z",
      session_id: "copilot-session",
      metrics: {
        token_limit: 272000,
        current_tokens: 24152,
        messages_length: 4,
        system_tokens: 8011,
        conversation_tokens: 2178,
        tool_definitions_tokens: 13963,
      },
    }, null, 2),
    "2026-04-02T15:48:35.031Z [INFO] [Telemetry] cli.telemetry:",
    JSON.stringify({
      kind: "assistant_usage",
      created_at: "2026-04-02T15:48:35.031Z",
      session_id: "copilot-session",
      metrics: {
        input_tokens: 20964,
        input_tokens_uncached: 19428,
        output_tokens: 92,
        cache_read_tokens: 1536,
        cache_write_tokens: 0,
      },
    }, null, 2),
  ].join("\n");

  const snapshot = parseCopilotLogMetrics(text, {
    provider: "copilot",
    command: "copilot",
    args: ["--acp"],
    model: "gpt-5.4",
  }, "copilot-session");

  expect(snapshot).toEqual({
    provider: "copilot",
    model: "gpt-5.4",
    sessionId: "copilot-session",
    source: "copilot_log",
    capturedAt: "2026-04-02T15:48:30.942Z",
    contextWindowTokens: 272000,
    usedContextTokens: 24152,
    systemTokens: 8011,
    conversationTokens: 2178,
    toolDefinitionsTokens: 13963,
    inputTokens: 19428,
    outputTokens: 92,
    cacheReadTokens: 1536,
    cacheWriteTokens: 0,
    totalTokens: 21056,
  });
});

test("parseCopilotSessionState falls back to shutdown metrics", () => {
  const text = [
    JSON.stringify({ type: "session.start", data: { sessionId: "copilot-session" } }),
    JSON.stringify({
      type: "session.shutdown",
      data: {
        currentModel: "gpt-5.4",
        currentTokens: 23530,
        systemTokens: 8011,
        conversationTokens: 2269,
        toolDefinitionsTokens: 13247,
        modelMetrics: {
          "gpt-5.4": {
            usage: {
              inputTokens: 63150,
              outputTokens: 248,
              cacheReadTokens: 43264,
              cacheWriteTokens: 0,
            },
          },
        },
      },
    }),
  ].join("\n");

  const snapshot = parseCopilotSessionState(text, {
    provider: "copilot",
    command: "copilot",
    args: ["--acp"],
    model: "gpt-5.4",
  }, "copilot-session");

  expect(snapshot).toEqual({
    provider: "copilot",
    model: "gpt-5.4",
    sessionId: "copilot-session",
    source: "copilot_session_state",
    contextWindowTokens: undefined,
    usedContextTokens: 23530,
    systemTokens: 8011,
    conversationTokens: 2269,
    toolDefinitionsTokens: 13247,
    inputTokens: 63150,
    outputTokens: 248,
    cacheReadTokens: 43264,
    cacheWriteTokens: 0,
    totalTokens: 106662,
  });
});

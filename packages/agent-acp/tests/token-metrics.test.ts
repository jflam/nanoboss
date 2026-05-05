import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import {
  collectTokenSnapshot,
} from "@nanoboss/agent-acp";

async function withTempHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const previousHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "nanoboss-token-home-"));
  process.env.HOME = home;
  try {
    return await run(home);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

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

test("collectTokenSnapshot falls back to ACP usage_update for generic agents", async () => {
  const snapshot = await collectTokenSnapshot({
    childPid: 123,
    config: {
      command: "bun",
      args: ["run", "tests/fixtures/mock-agent.ts"],
    },
    sessionId: "generic-session",
    updates: [
      {
        sessionUpdate: "usage_update",
        size: 8192,
        used: 512,
      },
    ],
  });

  expect(snapshot).toEqual({
    provider: undefined,
    model: undefined,
    sessionId: "generic-session",
    source: "acp_usage_update",
    contextWindowTokens: 8192,
    usedContextTokens: 512,
  });
});

test("collectTokenSnapshot extracts the latest Claude autocompact line", async () => {
  await withTempHome(async (home) => {
    const sessionId = "claude-session";
    const debugDir = join(home, ".claude", "debug");
    mkdirSync(debugDir, { recursive: true });
    writeFileSync(join(debugDir, `${sessionId}.txt`), [
      "2026-04-02T15:48:46.999Z [DEBUG] autocompact: tokens=1508 threshold=167000 effectiveWindow=180000",
      "2026-04-02T15:48:50.752Z [DEBUG] autocompact: tokens=27685 threshold=167000 effectiveWindow=180000",
      "2026-04-02T15:48:52.694Z [DEBUG] autocompact: tokens=27707 threshold=167000 effectiveWindow=180000",
    ].join("\n"));

    const snapshot = await collectTokenSnapshot({
      config: {
        provider: "claude",
        command: "claude-code-acp",
        args: [],
        model: "sonnet",
      },
      sessionId,
      updates: [],
    });

    expect(snapshot).toEqual({
      provider: "claude",
      model: "sonnet",
      sessionId,
      source: "claude_debug",
      capturedAt: "2026-04-02T15:48:52.694Z",
      usedContextTokens: 27707,
      contextWindowTokens: 180000,
    });
  });
});

test("collectTokenSnapshot extracts context and turn usage from matching Copilot telemetry logs", async () => {
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

  await withTempHome(async (home) => {
    const logsDir = join(home, ".copilot", "logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(logsDir, "process-1775161293564-99653.log"), text);

    const snapshot = await collectTokenSnapshot({
      childPid: 99653,
      config: {
        provider: "copilot",
        command: "copilot",
        args: ["--acp"],
        model: "gpt-5.4",
      },
      sessionId: "copilot-session",
      updates: [],
    });

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
});

test("collectTokenSnapshot falls back to Copilot shutdown metrics", async () => {
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

  await withTempHome(async (home) => {
    const sessionId = "copilot-session";
    const sessionStateDir = join(home, ".copilot", "session-state", sessionId);
    mkdirSync(sessionStateDir, { recursive: true });
    writeFileSync(join(sessionStateDir, "events.jsonl"), text);

    const snapshot = await collectTokenSnapshot({
      config: {
        provider: "copilot",
        command: "copilot",
        args: ["--acp"],
        model: "gpt-5.4",
      },
      sessionId,
      updates: [],
    });

    expect(snapshot).toEqual({
      provider: "copilot",
      model: "gpt-5.4",
      sessionId,
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
});

import { describe, expect, test } from "bun:test";

import {
  createHttpSession,
  sendSessionPrompt,
  startSessionEventStream,
} from "../../src/http/client.ts";
import type { FrontendEventEnvelope } from "../../src/http/frontend-events.ts";
import {
  reservePort,
  spawnNanoboss,
  waitForCountWithActivity,
  waitForHealth,
} from "./helpers.ts";

const runAsyncDispatchE2E =
  process.env.SKIP_E2E !== "1" &&
  process.env.NANOBOSS_RUN_E2E === "1" &&
  process.env.NANOBOSS_RUN_DISPATCH_RECOVERY_E2E === "1";

const describeAsyncDispatchE2E = runAsyncDispatchE2E ? describe : describe.skip;

// Opt-in real-agent regression scenario for the async slash-command dispatch
// steady state: long-running procedures should complete via short-lived
// start/wait polling, while nested visibility and master-session token
// attribution remain intact.
describeAsyncDispatchE2E("async procedure dispatch (real agent opt-in)", () => {
  test("/research keeps nested visibility and master-session token usage with async dispatch polling", async () => {
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const server = spawnNanoboss([
      "http",
      "--port",
      String(port),
    ], realAgentEnv());

    try {
      await waitForHealth(baseUrl, 20_000);

      const session = await createHttpSession(baseUrl, process.cwd());
      const events: FrontendEventEnvelope[] = [];
      const errors: string[] = [];
      const stream = startSessionEventStream({
        baseUrl,
        sessionId: session.sessionId,
        onEvent(event) {
          events.push(event);
        },
        onError(error) {
          errors.push(error instanceof Error ? error.message : String(error));
        },
      });

      try {
        await sendSessionPrompt(
          baseUrl,
          session.sessionId,
          "/research write a detailed report about the current nanoboss MCP architecture",
        );
        await waitForCompletedRuns(events, 1);

        const firstCompleted = completedRuns(events)[0];
        expect(firstCompleted?.data.procedure).toBe("research");
        expect(firstCompleted?.data.tokenUsage).toBeDefined();

        const toolTitles = events
          .filter((event) => event.type === "tool_started")
          .map((event) => event.data.title);
        expect(toolTitles).toContain("procedure_dispatch_start");
        expect(toolTitles).toContain("procedure_dispatch_wait");
        expect(toolTitles.some((title) => title.startsWith("callAgent:"))).toBe(true);

        await sendSessionPrompt(
          baseUrl,
          session.sessionId,
          "Summarize that result in one sentence.",
        );
        await waitForCompletedRuns(events, 2);

        expect(errors).toEqual([]);
      } finally {
        stream.close();
      }
    } finally {
      await server.stop();
    }
  }, 240_000);
});

function completedRuns(events: FrontendEventEnvelope[]) {
  return events.filter(
    (event): event is Extract<FrontendEventEnvelope, { type: "run_completed" }> => event.type === "run_completed",
  );
}

async function waitForCompletedRuns(
  events: FrontendEventEnvelope[],
  count: number,
): Promise<void> {
  await waitForCountWithActivity({
    events,
    countMatches: (currentEvents) => completedRuns(currentEvents).length,
    targetCount: count,
    idleTimeoutMs: 30_000,
    maxTotalTimeoutMs: 3_600_000,
    label: `completed runs >= ${count}`,
  });
}

function realAgentEnv(): Record<string, string> {
  return {
    ...process.env,
    NANOBOSS_HTTP_IDLE_TIMEOUT_SECONDS: process.env.NANOBOSS_HTTP_IDLE_TIMEOUT_SECONDS ?? "5",
    NANOBOSS_SSE_KEEPALIVE_MS: process.env.NANOBOSS_SSE_KEEPALIVE_MS ?? "100",
  } as Record<string, string>;
}

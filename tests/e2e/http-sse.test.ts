import { describe, expect, test } from "bun:test";

import {
  createHttpSession,
  sendSessionPrompt,
  startSessionEventStream,
} from "../../src/http-client.ts";
import type { FrontendEventEnvelope } from "../../src/frontend-events.ts";
import {
  mockAgentEnv,
  reservePort,
  spawnNanoboss,
  waitForHealth,
  waitForMatch,
} from "./helpers.ts";

describe("HTTP/SSE frontend integration", () => {
  test("streams one text delta for a simple prompt", async () => {
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const server = spawnNanoboss([
      "server",
      "--port",
      String(port),
    ], mockAgentEnv({
      NANO_AGENTBOSS_HTTP_IDLE_TIMEOUT_SECONDS: "5",
      NANO_AGENTBOSS_SSE_KEEPALIVE_MS: "100",
    }));

    try {
      await waitForHealth(baseUrl);

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
        await sendSessionPrompt(baseUrl, session.sessionId, "what is 2+2");
        await waitForMatch(
          () => events.map((event) => event.type).join(","),
          "run_completed",
        );

        const textEvents = events.filter((event) => event.type === "text_delta");
        expect(textEvents).toHaveLength(1);
        expect(textEvents[0]?.data.text).toBe("4");
        expect(errors).toEqual([]);
      } finally {
        stream.close();
      }
    } finally {
      await server.stop();
    }
  }, 20_000);
});

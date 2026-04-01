import { describe, expect, test } from "bun:test";

import {
  mockAgentEnv,
  reservePort,
  spawnNanoboss,
  waitForHealth,
  waitForMatch,
} from "./helpers.ts";

describe("HTTP CLI heartbeat visibility", () => {
  test("shows a heartbeat status line during long-running runs", async () => {
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const env = mockAgentEnv({
      NANO_AGENTBOSS_HTTP_IDLE_TIMEOUT_SECONDS: "5",
      NANO_AGENTBOSS_SSE_KEEPALIVE_MS: "100",
      NANO_AGENTBOSS_RUN_HEARTBEAT_MS: "100",
    });
    const server = spawnNanoboss(["server", "--port", String(port)], env);

    try {
      await waitForHealth(baseUrl);

      const cli = spawnNanoboss(["cli", "--server-url", baseUrl], env);
      try {
        await waitForMatch(cli.stdout, /> /);
        cli.write("simulate-long-run\n");

        await waitForMatch(cli.stderr, /\[tool\] defaultSession: simulate-long-run/);
        await waitForMatch(cli.stderr, /\[run\] default still working \([0-9]+s\)/, 10_000);
        await waitForMatch(cli.stdout, /> /, 20_000);

        expect(`${cli.stdout()}\n${cli.stderr()}`).not.toContain("Timed out waiting for run completion");
      } finally {
        await cli.stop();
      }
    } finally {
      await server.stop();
    }
  }, 30_000);
});

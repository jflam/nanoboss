import { describe, expect, test } from "bun:test";

import {
  mockAgentEnv,
  reservePort,
  spawnNanoboss,
  waitForHealth,
  waitForMatch,
} from "./helpers.ts";

describe("HTTP CLI nested tool trace rendering", () => {
  test("renders nested tool calls with rails under their parent wrapper", async () => {
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const env = mockAgentEnv({
      NANO_AGENTBOSS_HTTP_IDLE_TIMEOUT_SECONDS: "5",
      NANO_AGENTBOSS_SSE_KEEPALIVE_MS: "100",
    });
    const server = spawnNanoboss(["server", "--port", String(port)], env);

    try {
      await waitForHealth(baseUrl);

      const cli = spawnNanoboss(["cli", "--server-url", baseUrl], env);
      try {
        await waitForMatch(cli.stdout, /> /);
        cli.write("nested tool trace demo\n");

        await waitForMatch(cli.stderr, /\[tool\] defaultSession: nested tool trace demo/);
        await waitForMatch(cli.stderr, /│ \[tool\] Mock read README\.md/);
        await waitForMatch(cli.stdout, /> /, 20_000);

        expect(cli.stderr()).toContain("[tool] defaultSession: nested tool trace demo");
        expect(cli.stderr()).toContain("│ [tool] Mock read README.md");
      } finally {
        await cli.stop();
      }
    } finally {
      await server.stop();
    }
  }, 30_000);
});

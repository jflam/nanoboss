import { describe, expect, test } from "bun:test";
import { once } from "node:events";

import {
  mockAgentEnv,
  reservePort,
  spawnNanoboss,
  stripAnsi,
  waitForHealth,
  waitForMatch,
} from "./helpers.ts";

describe("HTTP CLI integration", () => {
  test("re-prompts after completion without duplicate output or stream errors", async () => {
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const env = mockAgentEnv({
      NANO_AGENTBOSS_HTTP_IDLE_TIMEOUT_SECONDS: "1",
      NANO_AGENTBOSS_SSE_KEEPALIVE_MS: "100",
    });
    const server = spawnNanoboss(["server", "--port", String(port)], env);

    try {
      await waitForHealth(baseUrl);

      const cli = spawnNanoboss(["cli", "--server-url", baseUrl], env);
      try {
        await waitForMatch(cli.stdout, /> /);
        cli.write("what is 2+2\n");

        await waitForMatch(cli.stderr, /callAgent: what is 2\+2/);
        await waitForMatch(() => stripAnsi(cli.stdout()), /4\n> /);
        await Bun.sleep(1_500);

        const normalizedStdout = stripAnsi(cli.stdout());
        expect(normalizedStdout).toContain("4");
        expect(normalizedStdout).not.toContain("44");
        expect(normalizedStdout.match(/> /g)?.length ?? 0).toBeGreaterThanOrEqual(2);
        expect(cli.stderr()).not.toContain("[stream]");
        expect(`${server.stdout()}\n${server.stderr()}`).not.toContain("request timed out");

        cli.write("quit\n");
        await Promise.race([
          once(cli.process, "exit"),
          Bun.sleep(5_000).then(() => {
            throw new Error("Timed out waiting for CLI exit");
          }),
        ]);
      } finally {
        await cli.stop();
      }
    } finally {
      await server.stop();
    }
  }, 20_000);
});

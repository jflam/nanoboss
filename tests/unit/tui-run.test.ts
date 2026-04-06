import { describe, expect, test } from "bun:test";

import { runTuiCli } from "../../src/tui/run.ts";

describe("runTuiCli", () => {
  test("stops the owned private server when app construction fails", async () => {
    const events: string[] = [];

    await expect(runTuiCli({
      cwd: "/repo-one",
      connectionMode: "private",
      showToolCalls: true,
    }, {
      startPrivateHttpServer: async () => ({
        baseUrl: "http://127.0.0.1:9999",
        async stop() {
          events.push("stopped");
        },
      }),
      createApp: () => {
        events.push("create-app");
        throw new Error("boom");
      },
    })).rejects.toThrow("boom");

    expect(events).toEqual([
      "create-app",
      "stopped",
    ]);
  });
});

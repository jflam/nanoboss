import { afterEach, describe, expect, test } from "bun:test";

import {
  buildAgentRuntimeSessionRuntime,
  setAgentRuntimeSessionRuntimeFactory,
} from "@nanoboss/agent-acp";

describe("agent runtime capability", () => {
  afterEach(() => {
    setAgentRuntimeSessionRuntimeFactory(undefined);
  });

  test("mounts the MCP-backed runtime capability path through an injected factory", () => {
    setAgentRuntimeSessionRuntimeFactory(() => ({
      mcpServers: [
        {
          type: "stdio",
          name: "nanoboss",
          command: "nanoboss",
          args: ["mcp"],
          env: [],
        },
      ],
    }));

    const runtime = buildAgentRuntimeSessionRuntime();

    expect(runtime.mcpServers).toHaveLength(1);
    expect(runtime.mcpServers[0]).toMatchObject({
      type: "stdio",
      name: "nanoboss",
    });
  });
});

import { describe, expect, test } from "bun:test";

import { buildAgentRuntimeSessionRuntime } from "../../src/agent/runtime-capability.ts";

describe("agent runtime capability", () => {
  test("mounts the MCP-backed runtime capability path", () => {
    const runtime = buildAgentRuntimeSessionRuntime();

    expect(runtime.mcpServers).toHaveLength(1);
    expect(runtime.mcpServers[0]).toMatchObject({
      type: "stdio",
      name: "nanoboss",
    });
  });
});

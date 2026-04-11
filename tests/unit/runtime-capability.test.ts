import { describe, expect, test } from "bun:test";

import { createAgentRuntimeCapabilityAdapter } from "../../src/agent/runtime-capability.ts";

describe("agent runtime capability adapter", () => {
  test("defaults to the MCP-backed runtime capability path", () => {
    const adapter = createAgentRuntimeCapabilityAdapter();
    const runtime = adapter.buildSessionRuntime();

    expect(adapter.mode).toBe("mcp");
    expect(runtime.mcpServers).toHaveLength(1);
    expect(runtime.mcpServers[0]).toMatchObject({
      type: "stdio",
      name: "nanoboss",
    });
  });
});

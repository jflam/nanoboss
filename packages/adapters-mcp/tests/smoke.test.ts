import { expect, test } from "bun:test";
import * as adaptersMcp from "@nanoboss/adapters-mcp";

test("public entrypoint exports a smoke symbol", () => {
  expect(adaptersMcp.MCP_SERVER_NAME).toBeDefined();
});

test("public entrypoint keeps JSON-RPC framing and formatter seams internal", () => {
  expect("dispatchMcpMethod" in adaptersMcp).toBe(false);
  expect("formatMcpToolResult" in adaptersMcp).toBe(false);
  expect("tryReadStdioJsonRpcMessage" in adaptersMcp).toBe(false);
  expect("registerMcpClaude" in adaptersMcp).toBe(false);
});

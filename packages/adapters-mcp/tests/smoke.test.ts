import { expect, test } from "bun:test";
import * as adaptersMcp from "@nanoboss/adapters-mcp";

test("public entrypoint exports a smoke symbol", () => {
  expect(adaptersMcp.MCP_SERVER_NAME).toBeDefined();
});

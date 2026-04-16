import { expect, test } from "bun:test";
import * as agentAcp from "@nanoboss/agent-acp";

test("public entrypoint exports a smoke symbol", () => {
  expect(agentAcp.getAgentCatalog).toBeDefined();
});

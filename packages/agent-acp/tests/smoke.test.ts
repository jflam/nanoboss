import { expect, test } from "bun:test";
import * as agentAcp from "@nanoboss/agent-acp";

test("public entrypoint exports a smoke symbol", () => {
  expect(agentAcp.getAgentCatalog).toBeDefined();
  expect("buildAgentModelSelection" in agentAcp).toBe(false);
  expect("parseAgentModelSelection" in agentAcp).toBe(false);
  expect("isReasoningEffort" in agentAcp).toBe(false);
  expect("REASONING_EFFORTS" in agentAcp).toBe(false);
  expect("REASONING_EFFORT_LABELS" in agentAcp).toBe(false);
  expect("REASONING_EFFORT_DESCRIPTIONS" in agentAcp).toBe(false);
  expect("parseClaudeDebugMetrics" in agentAcp).toBe(false);
  expect("parseCopilotLogMetrics" in agentAcp).toBe(false);
  expect("parseCopilotSessionState" in agentAcp).toBe(false);
  expect("parseDescendantPidsFromPsOutput" in agentAcp).toBe(false);
  expect("findCopilotLogsForPids" in agentAcp).toBe(false);
  expect("buildPrompt" in agentAcp).toBe(false);
  expect("parseAgentResponse" in agentAcp).toBe(false);
  expect("sanitizeJsonResponse" in agentAcp).toBe(false);
  expect("MAX_PARSE_RETRIES" in agentAcp).toBe(false);
  expect("findSelectableModelOption" in agentAcp).toBe(false);
  expect("isKnownModelSelection" in agentAcp).toBe(false);
  expect("listSelectableModelOptions" in agentAcp).toBe(false);
  expect("buildReasoningModelSelection" in agentAcp).toBe(false);
});

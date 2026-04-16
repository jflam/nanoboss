import { expect, test } from "bun:test";

import { formatAgentBanner } from "@nanoboss/procedure-sdk";

test("formatAgentBanner includes model and formatted reasoning effort", () => {
  expect(formatAgentBanner({
    provider: "copilot",
    command: "copilot",
    args: [],
    model: "gpt-5.4",
    reasoningEffort: "xhigh",
  })).toBe("copilot/gpt-5.4/x-high");
});

test("formatAgentBanner falls back to default model when missing", () => {
  expect(formatAgentBanner({
    provider: "copilot",
    command: "copilot",
    args: [],
  })).toBe("copilot/default");
});

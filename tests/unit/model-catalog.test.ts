import { expect, test } from "bun:test";

import {
  findSelectableModelOption,
  isKnownAgentProvider,
  isKnownModelSelection,
  listKnownProviders,
  listSelectableModelOptions,
  parseReasoningModelSelection,
} from "../../src/agent/model-catalog.ts";

test("lists the known downstream agents", () => {
  expect(listKnownProviders()).toEqual(["claude", "gemini", "codex", "copilot"]);
  expect(isKnownAgentProvider("copilot")).toBe(true);
  expect(isKnownAgentProvider("not-real")).toBe(false);
});

test("expands copilot reasoning variants into selectable options", () => {
  const options = listSelectableModelOptions("copilot");

  expect(options.some((option) => option.value === "gpt-5.4/low")).toBe(true);
  expect(options.some((option) => option.value === "gpt-5.4/medium")).toBe(true);
  expect(options.some((option) => option.value === "gpt-5.4/high")).toBe(true);
  expect(options.some((option) => option.value === "gpt-5.4/xhigh")).toBe(true);
  expect(options.find((option) => option.value === "gpt-5.4/medium")?.label).toContain("default");
});

test("accepts both explicit and implicit copilot reasoning selections", () => {
  expect(isKnownModelSelection("copilot", "gpt-5.4")).toBe(true);
  expect(isKnownModelSelection("copilot", "gpt-5.4/xhigh")).toBe(true);
  expect(isKnownModelSelection("copilot", "gpt-5.4-mini/xhigh")).toBe(true);
  expect(isKnownModelSelection("copilot", "claude-opus-4.6-1m/high")).toBe(true);
  expect(isKnownModelSelection("copilot", "gpt-5.4/not-real")).toBe(false);
  expect(isKnownModelSelection("copilot", "claude-opus-4.6-fast")).toBe(false);
});

test("matches the current Copilot ACP model ids", () => {
  const options = listSelectableModelOptions("copilot");

  expect(options.some((option) => option.value === "gpt-5.4-mini/xhigh")).toBe(true);
  expect(options.some((option) => option.value === "claude-opus-4.6-1m/medium")).toBe(true);
  expect(options.some((option) => option.value === "goldeneye/medium")).toBe(true);
  expect(options.some((option) => option.value === "claude-opus-4.6-fast")).toBe(false);
  expect(options.some((option) => option.value === "gpt-5.1-codex-max")).toBe(false);
});

test("keeps codex slash model ids intact", () => {
  expect(isKnownModelSelection("codex", "gpt-5.2-codex/xhigh")).toBe(true);
  expect(findSelectableModelOption("codex", "gpt-5.2-codex/xhigh")?.label).toContain("xhigh");
});

test("parses reasoning selections only when the suffix is a known effort", () => {
  expect(parseReasoningModelSelection("gpt-5.4/xhigh")).toEqual({
    baseModel: "gpt-5.4",
    reasoningEffort: "xhigh",
  });
  expect(parseReasoningModelSelection("gpt-5.2-codex/xhigh")).toEqual({
    baseModel: "gpt-5.2-codex",
    reasoningEffort: "xhigh",
  });
  expect(parseReasoningModelSelection("gemini-2.5-pro")).toEqual({
    baseModel: "gemini-2.5-pro",
  });
});

test("requires canonical gemini model ids", () => {
  expect(isKnownModelSelection("gemini", "gemini-2.5-pro")).toBe(true);
  expect(isKnownModelSelection("gemini", "pro")).toBe(false);
  expect(findSelectableModelOption("gemini", "flash")).toBeUndefined();
});

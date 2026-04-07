import { homedir } from "node:os";

import { expect, test } from "bun:test";

import { getNanobossHome } from "../../src/core/config.ts";
import { shouldSkipTypiaPreloadForEntryPoint } from "../../preload.ts";

test("bun test isolates nanoboss state from the real home directory", () => {
  expect(process.env.NANOBOSS_TEST_HOME).toBeDefined();
  expect(process.env.HOME).toBe(process.env.NANOBOSS_TEST_HOME);
  expect(process.env.HOME).not.toBe(homedir());
  expect(getNanobossHome()).toBe(`${process.env.HOME}/.nanoboss`);
});

test("typia preload skips only explicit safe subprocess entrypoints", () => {
  expect(shouldSkipTypiaPreloadForEntryPoint("build.ts", {})).toBe(true);
  expect(shouldSkipTypiaPreloadForEntryPoint("tests/fixtures/mock-agent.ts", {})).toBe(true);
  expect(shouldSkipTypiaPreloadForEntryPoint("/repo/tests/fixtures/model-aware-mock-agent.ts", {})).toBe(true);
  expect(shouldSkipTypiaPreloadForEntryPoint("nanoboss.ts", {})).toBe(false);
  expect(shouldSkipTypiaPreloadForEntryPoint("tests/unit/test-home-isolation.test.ts", {})).toBe(false);
  expect(
    shouldSkipTypiaPreloadForEntryPoint("nanoboss.ts", {
      NANOBOSS_SKIP_TYPIA_PRELOAD: "1",
    }),
  ).toBe(true);
});

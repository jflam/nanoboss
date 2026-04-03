import { homedir } from "node:os";

import { expect, test } from "bun:test";

import { getNanobossHome } from "../../src/config.ts";

test("bun test isolates nanoboss state from the real home directory", () => {
  expect(process.env.NANOBOSS_TEST_HOME).toBeDefined();
  expect(process.env.HOME).toBe(process.env.NANOBOSS_TEST_HOME);
  expect(process.env.HOME).not.toBe(homedir());
  expect(getNanobossHome()).toBe(`${process.env.HOME}/.nanoboss`);
});

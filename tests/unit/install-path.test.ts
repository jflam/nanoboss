import { describe, expect, test } from "bun:test";

import { resolveNanobossInstallDir, splitPath } from "@nanoboss/app-support";

describe("install-path", () => {
  test("prefers ~/.local/bin when it is on PATH", () => {
    expect(resolveNanobossInstallDir({
      homeDir: "/Users/tester",
      pathEnv: "/usr/bin:/Users/tester/.local/bin:/usr/local/bin",
    })).toBe("/Users/tester/.local/bin");
  });

  test("falls back to first home-owned PATH entry", () => {
    expect(resolveNanobossInstallDir({
      homeDir: "/Users/tester",
      pathEnv: "/usr/bin:/Users/tester/tools:/usr/local/bin",
    })).toBe("/Users/tester/tools");
  });

  test("respects explicit override", () => {
    expect(resolveNanobossInstallDir({
      homeDir: "/Users/tester",
      pathEnv: "/usr/bin",
      overrideDir: "~/custom/bin",
    })).toBe("/Users/tester/custom/bin");
  });

  test("expands tilde entries in PATH", () => {
    expect(splitPath("~/bin:/usr/bin", "/Users/tester")).toEqual([
      "/Users/tester/bin",
      "/usr/bin",
    ]);
  });
});

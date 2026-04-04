import { describe, expect, test } from "bun:test";

import { requireValue } from "../../src/util/argv.ts";

describe("requireValue", () => {
  test("returns the provided value", () => {
    expect(requireValue("6502", "--port")).toBe("6502");
  });

  test("throws when the value is missing", () => {
    expect(() => requireValue(undefined, "--port")).toThrow("Missing value for --port");
  });
});

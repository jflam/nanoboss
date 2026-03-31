import { describe, expect, test } from "bun:test";

import { parseCliOptions } from "../../src/cli-options.ts";

describe("parseCliOptions", () => {
  test("shows tool calls by default", () => {
    expect(parseCliOptions([])).toEqual({
      showToolCalls: true,
      showHelp: false,
    });
  });

  test("supports hiding tool calls", () => {
    expect(parseCliOptions(["--no-tool-calls"])).toEqual({
      showToolCalls: false,
      showHelp: false,
    });
  });

  test("supports explicit tool call display and help", () => {
    expect(parseCliOptions(["--tool-calls", "--help"])).toEqual({
      showToolCalls: true,
      showHelp: true,
    });
  });
});

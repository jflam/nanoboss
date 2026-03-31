import { describe, expect, test } from "bun:test";

import { parseCliOptions } from "../../src/cli-options.ts";

describe("parseCliOptions", () => {
  test("shows tool calls by default", () => {
    expect(parseCliOptions([])).toEqual({
      showToolCalls: true,
      showHelp: false,
      serverUrl: undefined,
    });
  });

  test("supports hiding tool calls", () => {
    expect(parseCliOptions(["--no-tool-calls"])).toEqual({
      showToolCalls: false,
      showHelp: false,
      serverUrl: undefined,
    });
  });

  test("supports explicit tool call display and help", () => {
    expect(parseCliOptions(["--tool-calls", "--help"])).toEqual({
      showToolCalls: true,
      showHelp: true,
      serverUrl: undefined,
    });
  });

  test("supports http server url", () => {
    expect(parseCliOptions(["--server-url", "http://localhost:3000"])).toEqual({
      showToolCalls: true,
      showHelp: false,
      serverUrl: "http://localhost:3000",
    });
  });

  test("supports inline http server url", () => {
    expect(parseCliOptions(["--server-url=http://localhost:4000"])).toEqual({
      showToolCalls: true,
      showHelp: false,
      serverUrl: "http://localhost:4000",
    });
  });
});

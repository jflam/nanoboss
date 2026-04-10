import { describe, expect, test } from "bun:test";

import { parseFrontendConnectionOptions } from "../../src/options/frontend-connection.ts";

describe("parseFrontendConnectionOptions", () => {
  test("shows tool calls by default", () => {
    expect(parseFrontendConnectionOptions([])).toEqual({
      showToolCalls: true,
      simplify2AutoApprove: false,
      showHelp: false,
      connectionMode: "private",
      serverUrl: undefined,
      remainingArgs: [],
    });
  });

  test("supports hiding tool calls", () => {
    expect(parseFrontendConnectionOptions(["--no-tool-calls"])).toEqual({
      showToolCalls: false,
      simplify2AutoApprove: false,
      showHelp: false,
      connectionMode: "private",
      serverUrl: undefined,
      remainingArgs: [],
    });
  });

  test("supports explicit tool call display and help", () => {
    expect(parseFrontendConnectionOptions(["--tool-calls", "--help"])).toEqual({
      showToolCalls: true,
      simplify2AutoApprove: false,
      showHelp: true,
      connectionMode: "private",
      serverUrl: undefined,
      remainingArgs: [],
    });
  });

  test("supports http server url", () => {
    expect(parseFrontendConnectionOptions(["--server-url", "http://localhost:3000"])).toEqual({
      showToolCalls: true,
      simplify2AutoApprove: false,
      showHelp: false,
      connectionMode: "external",
      serverUrl: "http://localhost:3000",
      remainingArgs: [],
    });
  });

  test("supports inline http server url", () => {
    expect(parseFrontendConnectionOptions(["--server-url=http://localhost:4000"])).toEqual({
      showToolCalls: true,
      simplify2AutoApprove: false,
      showHelp: false,
      connectionMode: "external",
      serverUrl: "http://localhost:4000",
      remainingArgs: [],
    });
  });

  test("supports simplify2 auto-approve mode", () => {
    expect(parseFrontendConnectionOptions(["--simplify2-auto-approve"])).toEqual({
      showToolCalls: true,
      simplify2AutoApprove: true,
      showHelp: false,
      connectionMode: "private",
      serverUrl: undefined,
      remainingArgs: [],
    });
  });
});

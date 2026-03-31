import { describe, expect, test } from "bun:test";

import { parseNanobossArgs } from "../../nanoboss.ts";

describe("parseNanobossArgs", () => {
  test("defaults to help when no command is provided", () => {
    expect(parseNanobossArgs([])).toEqual({
      command: "help",
      args: [],
    });
  });

  test("parses cli and passes remaining args through", () => {
    expect(parseNanobossArgs(["cli", "--server-url", "http://localhost:3000"])).toEqual({
      command: "cli",
      args: ["--server-url", "http://localhost:3000"],
    });
  });

  test("parses server command", () => {
    expect(parseNanobossArgs(["server", "--port", "3001"])).toEqual({
      command: "server",
      args: ["--port", "3001"],
    });
  });

  test("rejects unknown commands", () => {
    expect(() => parseNanobossArgs(["web"])).toThrow("Unknown nanoboss command: web");
  });
});

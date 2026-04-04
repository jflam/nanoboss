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

  test("parses http command", () => {
    expect(parseNanobossArgs(["http", "--port", "3001"])).toEqual({
      command: "http",
      args: ["--port", "3001"],
    });
  });

  test("parses resume command", () => {
    expect(parseNanobossArgs(["resume", "session-123"])).toEqual({
      command: "resume",
      args: ["session-123"],
    });
  });

  test("parses acp-server command", () => {
    expect(parseNanobossArgs(["acp-server"])).toEqual({
      command: "acp-server",
      args: [],
    });
  });

  test("parses session-mcp command", () => {
    expect(parseNanobossArgs(["session-mcp", "--session-id", "abc"])).toEqual({
      command: "session-mcp",
      args: ["--session-id", "abc"],
    });
  });

  test("parses procedure-dispatch-worker command", () => {
    expect(parseNanobossArgs(["procedure-dispatch-worker", "--dispatch-id", "abc"])).toEqual({
      command: "procedure-dispatch-worker",
      args: ["--dispatch-id", "abc"],
    });
  });

  test("parses doctor command", () => {
    expect(parseNanobossArgs(["doctor", "--register"])).toEqual({
      command: "doctor",
      args: ["--register"],
    });
  });

  test("parses mcp command", () => {
    expect(parseNanobossArgs(["mcp", "proxy"])).toEqual({
      command: "mcp",
      args: ["proxy"],
    });
  });

  test("rejects unknown commands", () => {
    expect(() => parseNanobossArgs(["web"])).toThrow("Unknown nanoboss command: web");
  });

  test("rejects removed alias commands", () => {
    expect(() => parseNanobossArgs(["tui"])).toThrow("Unknown nanoboss command: tui");
    expect(() => parseNanobossArgs(["server"])).toThrow("Unknown nanoboss command: server");
  });
});

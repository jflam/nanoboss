import { describe, expect, test } from "bun:test";

import {
  DEFAULT_HTTP_SERVER_PORT,
  parseHttpServerOptions,
} from "../../src/commands/http-options.ts";

describe("parseHttpServerOptions", () => {
  test("defaults to the standard nanoboss HTTP port", () => {
    expect(parseHttpServerOptions([])).toEqual({
      port: DEFAULT_HTTP_SERVER_PORT,
      host: undefined,
      mode: "shared",
      readySignal: false,
      idleTimeoutSeconds: 30,
      sseKeepAliveMs: 10000,
    });
  });

  test("uses explicit --port value", () => {
    expect(parseHttpServerOptions(["--port", "3456"])).toEqual({
      port: 3456,
      host: undefined,
      mode: "shared",
      readySignal: false,
      idleTimeoutSeconds: 30,
      sseKeepAliveMs: 10000,
    });
  });

  test("uses inline --port value", () => {
    expect(parseHttpServerOptions(["--port=4567"])).toEqual({
      port: 4567,
      host: undefined,
      mode: "shared",
      readySignal: false,
      idleTimeoutSeconds: 30,
      sseKeepAliveMs: 10000,
    });
  });

  test("parses private server launch options", () => {
    expect(parseHttpServerOptions(["--host", "127.0.0.1", "--port", "0", "--mode", "private", "--ready-signal"])).toEqual({
      port: 0,
      host: "127.0.0.1",
      mode: "private",
      readySignal: true,
      idleTimeoutSeconds: 30,
      sseKeepAliveMs: 10000,
    });
  });

  test("rejects invalid ports", () => {
    expect(() => parseHttpServerOptions(["--port", "-1"])).toThrow("Invalid port: -1");
  });
});

import { describe, expect, test } from "bun:test";

import { DEFAULT_HTTP_SERVER_PORT } from "../../src/defaults.ts";
import { parseHttpServerOptions } from "../../src/http-server.ts";

describe("parseHttpServerOptions", () => {
  test("defaults to the standard nanoboss HTTP port", () => {
    expect(parseHttpServerOptions([])).toEqual({
      port: DEFAULT_HTTP_SERVER_PORT,
      idleTimeoutSeconds: 30,
      sseKeepAliveMs: 10000,
    });
  });

  test("uses explicit --port value", () => {
    expect(parseHttpServerOptions(["--port", "3456"])).toEqual({
      port: 3456,
      idleTimeoutSeconds: 30,
      sseKeepAliveMs: 10000,
    });
  });

  test("uses inline --port value", () => {
    expect(parseHttpServerOptions(["--port=4567"])).toEqual({
      port: 4567,
      idleTimeoutSeconds: 30,
      sseKeepAliveMs: 10000,
    });
  });

  test("rejects invalid ports", () => {
    expect(() => parseHttpServerOptions(["--port", "0"])).toThrow("Invalid port: 0");
  });
});

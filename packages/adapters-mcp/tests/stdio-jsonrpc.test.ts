import { describe, expect, test } from "bun:test";

import {
  serializeStdioJsonRpcMessage,
  tryReadStdioJsonRpcMessage,
} from "../src/stdio-jsonrpc-framing.ts";

describe("stdio JSON-RPC framing", () => {
  test("reads newline-delimited JSON-RPC messages", () => {
    const parsed = tryReadStdioJsonRpcMessage(Buffer.from('{"jsonrpc":"2.0","id":1}\n'));

    expect(parsed).toEqual({
      body: '{"jsonrpc":"2.0","id":1}',
      rest: Buffer.alloc(0),
      mode: "jsonl",
    });
  });

  test("reads Content-Length framed JSON-RPC messages", () => {
    const body = '{"jsonrpc":"2.0","id":1}';
    const parsed = tryReadStdioJsonRpcMessage(
      Buffer.from(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`),
    );

    expect(parsed).toEqual({
      body,
      rest: Buffer.alloc(0),
      mode: "content-length",
    });
  });

  test("skips leading blank lines before JSONL messages", () => {
    const parsed = tryReadStdioJsonRpcMessage(Buffer.from('\r\n\n{"jsonrpc":"2.0","id":2}\n'));

    expect(parsed?.body).toBe('{"jsonrpc":"2.0","id":2}');
    expect(parsed?.mode).toBe("jsonl");
  });

  test("serializes JSON-RPC messages for both stdio modes", () => {
    expect(serializeStdioJsonRpcMessage({ jsonrpc: "2.0", id: 1 }, "jsonl")).toBe(
      '{"jsonrpc":"2.0","id":1}\n',
    );

    expect(serializeStdioJsonRpcMessage({ jsonrpc: "2.0", id: 1 }, "content-length")).toBe(
      'Content-Length: 24\r\n\r\n{"jsonrpc":"2.0","id":1}',
    );
  });
});

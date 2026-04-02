export type StdioJsonRpcMode = "jsonl" | "content-length";

interface JsonRpcMessage {
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

const HEADER_SEPARATOR = "\r\n\r\n";

export function tryReadStdioJsonRpcMessage(
  buffer: Buffer,
): { body: string; rest: Buffer; mode: StdioJsonRpcMode } | undefined {
  let working = trimLeadingLineBreaks(buffer);
  if (working.length === 0) {
    return undefined;
  }

  if (startsWithContentLengthHeader(working)) {
    const headerEnd = working.indexOf(HEADER_SEPARATOR);
    if (headerEnd < 0) {
      return undefined;
    }

    const headers = working.subarray(0, headerEnd).toString("utf8");
    const contentLength = parseContentLength(headers);
    if (contentLength === undefined) {
      throw new Error("Missing Content-Length header");
    }

    const bodyStart = headerEnd + HEADER_SEPARATOR.length;
    const bodyEnd = bodyStart + contentLength;
    if (working.length < bodyEnd) {
      return undefined;
    }

    return {
      body: working.subarray(bodyStart, bodyEnd).toString("utf8"),
      rest: working.subarray(bodyEnd),
      mode: "content-length",
    };
  }

  const lineEnd = working.indexOf("\n");
  if (lineEnd < 0) {
    return undefined;
  }

  const line = working.subarray(0, lineEnd).toString("utf8").replace(/\r$/, "");
  const rest = working.subarray(lineEnd + 1);
  if (line.length === 0) {
    return tryReadStdioJsonRpcMessage(rest);
  }

  return {
    body: line,
    rest,
    mode: "jsonl",
  };
}

export function serializeStdioJsonRpcMessage(message: unknown, mode: StdioJsonRpcMode = "jsonl"): string {
  const body = JSON.stringify(message);
  if (mode === "content-length") {
    return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
  }

  return `${body}\n`;
}

export async function runStdioJsonRpcServer(
  dispatch: (method: string, params: unknown) => unknown,
): Promise<void> {
  let buffer = Buffer.alloc(0);
  let mode: StdioJsonRpcMode = "jsonl";

  const writeJsonRpc = (message: unknown) => {
    process.stdout.write(serializeStdioJsonRpcMessage(message, mode));
  };

  const handleMessageBody = (body: string) => {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(body) as JsonRpcMessage;
    } catch {
      writeJsonRpc({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: "Parse error",
        },
      });
      return;
    }

    if (!message.method) {
      writeJsonRpc({
        jsonrpc: "2.0",
        id: message.id ?? null,
        error: {
          code: -32600,
          message: "Invalid Request",
        },
      });
      return;
    }

    if (message.method === "notifications/initialized") {
      return;
    }

    try {
      const result = dispatch(message.method, message.params);
      if (message.id === undefined) {
        return;
      }

      writeJsonRpc({
        jsonrpc: "2.0",
        id: message.id,
        result,
      });
    } catch (error) {
      if (message.id === undefined) {
        return;
      }

      writeJsonRpc({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  };

  process.stdin.on("data", (chunk: Buffer | string) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);

    for (;;) {
      const parsed = tryReadStdioJsonRpcMessage(buffer);
      if (!parsed) {
        return;
      }

      buffer = parsed.rest;
      mode = parsed.mode;
      handleMessageBody(parsed.body);
    }
  });
  process.stdin.resume();

  await new Promise<void>((resolve, reject) => {
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
    process.stdin.once("error", reject);
  });
}

function trimLeadingLineBreaks(buffer: Buffer): Buffer {
  let start = 0;
  while (start < buffer.length && (buffer[start] === 0x0a || buffer[start] === 0x0d)) {
    start += 1;
  }
  return start === 0 ? buffer : buffer.subarray(start);
}

function startsWithContentLengthHeader(buffer: Buffer): boolean {
  const prefix = buffer.subarray(0, Math.min(buffer.length, 15)).toString("utf8").toLowerCase();
  return "content-length:".startsWith(prefix) || prefix.startsWith("content-length:");
}

function parseContentLength(headers: string): number | undefined {
  const match = headers.match(/^content-length:\s*(\d+)\s*$/im);
  if (!match) {
    return undefined;
  }

  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

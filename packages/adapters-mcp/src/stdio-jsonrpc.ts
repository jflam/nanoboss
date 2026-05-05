import {
  serializeStdioJsonRpcMessage,
  tryReadStdioJsonRpcMessage,
  type StdioJsonRpcMode,
} from "./stdio-jsonrpc-framing.ts";

interface JsonRpcMessage {
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export async function runStdioJsonRpcServer(
  dispatch: (method: string, params: unknown) => Promise<unknown>,
): Promise<void> {
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let mode: StdioJsonRpcMode = "jsonl";

  const writeJsonRpc = (message: unknown) => {
    process.stdout.write(serializeStdioJsonRpcMessage(message, mode));
  };
  let queue = Promise.resolve();

  const handleMessageBody = async (body: string) => {
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
      const result = await dispatch(message.method, message.params);
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
      queue = queue
        .then(() => handleMessageBody(parsed.body))
        .catch((error: unknown) => {
          writeJsonRpc({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : String(error),
            },
          });
        });
    }
  });
  process.stdin.resume();

  await new Promise<void>((resolve, reject) => {
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
    process.stdin.once("error", reject);
  });
}

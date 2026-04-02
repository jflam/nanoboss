import {
  callSessionMcpTool,
  createSessionMcpApi,
  listSessionMcpTools,
} from "./session-mcp.ts";

interface JsonRpcMessage {
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

const HEADER_SEPARATOR = "\r\n\r\n";
const NANOBOSS_MCP_PROTOCOL_VERSION = "2025-11-25";

export async function runMcpCommand(argv: string[] = []): Promise<void> {
  const [subcommand] = argv;
  if (!subcommand || subcommand === "proxy") {
    const api = createSessionMcpApi({ cwd: process.cwd() });
    const server = new NanobossMcpProxyServer(api);
    await server.listen();
    return;
  }

  if (subcommand === "help" || subcommand === "-h" || subcommand === "--help") {
    printMcpHelp();
    return;
  }

  throw new Error(`Unknown mcp command: ${subcommand}`);
}

export function printMcpHelp(): void {
  process.stdout.write([
    "Usage: nanoboss mcp proxy",
    "",
    "Commands:",
    "  proxy              Launch the static nanoboss MCP stdio server",
    "",
  ].join("\n"));
}

class NanobossMcpProxyServer {
  private buffer = Buffer.alloc(0);

  constructor(private readonly api: ReturnType<typeof createSessionMcpApi>) {}

  async listen(): Promise<void> {
    process.stdin.on("data", (chunk: Buffer | string) => {
      this.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    process.stdin.resume();

    await new Promise<void>((resolve, reject) => {
      process.stdin.once("end", resolve);
      process.stdin.once("close", resolve);
      process.stdin.once("error", reject);
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    for (;;) {
      const body = this.tryReadMessageBody();
      if (body === undefined) {
        return;
      }

      this.handleMessageBody(body);
    }
  }

  private tryReadMessageBody(): string | undefined {
    const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR);
    if (headerEnd < 0) {
      return undefined;
    }

    const headerBlock = this.buffer.subarray(0, headerEnd).toString("utf8");
    const contentLength = parseContentLength(headerBlock);
    if (contentLength === undefined) {
      throw new Error("Missing Content-Length header");
    }

    const bodyStart = headerEnd + HEADER_SEPARATOR.length;
    const bodyEnd = bodyStart + contentLength;
    if (this.buffer.length < bodyEnd) {
      return undefined;
    }

    const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    this.buffer = this.buffer.subarray(bodyEnd);
    return body;
  }

  private handleMessageBody(body: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(body) as JsonRpcMessage;
    } catch {
      this.writeJsonRpc({
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
      this.writeJsonRpc({
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
      const result = dispatchNanobossMcpMethod(this.api, message.method, message.params);
      if (message.id === undefined) {
        return;
      }

      this.writeJsonRpc({
        jsonrpc: "2.0",
        id: message.id,
        result,
      });
    } catch (error) {
      if (message.id === undefined) {
        return;
      }

      this.writeJsonRpc({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private writeJsonRpc(message: unknown): void {
    const body = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
    process.stdout.write(header);
    process.stdout.write(body);
  }
}

function dispatchNanobossMcpMethod(
  api: ReturnType<typeof createSessionMcpApi>,
  method: string,
  params: unknown,
): unknown {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: NANOBOSS_MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "nanoboss",
          version: "0.1.0",
        },
        instructions: "Use these tools to inspect nanoboss session cells and refs, defaulting to the current session when possible.",
      };
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: listSessionMcpTools(),
      };
    case "tools/call": {
      const record = asObject(params);
      const name = asString(record.name, "name");
      const args = record.arguments === undefined ? {} : asObject(record.arguments);
      const structuredContent = callSessionMcpTool(api, name, args);
      return {
        content: [
          {
            type: "text",
            text: typeof structuredContent === "string"
              ? structuredContent
              : JSON.stringify(structuredContent, null, 2),
          },
        ],
        structuredContent,
      };
    }
    default:
      throw new Error(`Unsupported MCP method: ${method}`);
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected object");
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${name} to be a non-empty string`);
  }

  return value;
}

function parseContentLength(headers: string): number | undefined {
  const match = headers.match(/^content-length:\s*(\d+)\s*$/im);
  if (!match) {
    return undefined;
  }

  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

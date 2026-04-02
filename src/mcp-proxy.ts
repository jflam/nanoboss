import {
  callSessionMcpTool,
  createSessionMcpApi,
  listSessionMcpTools,
} from "./session-mcp.ts";
import { runStdioJsonRpcServer } from "./stdio-jsonrpc.ts";

const NANOBOSS_MCP_PROTOCOL_VERSION = "2025-11-25";

export async function runMcpCommand(argv: string[] = []): Promise<void> {
  const [subcommand] = argv;
  if (!subcommand || subcommand === "proxy") {
    const api = createSessionMcpApi({ cwd: process.cwd() });
    await runStdioJsonRpcServer((method, params) => dispatchNanobossMcpMethod(api, method, params));
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


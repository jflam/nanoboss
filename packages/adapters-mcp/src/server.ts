import { getBuildLabel } from "@nanoboss/app-support";
import type { RuntimeService } from "@nanoboss/app-runtime";

import { dispatchMcpToolsMethod, type JsonRpcToolMetadata } from "./jsonrpc.ts";
import { runStdioJsonRpcServer } from "./stdio-jsonrpc.ts";
import { MCP_TOOLS } from "./tool-definitions.ts";
import { formatMcpToolResult } from "./tool-result-format.ts";

const MCP_PROTOCOL_VERSION = "2025-11-25";
export const MCP_SERVER_NAME = "nanoboss";
export const MCP_INSTRUCTIONS = "Use these tools to dispatch nanoboss procedures and inspect durable session state. Prefer an explicit sessionId for session-scoped operations such as procedure_dispatch_start and list_runs. Use list_runs with scope='recent' only for true global recency scans. If sessionId is omitted, the current session for the server working directory may be used when available.";

export interface McpServerOptions {
  instructions?: string;
  protocolVersion?: string;
  serverName?: string;
}

export function listMcpTools(): JsonRpcToolMetadata[] {
  return MCP_TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}

export async function callMcpTool(
  runtime: RuntimeService,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  return await tool.call(runtime, tool.parseArgs(args));
}

async function dispatchMcpMethod(
  runtime: RuntimeService,
  method: string,
  params: unknown,
  options: McpServerOptions = {},
): Promise<unknown> {
  return await dispatchMcpToolsMethod({
    api: runtime,
    method,
    messageParams: params,
    protocolVersion: options.protocolVersion ?? MCP_PROTOCOL_VERSION,
    serverName: options.serverName ?? MCP_SERVER_NAME,
    serverVersion: getBuildLabel(),
    instructions: options.instructions ?? MCP_INSTRUCTIONS,
    listTools: listMcpTools,
    callTool: callMcpTool,
    formatToolResult: formatMcpToolResult,
  });
}

export async function runMcpServer(
  runtime: RuntimeService,
  options: McpServerOptions = {},
): Promise<void> {
  await runStdioJsonRpcServer((method, messageParams) => dispatchMcpMethod(runtime, method, messageParams, options));
}

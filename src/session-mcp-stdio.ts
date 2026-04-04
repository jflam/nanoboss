import type * as acp from "@agentclientprotocol/sdk";

import { resolveSelfCommand } from "./self-command.ts";
import { SESSION_MCP_SERVER_NAME, createSessionMcpApi, dispatchSessionMcpMethod } from "./session-mcp.ts";
import { runStdioJsonRpcServer } from "./stdio-jsonrpc.ts";
import { requireValue } from "./util/argv.ts";

interface SessionMcpStdioParams {
  sessionId: string;
  cwd: string;
  rootDir?: string;
}

export function buildSessionMcpStdioServer(
  params: SessionMcpStdioParams,
): acp.NewSessionRequest["mcpServers"][number] {
  const command = resolveSelfCommand("session-mcp", [
    "--session-id",
    params.sessionId,
    "--cwd",
    params.cwd,
    ...(params.rootDir ? ["--root-dir", params.rootDir] : []),
  ]);

  return {
    type: "stdio",
    name: SESSION_MCP_SERVER_NAME,
    command: command.command,
    args: command.args,
    env: [],
  };
}

export async function runSessionMcpStdioCommand(argv: string[]): Promise<void> {
  const params = parseSessionMcpCommandArgs(argv);
  const api = createSessionMcpApi(params);
  await runStdioJsonRpcServer((method, messageParams) => dispatchSessionMcpMethod(api, method, messageParams));
}

function parseSessionMcpCommandArgs(argv: string[]): SessionMcpStdioParams {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let rootDir: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case "--session-id":
        sessionId = requireValue(next, "--session-id");
        index += 1;
        break;
      case "--cwd":
        cwd = requireValue(next, "--cwd");
        index += 1;
        break;
      case "--root-dir":
        rootDir = requireValue(next, "--root-dir");
        index += 1;
        break;
      default:
        throw new Error(`Unknown session-mcp arg: ${arg}`);
    }
  }

  if (!sessionId) {
    throw new Error("Missing required arg: --session-id");
  }

  if (!cwd) {
    throw new Error("Missing required arg: --cwd");
  }

  return { sessionId, cwd, rootDir };
}

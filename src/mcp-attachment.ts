import type * as acp from "@agentclientprotocol/sdk";

import { ensureSessionMcpHttpServer, disposeSessionMcpHttpServer } from "./session-mcp-http.ts";
import { resolveSelfCommand } from "./self-command.ts";
import type { DownstreamAgentConfig } from "./types.ts";

interface SessionMcpAttachmentParams {
  config: DownstreamAgentConfig;
  sessionId: string;
  cwd: string;
  rootDir?: string;
}

export function buildSessionMcpServers(
  params: SessionMcpAttachmentParams,
): acp.NewSessionRequest["mcpServers"] {
  switch (params.config.provider) {
    case "claude":
    case "codex":
    case "gemini":
      return [ensureSessionMcpHttpServer(params)];
    case "copilot":
    default:
      return [buildStdioSessionMcpServer(params)];
  }
}

export function disposeSessionMcpTransport(sessionId: string): void {
  disposeSessionMcpHttpServer(sessionId);
}

function buildStdioSessionMcpServer(
  params: SessionMcpAttachmentParams,
): acp.NewSessionRequest["mcpServers"][number] {
  const self = resolveSelfCommand("session-mcp-server");

  return {
    type: "stdio",
    name: "nanoboss-session",
    command: self.command,
    args: self.args,
    env: [
      { name: "NANOBOSS_SESSION_ID", value: params.sessionId },
      { name: "NANOBOSS_SESSION_CWD", value: params.cwd },
      ...(params.rootDir
        ? [{ name: "NANOBOSS_SESSION_ROOT_DIR", value: params.rootDir }]
        : []),
      { name: "NANOBOSS_MCP_READ_ONLY", value: "1" },
    ],
  };
}

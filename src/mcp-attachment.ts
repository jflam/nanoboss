import type * as acp from "@agentclientprotocol/sdk";

import { ensureSessionMcpHttpServer, disposeSessionMcpHttpServer } from "./session-mcp-http.ts";
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
  return [ensureSessionMcpHttpServer(params)];
}

export function disposeSessionMcpTransport(sessionId: string): void {
  disposeSessionMcpHttpServer(sessionId);
}

import type * as acp from "@agentclientprotocol/sdk";

import { buildGlobalMcpStdioServer } from "../mcp/registration.ts";

export function buildAgentRuntimeSessionRuntime(): Pick<acp.NewSessionRequest, "mcpServers"> {
  return {
    mcpServers: [buildGlobalMcpStdioServer()],
  };
}

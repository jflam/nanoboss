import type * as acp from "@agentclientprotocol/sdk";

import { buildGlobalMcpStdioServer } from "@nanoboss/adapters-mcp";

export function buildAgentRuntimeSessionRuntime(): Pick<acp.NewSessionRequest, "mcpServers"> {
  return {
    mcpServers: [buildGlobalMcpStdioServer()],
  };
}

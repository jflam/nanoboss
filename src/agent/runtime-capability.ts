import type * as acp from "@agentclientprotocol/sdk";

import { buildGlobalMcpStdioServer } from "../mcp/registration.ts";

export type AgentRuntimeCapabilityMode = "mcp";

export interface AgentRuntimeCapabilityAdapter {
  readonly mode: AgentRuntimeCapabilityMode;
  buildSessionRuntime(): Pick<acp.NewSessionRequest, "mcpServers">;
}

class McpAgentRuntimeCapabilityAdapter implements AgentRuntimeCapabilityAdapter {
  readonly mode = "mcp" as const;

  buildSessionRuntime(): Pick<acp.NewSessionRequest, "mcpServers"> {
    return {
      mcpServers: [buildGlobalMcpStdioServer()],
    };
  }
}

export function createAgentRuntimeCapabilityAdapter(
  mode: AgentRuntimeCapabilityMode = "mcp",
): AgentRuntimeCapabilityAdapter {
  if (mode === "mcp") {
    return new McpAgentRuntimeCapabilityAdapter();
  }

  return new McpAgentRuntimeCapabilityAdapter();
}

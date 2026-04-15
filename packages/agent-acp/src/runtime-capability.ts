import type * as acp from "@agentclientprotocol/sdk";

export interface AgentRuntimeSessionRuntime {
  mcpServers: NonNullable<acp.NewSessionRequest["mcpServers"]>;
}

export type AgentRuntimeSessionRuntimeFactory = () => AgentRuntimeSessionRuntime;

let runtimeFactory: AgentRuntimeSessionRuntimeFactory | undefined;

export function setAgentRuntimeSessionRuntimeFactory(
  factory: AgentRuntimeSessionRuntimeFactory | undefined,
): void {
  runtimeFactory = factory;
}

export function buildAgentRuntimeSessionRuntime(): AgentRuntimeSessionRuntime {
  return runtimeFactory?.() ?? { mcpServers: [] };
}

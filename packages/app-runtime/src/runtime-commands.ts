import type * as acp from "@agentclientprotocol/sdk";
import { ProcedureRegistry } from "@nanoboss/procedure-catalog";

import { buildAvailableCommands } from "./continuations.ts";
import { toRuntimeCommands } from "./runtime-events.ts";
import type { SessionState } from "./session-runtime.ts";

export function mapRuntimeCommands(
  registryOrCommands: ProcedureRegistry | acp.AvailableCommand[],
): SessionState["commands"] {
  const availableCommands = Array.isArray(registryOrCommands)
    ? registryOrCommands
    : buildAvailableCommands(registryOrCommands);
  return toRuntimeCommands(availableCommands);
}

export function publishSessionCommands(sessionId: string, session: SessionState): void {
  session.events.publish(sessionId, {
    type: "commands_updated",
    commands: session.commands,
  });
}

export function refreshSessionCommands(params: {
  sessionId: string;
  session: SessionState;
  registry: ProcedureRegistry;
}): acp.AvailableCommand[] {
  const availableCommands = buildAvailableCommands(params.registry);
  params.session.commands = mapRuntimeCommands(availableCommands);
  publishSessionCommands(params.sessionId, params.session);
  return availableCommands;
}

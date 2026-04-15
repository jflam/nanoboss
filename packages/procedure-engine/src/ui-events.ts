import type * as acp from "@agentclientprotocol/sdk";

import type { ProcedureUiEvent } from "./context/shared.ts";

export function toProcedureUiSessionUpdate(event: ProcedureUiEvent): acp.SessionUpdate {
  return {
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "text",
      text: `[[nanoboss-ui]] ${JSON.stringify(event)}\n`,
    },
  };
}

export function formatProcedureStatusText(event: Extract<ProcedureUiEvent, { type: "status" }>): string {
  const parts = [`[status] /${event.procedure}`];

  if (event.phase) {
    parts.push(event.phase);
  }

  if (event.iteration) {
    parts.push(event.iteration);
  }

  parts.push(`- ${event.message}`);

  const flags = [
    event.autoApprove ? "auto-approve" : undefined,
    event.waiting ? "waiting" : undefined,
  ].filter(Boolean);

  if (flags.length > 0) {
    parts.push(`(${flags.join(", ")})`);
  }

  return parts.join(" ");
}

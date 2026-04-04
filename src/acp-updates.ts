import type * as acp from "@agentclientprotocol/sdk";

import { summarizeText } from "./util/text.ts";

export function collectTextSessionUpdates(updates: acp.SessionUpdate[]): string | undefined {
  let text = "";

  for (const update of updates) {
    if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
      continue;
    }

    text += update.content.text;
  }

  return text || undefined;
}

export function summarizeAgentOutput(data: unknown, raw: string): string | undefined {
  if (typeof data === "string") {
    return summarizeText(data);
  }

  return summarizeText(raw);
}

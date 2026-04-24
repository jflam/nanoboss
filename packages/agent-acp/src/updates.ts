import type * as acp from "@agentclientprotocol/sdk";

import { summarizeText } from "@nanoboss/procedure-sdk";
import { parseProcedureUiMarker } from "./ui-marker.ts";

interface AssistantNotice {
  text: string;
  tone: "info" | "warning" | "error";
}

export function parseAssistantNoticeText(text: string): AssistantNotice | undefined {
  const normalized = text.trim();
  if (normalized.length === 0 || normalized.includes("\n")) {
    return undefined;
  }

  const match = /^(Info|Warning|Error):\s+(.+)$/.exec(normalized);
  if (!match) {
    return undefined;
  }

  return {
    tone: match[1]?.toLowerCase() as AssistantNotice["tone"],
    text: match[2] ?? "",
  };
}

export function collectTextSessionUpdates(updates: acp.SessionUpdate[]): string | undefined {
  let text = "";

  for (const update of updates) {
    if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
      continue;
    }

    if (parseAssistantNoticeText(update.content.text) || parseProcedureUiMarker(update.content.text)) {
      continue;
    }

    text += update.content.text;
  }

  return text || undefined;
}

export function collectFinalTextSessionOutput(updates: acp.SessionUpdate[]): string | undefined {
  let text = "";

  for (const update of updates) {
    if (update.sessionUpdate === "tool_call") {
      text = "";
      continue;
    }

    if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
      continue;
    }

    if (parseAssistantNoticeText(update.content.text) || parseProcedureUiMarker(update.content.text)) {
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

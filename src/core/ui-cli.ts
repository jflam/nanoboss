import type * as acp from "@agentclientprotocol/sdk";

import { createTaggedJsonLineStream, type TaggedJsonLineStream, type TaggedJsonLineStreamOptions } from "../procedure/tagged-json-line-stream.ts";
import type { ProcedureUiEvent } from "./context-shared.ts";

export const PROCEDURE_UI_MARKER_PREFIX = "[[nanoboss-ui]] ";

export function renderProcedureUiMarker(event: ProcedureUiEvent): string {
  return `${PROCEDURE_UI_MARKER_PREFIX}${JSON.stringify(event)}\n`;
}

export function parseProcedureUiMarker(text: string): ProcedureUiEvent | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith(PROCEDURE_UI_MARKER_PREFIX)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed.slice(PROCEDURE_UI_MARKER_PREFIX.length));
    return isProcedureUiEvent(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function toProcedureUiSessionUpdate(event: ProcedureUiEvent): acp.SessionUpdate {
  return {
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "text",
      text: renderProcedureUiMarker(event),
    },
  };
}

export function createProcedureUiMarkerStream(
  options: Omit<TaggedJsonLineStreamOptions<ProcedureUiEvent>, "markerPrefix">,
): TaggedJsonLineStream<ProcedureUiEvent> {
  return createTaggedJsonLineStream<ProcedureUiEvent>({
    ...options,
    markerPrefix: PROCEDURE_UI_MARKER_PREFIX,
    parseMarker: (payload) => {
      try {
        const parsed = JSON.parse(payload);
        return isProcedureUiEvent(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    },
  });
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

function isProcedureUiEvent(value: unknown): value is ProcedureUiEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.procedure !== "string" || typeof record.type !== "string") {
    return false;
  }

  switch (record.type) {
    case "status":
      return typeof record.message === "string"
        && optionalString(record.phase)
        && optionalString(record.iteration)
        && optionalBoolean(record.autoApprove)
        && optionalBoolean(record.waiting);
    case "card":
      return typeof record.kind === "string"
        && typeof record.title === "string"
        && typeof record.markdown === "string";
    default:
      return false;
  }
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

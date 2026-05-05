import type { SessionMetadata } from "@nanoboss/contracts";
import { summarizeText } from "@nanoboss/procedure-sdk";

export function formatSessionLine(session: SessionMetadata, cwd: string): string {
  const markers: string[] = [];
  if (session.cwd === cwd) {
    markers.push("here");
  }
  if (session.defaultAgentSessionId) {
    markers.push("native");
  }

  const prefix = markers.length > 0 ? `[${markers.join(",")}] ` : "";
  const timestamp = formatTimestamp(session.updatedAt);
  const prompt = summarizeText(session.initialPrompt ?? "(no turns yet)", 96);
  return `${prefix}${timestamp} ${session.session.sessionId.slice(0, 8)} ${prompt}`;
}

export function formatSessionDetailLine(session: SessionMetadata): string {
  const parts = [session.cwd || "cwd unknown"];
  if (session.defaultAgentSelection) {
    parts.push(
      session.defaultAgentSelection.model
        ? `${session.defaultAgentSelection.provider}:${session.defaultAgentSelection.model}`
        : session.defaultAgentSelection.provider,
    );
  }
  return parts.join(" • ");
}

export function formatSessionInitialPrompt(session: SessionMetadata): string {
  return session.initialPrompt?.trim().length
    ? session.initialPrompt.trim()
    : "(no turns yet)";
}

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

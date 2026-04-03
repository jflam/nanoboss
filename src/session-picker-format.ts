import type { StoredSessionSummary } from "./stored-sessions.ts";

export function formatSessionLine(session: StoredSessionSummary, cwd: string): string {
  const markers: string[] = [];
  if (session.cwd === cwd) {
    markers.push("here");
  }
  if (session.hasNativeResume) {
    markers.push("native");
  }

  const prefix = markers.length > 0 ? `[${markers.join(",")}] ` : "";
  const timestamp = formatTimestamp(session.updatedAt);
  const prompt = summarize(session.initialPrompt ?? "(no turns yet)", 96);
  return `${prefix}${timestamp} ${session.sessionId.slice(0, 8)} ${prompt}`;
}

export function formatSessionDetailLine(session: StoredSessionSummary): string {
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

export function formatTimestamp(value: string): string {
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

export function summarize(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, Math.max(0, maxLength - 3))}...`;
}

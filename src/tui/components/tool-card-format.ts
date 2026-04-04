import type { UiToolCall } from "../state.ts";

export interface FormattedToolCardSection {
  label: string;
  value: string;
}

export interface FormattedToolCard {
  title: string;
  metaLine: string;
  sections: FormattedToolCardSection[];
}

export function formatToolCard(toolCall: UiToolCall): FormattedToolCard {
  const sections: FormattedToolCardSection[] = [];
  const inputLabel = getInputLabel(toolCall);
  const outputLabel = getOutputLabel(toolCall);

  if (toolCall.inputSummary) {
    sections.push({ label: inputLabel, value: toolCall.inputSummary });
  }

  if (toolCall.outputSummary) {
    sections.push({ label: outputLabel, value: toolCall.outputSummary });
  }

  if (toolCall.errorSummary) {
    sections.push({ label: "error", value: toolCall.errorSummary });
  }

  return {
    title: toolCall.title,
    metaLine: formatMetaLine(toolCall),
    sections,
  };
}

function formatMetaLine(toolCall: UiToolCall): string {
  const parts = [formatStatus(toolCall.status)];
  if (toolCall.durationMs !== undefined) {
    parts.push(`${formatDuration(toolCall.durationMs)}`);
  }
  return parts.join(" • ");
}

function formatStatus(status: string): string {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
    case "in_progress":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return status;
  }
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1_000).toFixed(durationMs >= 10_000 ? 0 : 1)}s`;
}

function getInputLabel(toolCall: UiToolCall): string {
  const name = normalizeToolName(toolCall);
  switch (name) {
    case "bash":
      return "command";
    case "read":
    case "write":
    case "edit":
    case "ls":
      return "path";
    case "grep":
    case "find":
      return "query";
    default:
      return "input";
  }
}

function getOutputLabel(toolCall: UiToolCall): string {
  const name = normalizeToolName(toolCall);
  switch (name) {
    case "bash":
      return "output";
    case "read":
      return "contents";
    default:
      return "result";
  }
}

function normalizeToolName(toolCall: UiToolCall): string | undefined {
  if (toolCall.kind && toolCall.kind !== "other" && toolCall.kind !== "thought" && toolCall.kind !== "wrapper") {
    return toolCall.kind;
  }

  const title = toolCall.title.toLowerCase();
  if (title.startsWith("mock ")) {
    const parts = title.split(/\s+/);
    return parts[1];
  }

  return title.split(/[\s:(\[]/, 1)[0] || undefined;
}

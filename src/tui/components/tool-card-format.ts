import type { ToolPreviewBlock } from "../../core/tool-call-preview.ts";
import type { UiToolCall } from "../state.ts";
import type { NanobossTuiTheme } from "../theme.ts";

const DEFAULT_COLLAPSED_LINES = 6;

export interface RenderedToolCard {
  lines: string[];
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1_000).toFixed(durationMs >= 10_000 ? 0 : 1)}s`;
}

export function formatToolDurationLine(theme: NanobossTuiTheme, toolCall: UiToolCall): string | undefined {
  if (toolCall.durationMs === undefined) {
    return undefined;
  }

  return theme.toolCardMeta(`Took ${formatDuration(toolCall.durationMs)}`);
}

export function normalizeToolName(toolCall: Pick<UiToolCall, "kind" | "title">): string | undefined {
  if (toolCall.kind && toolCall.kind !== "other" && toolCall.kind !== "thought" && toolCall.kind !== "wrapper") {
    return toolCall.kind;
  }

  const title = toolCall.title.toLowerCase();
  if (title.startsWith("mock ")) {
    const parts = title.split(/\s+/);
    return parts[1];
  }

  if (title.startsWith("callagent") || title.startsWith("defaultsession:") || title.startsWith("calling ")) {
    return "agent";
  }

  const firstToken = title.split(/[\s:(\[]/, 1)[0] || "";
  const lastSegment = firstToken.split(".").at(-1);
  return lastSegment || firstToken || undefined;
}

export function formatToolHeader(theme: NanobossTuiTheme, header: string | undefined, fallbackTitle: string): string {
  const text = stripWrappingBackticks((header?.trim() || fallbackTitle).trim());

  if (text.startsWith("$ ")) {
    return `${theme.toolCardTitle("$")} ${theme.toolCardBody(text.slice(2))}`;
  }

  const match = text.match(/^(read|write|edit|grep|find|ls)(?:\s+(.*))?$/i);
  if (!match) {
    return theme.toolCardTitle(text);
  }

  const [, command, rest] = match;
  const commandText = theme.toolCardTitle(command);
  if (!rest) {
    return commandText;
  }

  if (command.toLowerCase() === "read") {
    const rangeMatch = rest.match(/^(.*?)(:\d+(?:-\d+)?)$/);
    if (rangeMatch) {
      return `${commandText} ${theme.accent(rangeMatch[1])}${theme.warning(rangeMatch[2])}`;
    }
  }

  return `${commandText} ${theme.accent(stripWrappingBackticks(rest))}`;
}

function stripWrappingBackticks(text: string): string {
  return text.replace(/^`+|`+$/g, "");
}

export function formatPreviewBody(
  theme: NanobossTuiTheme,
  block: ToolPreviewBlock | undefined,
  expanded: boolean,
  options: {
    collapsedLines?: number;
    lineFormatter?: (theme: NanobossTuiTheme, line: string) => string;
  } = {},
): string[] {
  if (!block?.bodyLines?.length) {
    return [];
  }

  const collapsedLines = options.collapsedLines ?? DEFAULT_COLLAPSED_LINES;
  const formatter = options.lineFormatter ?? ((currentTheme: NanobossTuiTheme, line: string) => currentTheme.toolCardBody(line));
  const visibleLines = expanded ? block.bodyLines : block.bodyLines.slice(0, collapsedLines);
  const lines = visibleLines.map((line) => formatter(theme, line));

  if (block.truncated && !expanded && block.bodyLines.length > visibleLines.length) {
    lines.push(theme.toolCardMeta(`... (${block.bodyLines.length - visibleLines.length} more lines, ctrl+o to expand)`));
  }

  return lines;
}

export function formatWarnings(theme: NanobossTuiTheme, block: ToolPreviewBlock | undefined): string[] {
  return (block?.warnings ?? []).map((warning) => theme.warning(warning.startsWith("[") ? warning : `[${warning}]`));
}

export function formatErrorLines(
  theme: NanobossTuiTheme,
  block: ToolPreviewBlock | undefined,
  expanded: boolean,
  collapsedLines = DEFAULT_COLLAPSED_LINES,
): string[] {
  return formatPreviewBody(theme, block, expanded, {
    collapsedLines,
    lineFormatter: (currentTheme, line) => currentTheme.error(line),
  });
}

export function joinToolContent(...groups: Array<string[] | string | undefined>): string[] {
  const lines: string[] = [];

  for (const group of groups) {
    const normalized = typeof group === "string"
      ? [group]
      : Array.isArray(group)
        ? group.filter((line) => line.length > 0)
        : [];
    if (normalized.length === 0) {
      continue;
    }

    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(...normalized);
  }

  return lines;
}

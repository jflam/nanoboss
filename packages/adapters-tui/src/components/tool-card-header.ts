import type { UiToolCall } from "../state/state.ts";
import type { NanobossTuiTheme } from "../theme/theme.ts";

function formatDuration(durationMs: number): string {
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

export function getCanonicalToolName(toolCall: Pick<UiToolCall, "toolName">): string | undefined {
  return toolCall.toolName?.trim().toLowerCase() || undefined;
}

export function formatToolHeader(theme: NanobossTuiTheme, header: string | undefined, defaultTitle: string): string {
  const text = stripWrappingBackticks((header?.trim() || defaultTitle).trim());

  if (text.startsWith("$ ")) {
    return `${theme.toolCardTitle("$")} ${theme.toolCardBody(text.slice(2))}`;
  }

  const match = text.match(/^(read|write|edit|grep|find|ls)(?:\s+(.*))?$/i);
  if (!match) {
    return theme.toolCardTitle(text);
  }

  const command = match[1];
  const rest = match[2];
  if (!command) {
    return theme.toolCardTitle(text);
  }
  const commandText = theme.toolCardTitle(command);
  if (!rest) {
    return commandText;
  }

  if (command.toLowerCase() === "read") {
    const rangeMatch = rest.match(/^(.*?)(:\d+(?:-\d+)?)$/);
    if (rangeMatch && rangeMatch[1] && rangeMatch[2]) {
      return `${commandText} ${theme.toolCardAccent(rangeMatch[1])}${theme.toolCardWarning(rangeMatch[2])}`;
    }
  }

  return `${commandText} ${theme.toolCardAccent(stripWrappingBackticks(rest))}`;
}

function stripWrappingBackticks(text: string): string {
  return text.replace(/^`+|`+$/g, "");
}

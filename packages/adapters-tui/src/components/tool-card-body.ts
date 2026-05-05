import type { NanobossTuiTheme } from "../theme/theme.ts";
import type { ToolPreviewBlock } from "../shared/tool-preview.ts";
import {
  formatDiffLine,
  looksLikeDiffBlock,
} from "./tool-card-diff.ts";

export const DEFAULT_COLLAPSED_LINES = 6;

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
  const formatter = options.lineFormatter
    ?? (looksLikeDiffBlock(block.bodyLines)
      ? formatDiffLine
      : ((currentTheme: NanobossTuiTheme, line: string) => currentTheme.toolCardBody(line)));
  const visibleLines = expanded ? block.bodyLines : block.bodyLines.slice(0, collapsedLines);
  const lines = visibleLines.map((line) => formatter(theme, line));

  if (block.truncated && !expanded && block.bodyLines.length > visibleLines.length) {
    lines.push(theme.toolCardMeta(`... (${block.bodyLines.length - visibleLines.length} more lines, ctrl+o to expand)`));
  }

  return lines;
}

export function formatWarnings(theme: NanobossTuiTheme, block: ToolPreviewBlock | undefined): string[] {
  return (block?.warnings ?? []).map((warning) =>
    theme.toolCardWarning(warning.startsWith("[") ? warning : `[${warning}]`),
  );
}

export function formatErrorLines(
  theme: NanobossTuiTheme,
  block: ToolPreviewBlock | undefined,
  expanded: boolean,
  collapsedLines = DEFAULT_COLLAPSED_LINES,
): string[] {
  return formatPreviewBody(theme, block, expanded, {
    collapsedLines,
    lineFormatter: (currentTheme, line) => currentTheme.toolCardError(line),
  });
}

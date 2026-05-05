import type { UiToolCall } from "../state/state.ts";
import type { NanobossTuiTheme } from "../theme/theme.ts";
import type { ToolPreviewBlock } from "../shared/tool-preview.ts";
import { DEFAULT_COLLAPSED_LINES, formatPreviewBody } from "./tool-card-body.ts";
import { formatDiffLine, looksLikeDiffBlock } from "./tool-card-diff.ts";
import { getToolCodeContext } from "./tool-card-code-context.ts";

export function formatCodePreviewBody(
  theme: NanobossTuiTheme,
  toolCall: UiToolCall,
  block: ToolPreviewBlock | undefined,
  expanded: boolean,
  options: {
    collapsedLines?: number;
  } = {},
): string[] {
  if (!block?.bodyLines?.length) {
    return [];
  }

  const collapsedLines = options.collapsedLines ?? DEFAULT_COLLAPSED_LINES;
  if (looksLikeDiffBlock(block.bodyLines)) {
    return formatPreviewBody(theme, block, expanded, {
      collapsedLines,
      lineFormatter: formatDiffLine,
    });
  }

  const { shouldHighlight, language } = getToolCodeContext(toolCall);
  if (!shouldHighlight) {
    return formatPreviewBody(theme, block, expanded, options);
  }

  const renderedLines = theme.highlightCode(block.bodyLines.join("\n"), language);
  const visibleLines = expanded ? renderedLines : renderedLines.slice(0, collapsedLines);
  const lines = [...visibleLines];

  if (block.truncated && !expanded && renderedLines.length > visibleLines.length) {
    lines.push(theme.toolCardMeta(`... (${renderedLines.length - visibleLines.length} more lines, ctrl+o to expand)`));
  }

  return lines;
}

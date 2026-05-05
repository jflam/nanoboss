import type { UiToolCall } from "../state.ts";
import type { NanobossTuiTheme } from "../theme.ts";
import type { ToolPreviewBlock } from "../tool-preview.ts";
import { getToolCodeContext } from "./tool-card-code-context.ts";
import {
  formatExpandedToolHeader,
  getExpandedToolErrorBlock,
  getExpandedToolResultBlock,
} from "./tool-card-expanded.ts";
import {
  formatDiffLine,
  looksLikeDiffBlock,
} from "./tool-card-diff.ts";
import {
  formatToolDurationLine,
  formatToolHeader,
} from "./tool-card-header.ts";

export {
  formatExpandedToolHeader,
  getExpandedToolErrorBlock,
  getExpandedToolInputBlock,
  getExpandedToolResultBlock,
} from "./tool-card-expanded.ts";
export {
  formatDiffLine,
} from "./tool-card-diff.ts";
export {
  formatToolDurationLine,
  formatToolHeader,
  getCanonicalToolName,
} from "./tool-card-header.ts";

const DEFAULT_COLLAPSED_LINES = 6;

export interface RenderedToolCard {
  lines: string[];
}

export function renderPreviewToolCard(
  theme: NanobossTuiTheme,
  toolCall: UiToolCall,
  expanded: boolean,
  options: {
    collapsedLines: number;
  },
): RenderedToolCard {
  const { collapsedLines } = options;

  return {
    lines: joinToolContent(
      formatToolHeader(theme, expanded ? formatExpandedToolHeader(toolCall) : toolCall.callPreview?.header, toolCall.title),
      formatPreviewBody(
        theme,
        expanded ? getExpandedToolResultBlock(toolCall) ?? toolCall.resultPreview : toolCall.resultPreview,
        expanded,
        { collapsedLines },
      ),
      formatErrorLines(
        theme,
        expanded ? getExpandedToolErrorBlock(toolCall) ?? toolCall.errorPreview : toolCall.errorPreview,
        expanded,
        collapsedLines,
      ),
      formatWarnings(theme, toolCall.resultPreview),
      formatWarnings(theme, toolCall.errorPreview),
      formatToolDurationLine(theme, toolCall),
    ),
  };
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

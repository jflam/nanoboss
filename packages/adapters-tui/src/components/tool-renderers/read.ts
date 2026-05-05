import type { UiToolCall } from "../../state/state.ts";
import type { NanobossTuiTheme } from "../../theme/theme.ts";
import { formatCodePreviewBody } from "../tool-card-code-preview.ts";
import {
  formatErrorLines,
  formatExpandedToolHeader,
  formatToolDurationLine,
  formatToolHeader,
  formatWarnings,
  getExpandedToolErrorBlock,
  getExpandedToolResultBlock,
  joinToolContent,
  type RenderedToolCard,
} from "../tool-card-format.ts";

export function renderReadToolCard(theme: NanobossTuiTheme, toolCall: UiToolCall, expanded: boolean): RenderedToolCard {
  return {
    lines: joinToolContent(
      formatToolHeader(theme, expanded ? formatExpandedToolHeader(toolCall) : toolCall.callPreview?.header, toolCall.title),
      formatCodePreviewBody(
        theme,
        toolCall,
        expanded ? getExpandedToolResultBlock(toolCall) ?? toolCall.resultPreview : toolCall.resultPreview,
        expanded,
        { collapsedLines: 10 },
      ),
      formatErrorLines(theme, expanded ? getExpandedToolErrorBlock(toolCall) ?? toolCall.errorPreview : toolCall.errorPreview, expanded, 10),
      formatWarnings(theme, toolCall.resultPreview),
      formatWarnings(theme, toolCall.errorPreview),
      formatWarnings(theme, toolCall.callPreview),
      formatToolDurationLine(theme, toolCall),
    ),
  };
}

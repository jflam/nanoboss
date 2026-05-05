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
  getExpandedToolInputBlock,
  getExpandedToolResultBlock,
  joinToolContent,
  type RenderedToolCard,
} from "../tool-card-format.ts";

export function renderDefaultToolCard(theme: NanobossTuiTheme, toolCall: UiToolCall, expanded: boolean): RenderedToolCard {
  const header = expanded ? formatExpandedToolHeader(toolCall) ?? toolCall.callPreview?.header : toolCall.callPreview?.header;
  const isProcedureCallMarker = (header ?? toolCall.title).startsWith("Calling ");

  return {
    lines: joinToolContent(
      formatToolHeader(theme, header, toolCall.title),
      isProcedureCallMarker
        ? undefined
        : formatCodePreviewBody(theme, toolCall, expanded
          ? getExpandedToolInputBlock(toolCall) ?? {
              ...toolCall.callPreview,
              header: undefined,
            }
          : {
              ...toolCall.callPreview,
              header: undefined,
            }, expanded),
      isProcedureCallMarker
        ? undefined
        : formatCodePreviewBody(
          theme,
          toolCall,
          expanded ? getExpandedToolResultBlock(toolCall) ?? toolCall.resultPreview : toolCall.resultPreview,
          expanded,
        ),
      formatErrorLines(theme, expanded ? getExpandedToolErrorBlock(toolCall) ?? toolCall.errorPreview : toolCall.errorPreview, expanded),
      formatWarnings(theme, toolCall.callPreview),
      isProcedureCallMarker ? undefined : formatWarnings(theme, toolCall.resultPreview),
      formatWarnings(theme, toolCall.errorPreview),
      formatToolDurationLine(theme, toolCall),
    ),
  };
}

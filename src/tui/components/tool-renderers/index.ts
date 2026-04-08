import type { UiToolCall } from "../../state.ts";
import type { NanobossTuiTheme } from "../../theme.ts";
import type { RenderedToolCard } from "../tool-card-format.ts";
import { normalizeToolName, renderPreviewToolCard } from "../tool-card-format.ts";
import { renderEditToolCard } from "./edit.ts";
import { renderFallbackToolCard } from "./fallback.ts";
import { renderReadToolCard } from "./read.ts";
import { renderWriteToolCard } from "./write.ts";

export function renderToolCard(theme: NanobossTuiTheme, toolCall: UiToolCall, expanded: boolean): RenderedToolCard {
  switch (normalizeToolName(toolCall)) {
    case "bash":
      return renderPreviewToolCard(theme, toolCall, expanded, { collapsedLines: 5 });
    case "read":
      return renderReadToolCard(theme, toolCall, expanded);
    case "edit":
      return renderEditToolCard(theme, toolCall, expanded);
    case "write":
      return renderWriteToolCard(theme, toolCall, expanded);
    case "grep":
    case "find":
    case "ls":
      return renderPreviewToolCard(theme, toolCall, expanded, { collapsedLines: 10 });
    default:
      return renderFallbackToolCard(theme, toolCall, expanded);
  }
}

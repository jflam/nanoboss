import type { UiToolCall } from "../../state/state.ts";
import type { NanobossTuiTheme } from "../../theme/theme.ts";
import type { RenderedToolCard } from "../tool-card-format.ts";
import { getCanonicalToolName, renderPreviewToolCard } from "../tool-card-format.ts";
import { renderDefaultToolCard } from "./default.ts";
import { renderEditToolCard } from "./edit.ts";
import { renderReadToolCard } from "./read.ts";
import { renderWriteToolCard } from "./write.ts";

export function renderToolCard(theme: NanobossTuiTheme, toolCall: UiToolCall, expanded: boolean): RenderedToolCard {
  switch (getCanonicalToolName(toolCall)) {
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
      return renderDefaultToolCard(theme, toolCall, expanded);
  }
}

import {
  asRecord,
  extractPathLike,
  firstString,
} from "@nanoboss/procedure-sdk";

import type { UiToolCall } from "../state/state.ts";
import { getLanguageFromPath } from "../theme/theme.ts";

export function getToolCodeContext(toolCall: UiToolCall): { shouldHighlight: boolean; language?: string } {
  const toolName = toolCall.toolName?.trim().toLowerCase() || undefined;
  const inputRecord = asRecord(toolCall.rawInput);
  const outputRecord = asRecord(toolCall.rawOutput);
  const explicitLanguage = firstString(
    inputRecord?.language,
    inputRecord?.lang,
    outputRecord?.language,
    outputRecord?.lang,
  );
  const path = firstString(extractPathLike(inputRecord), extractPathLike(outputRecord));
  const inferredLanguage = path ? getLanguageFromPath(path) : undefined;

  return {
    shouldHighlight: toolName === "read" || toolName === "write" || explicitLanguage !== undefined || inferredLanguage !== undefined,
    language: explicitLanguage ?? inferredLanguage,
  };
}

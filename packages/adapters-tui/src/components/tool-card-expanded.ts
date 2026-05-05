import {
  asRecord,
  extractToolErrorText,
  firstString,
  normalizeToolInputPayload,
  normalizeToolResultPayload,
  stringifyValue,
} from "@nanoboss/procedure-sdk";

import type { UiToolCall } from "../state/state.ts";
import type { ToolPreviewBlock } from "../shared/tool-preview.ts";
import {
  buildFullPreviewBlock,
  normalizeMultilineText,
} from "./tool-card-expanded-text.ts";

export function formatExpandedToolHeader(toolCall: UiToolCall): string | undefined {
  return normalizeToolInputPayload({ toolName: toolCall.toolName }, toolCall.rawInput).header ?? toolCall.callPreview?.header;
}

export function getExpandedToolInputBlock(toolCall: UiToolCall): ToolPreviewBlock | undefined {
  const normalized = normalizeToolInputPayload({ toolName: toolCall.toolName }, toolCall.rawInput);
  const record = asRecord(toolCall.rawInput);

  switch (normalized.toolName) {
    case "write": {
      return buildFullPreviewBlock(normalized.text);
    }
    case "edit": {
      if (!Array.isArray(record?.edits)) {
        return undefined;
      }

      const lines: string[] = [];
      for (const [index, entry] of record.edits.entries()) {
        const edit = asRecord(entry);
        if (!edit) {
          lines.push(`[edit ${index + 1}] ${stringifyValue(entry)}`);
          continue;
        }

        lines.push(`[edit ${index + 1}]`);
        const oldText = firstString(edit.oldText, edit.old_text);
        if (oldText) {
          lines.push("--- oldText ---");
          lines.push(...normalizeMultilineText(oldText).split("\n"));
        }
        const newText = firstString(edit.newText, edit.new_text);
        if (newText) {
          lines.push("+++ newText +++");
          lines.push(...normalizeMultilineText(newText).split("\n"));
        }
      }

      return lines.length > 0 ? { bodyLines: lines } : undefined;
    }
    case "bash":
    case "read":
    case "grep":
    case "find":
    case "ls":
      return undefined;
    default:
      return buildFullPreviewBlock(normalized.text ?? stringifyValue(toolCall.rawInput));
  }
}

export function getExpandedToolResultBlock(toolCall: UiToolCall): ToolPreviewBlock | undefined {
  const normalized = normalizeToolResultPayload({ toolName: toolCall.toolName }, toolCall.rawOutput);
  const record = asRecord(toolCall.rawOutput);
  const expandedContent = firstString(record?.expandedContent, record?.expanded_content);

  switch (normalized.toolName) {
    case "bash":
      return buildFullPreviewBlock(normalized.text);
    case "read":
    case "write":
      return buildFullPreviewBlock(normalized.text);
    case "edit":
      return buildFullPreviewBlock(normalized.text);
    case "grep":
    case "find":
    case "ls":
      return (normalized.lines?.length ?? 0) > 0
        ? { bodyLines: normalized.lines }
        : buildFullPreviewBlock(normalized.text);
    default:
      return buildFullPreviewBlock(expandedContent ?? normalized.text ?? stringifyValue(toolCall.rawOutput));
  }
}

export function getExpandedToolErrorBlock(toolCall: UiToolCall): ToolPreviewBlock | undefined {
  return buildFullPreviewBlock(
    extractToolErrorText(toolCall.rawOutput) ?? stringifyValue(toolCall.rawOutput),
  );
}

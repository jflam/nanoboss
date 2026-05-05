import type { ToolPreviewBlock } from "../shared/tool-preview.ts";

export function buildFullPreviewBlock(text: string | undefined): ToolPreviewBlock | undefined {
  if (!text) {
    return undefined;
  }

  const normalized = normalizeMultilineText(text);
  if (!normalized) {
    return undefined;
  }

  return {
    bodyLines: normalized.split("\n").map((line) => line.replace(/\s+$/g, "")),
  };
}

export function normalizeMultilineText(value: string): string {
  return stripAnsi(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "  ")
    .trim();
}

const ANSI_COLOR_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function stripAnsi(text: string): string {
  return text.replace(ANSI_COLOR_PATTERN, "");
}

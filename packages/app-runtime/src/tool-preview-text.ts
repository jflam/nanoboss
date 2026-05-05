import { summarizeText } from "@nanoboss/procedure-sdk";

export const MAX_HEADER_LENGTH = 140;
export const MAX_WARNING_LENGTH = 180;
export const MAX_PREVIEW_LINE_LENGTH = 160;

const MAX_PREVIEW_LINES = 16;
const MAX_BODY_CHARS = 4_000;
const ANSI_SGR_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export function boundedPreviewLines(
  value: unknown,
  mode: "start" | "end",
): { lines: string[]; truncated: boolean } {
  if (typeof value !== "string") {
    return { lines: [], truncated: false };
  }

  const normalized = normalizeMultilineText(value);
  if (!normalized) {
    return { lines: [], truncated: false };
  }

  const rawLines = normalized.split("\n");
  const limitedByChars = normalized.length > MAX_BODY_CHARS;
  const sourceLines = limitedByChars
    ? normalizeMultilineText(normalized.slice(0, MAX_BODY_CHARS)).split("\n")
    : rawLines;
  const trimmed = mode === "end" ? sourceLines.slice(-MAX_PREVIEW_LINES) : sourceLines.slice(0, MAX_PREVIEW_LINES);
  return {
    lines: normalizePreviewLines(trimmed),
    truncated: limitedByChars || rawLines.length > MAX_PREVIEW_LINES,
  };
}

export function normalizePreviewLines(lines: unknown[], maxLength = MAX_PREVIEW_LINE_LENGTH): string[] {
  return lines
    .map((line) => typeof line === "string" ? summarizeLine(line, maxLength) : undefined)
    .filter((line): line is string => Boolean(line));
}

export function summarizeWarnings(values: string[]): string[] | undefined {
  const warnings = normalizePreviewLines(values, MAX_WARNING_LENGTH);
  return warnings.length > 0 ? warnings : undefined;
}

export function boundedListPreviewLines(lines: string[] | undefined): { lines: string[]; truncated: boolean } | undefined {
  if (!Array.isArray(lines) || lines.length === 0) {
    return undefined;
  }

  const visibleLines = normalizePreviewLines(lines.slice(0, MAX_PREVIEW_LINES));
  if (visibleLines.length === 0) {
    return undefined;
  }

  return {
    lines: visibleLines,
    truncated: lines.length > visibleLines.length || lines.length > MAX_PREVIEW_LINES,
  };
}

export function summarizeInline(value: string, maxLength: number): string {
  return summarizeText(stripAnsi(value).replace(/\s+/g, " ").trim(), maxLength);
}

function summarizeLine(value: string, maxLength: number): string | undefined {
  const normalized = stripAnsi(value).replace(/\t/g, "  ").replace(/\s+$/g, "");
  if (!normalized.trim()) {
    return undefined;
  }

  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3).trimEnd()}...` : normalized;
}

function normalizeMultilineText(value: string): string {
  return stripAnsi(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "  ")
    .trim();
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR_PATTERN, "");
}

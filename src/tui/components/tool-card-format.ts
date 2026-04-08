import type { ToolPreviewBlock } from "../../core/tool-call-preview.ts";
import type { UiToolCall } from "../state.ts";
import type { NanobossTuiTheme } from "../theme.ts";
import { getLanguageFromPath } from "../theme.ts";

const MAX_FALLBACK_JSON_LENGTH = 200_000;

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

export function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1_000).toFixed(durationMs >= 10_000 ? 0 : 1)}s`;
}

export function formatToolDurationLine(theme: NanobossTuiTheme, toolCall: UiToolCall): string | undefined {
  if (toolCall.durationMs === undefined) {
    return undefined;
  }

  return theme.toolCardMeta(`Took ${formatDuration(toolCall.durationMs)}`);
}

export function normalizeToolName(toolCall: Pick<UiToolCall, "kind" | "title">): string | undefined {
  if (toolCall.kind && toolCall.kind !== "other" && toolCall.kind !== "thought" && toolCall.kind !== "wrapper") {
    return toolCall.kind;
  }

  const title = toolCall.title.toLowerCase();
  if (title.startsWith("mock ")) {
    const parts = title.split(/\s+/);
    return parts[1];
  }

  if (title.startsWith("callagent") || title.startsWith("defaultsession:") || title.startsWith("calling ")) {
    return "agent";
  }

  const firstToken = title.split(/[\s:([]/, 1)[0] || "";
  const lastSegment = firstToken.split(".").at(-1);
  return lastSegment || firstToken || undefined;
}

export function formatToolHeader(theme: NanobossTuiTheme, header: string | undefined, fallbackTitle: string): string {
  const text = stripWrappingBackticks((header?.trim() || fallbackTitle).trim());

  if (text.startsWith("$ ")) {
    return `${theme.toolCardTitle("$")} ${theme.toolCardBody(text.slice(2))}`;
  }

  const match = text.match(/^(read|write|edit|grep|find|ls)(?:\s+(.*))?$/i);
  if (!match) {
    return theme.toolCardTitle(text);
  }

  const [, command, rest] = match;
  const commandText = theme.toolCardTitle(command);
  if (!rest) {
    return commandText;
  }

  if (command.toLowerCase() === "read") {
    const rangeMatch = rest.match(/^(.*?)(:\d+(?:-\d+)?)$/);
    if (rangeMatch) {
      return `${commandText} ${theme.toolCardAccent(rangeMatch[1])}${theme.toolCardWarning(rangeMatch[2])}`;
    }
  }

  return `${commandText} ${theme.toolCardAccent(stripWrappingBackticks(rest))}`;
}

function stripWrappingBackticks(text: string): string {
  return text.replace(/^`+|`+$/g, "");
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

export function formatDiffLine(theme: NanobossTuiTheme, line: string): string {
  if (
    line.startsWith("diff --git ")
    || line.startsWith("index ")
    || line.startsWith("--- ")
    || line.startsWith("+++ ")
    || line.startsWith("*** ")
  ) {
    return theme.toolCardMeta(line);
  }

  if (line.startsWith("@@")) {
    return theme.toolCardAccent(line);
  }

  if (line.startsWith("+")) {
    return theme.toolCardSuccess(line);
  }

  if (line.startsWith("-")) {
    return theme.toolCardError(line);
  }

  return theme.toolCardBody(line);
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

export function formatExpandedToolHeader(toolCall: UiToolCall): string | undefined {
  const toolName = normalizeToolName(toolCall);
  const record = asRecord(toolCall.rawInput);

  switch (toolName) {
    case "bash": {
      const command = firstString(record?.command, record?.cmd);
      return command ? `$ ${command}` : toolCall.callPreview?.header;
    }
    case "read": {
      const path = extractPathLike(record);
      return path ? `read ${path}${formatLineRange(record)}` : toolCall.callPreview?.header;
    }
    case "write": {
      const path = extractPathLike(record);
      return path ? `write ${path}` : toolCall.callPreview?.header;
    }
    case "edit": {
      const path = extractPathLike(record);
      return path ? `edit ${path}` : toolCall.callPreview?.header;
    }
    case "grep": {
      const pattern = firstString(record?.pattern, record?.query);
      const path = firstString(extractPathLike(record), record?.cwd);
      if (pattern || path) {
        return path ? `grep ${pattern ?? ""} @ ${path}` : `grep ${pattern ?? path}`;
      }
      return toolCall.callPreview?.header;
    }
    case "find": {
      const query = firstString(record?.query, record?.pattern, record?.name);
      const path = firstString(extractPathLike(record), record?.cwd, record?.dir);
      if (query || path) {
        return path && query ? `find ${query} @ ${path}` : `find ${query ?? path}`;
      }
      return toolCall.callPreview?.header;
    }
    case "ls": {
      const path = firstString(extractPathLike(record), record?.dir, record?.cwd);
      return path ? `ls ${path}` : toolCall.callPreview?.header;
    }
    default:
      return toolCall.callPreview?.header;
  }
}

export function getExpandedToolInputBlock(toolCall: UiToolCall): ToolPreviewBlock | undefined {
  const toolName = normalizeToolName(toolCall);
  const record = asRecord(toolCall.rawInput);

  switch (toolName) {
    case "write": {
      const text = extractTextLikeContent(record?.content ?? record?.text ?? toolCall.rawInput);
      return buildFullPreviewBlock(text);
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
      return buildFullPreviewBlock(stringifyValue(toolCall.rawInput));
  }
}

export function getExpandedToolResultBlock(toolCall: UiToolCall): ToolPreviewBlock | undefined {
  const toolName = normalizeToolName(toolCall);
  const record = asRecord(toolCall.rawOutput);
  const expandedContent = firstString(record?.expandedContent, record?.expanded_content);

  switch (toolName) {
    case "bash":
      return buildFullPreviewBlock(firstString(record?.stdout, record?.stderr, record?.text, record?.content));
    case "read":
    case "write":
      return buildFullPreviewBlock(extractTextLikeContent(toolCall.rawOutput));
    case "edit":
      return buildFullPreviewBlock(firstString(record?.diff, record?.patch, record?.text, record?.content));
    case "grep":
    case "find":
    case "ls": {
      const lines = extractListLikeLines(toolCall.rawOutput);
      return lines.length > 0 ? { bodyLines: lines } : undefined;
    }
    default:
      return buildFullPreviewBlock(expandedContent ?? extractTextLikeContent(toolCall.rawOutput) ?? stringifyValue(toolCall.rawOutput));
  }
}

export function getExpandedToolErrorBlock(toolCall: UiToolCall): ToolPreviewBlock | undefined {
  const record = asRecord(toolCall.rawOutput);
  return buildFullPreviewBlock(
    firstString(record?.error, record?.error_message, record?.message, record?.stderr)
      ?? stringifyValue(toolCall.rawOutput),
  );
}

function getToolCodeContext(toolCall: UiToolCall): { shouldHighlight: boolean; language?: string } {
  const toolName = normalizeToolName(toolCall);
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

function buildFullPreviewBlock(text: string | undefined): ToolPreviewBlock | undefined {
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

function extractListLikeLines(value: unknown): string[] {
  const record = asRecord(value);
  const candidates: unknown[] = [
    record?.matches,
    record?.items,
    record?.entries,
    record?.files,
    record?.paths,
    record?.results,
    record?.lines,
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate) || candidate.length === 0) {
      continue;
    }

    const lines = candidate
      .map((entry) => summarizeListEntry(entry))
      .filter((entry): entry is string => Boolean(entry));
    if (lines.length > 0) {
      return lines;
    }
  }

  return [];
}

function looksLikeDiffBlock(lines: string[]): boolean {
  let hasUnifiedFileHeaders = false;
  let hasUnifiedHunk = false;
  let hasGitDiffHeader = false;
  let hasApplyPatchHeader = false;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      hasGitDiffHeader = true;
    } else if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      hasUnifiedFileHeaders = true;
    } else if (line.startsWith("@@")) {
      hasUnifiedHunk = true;
    } else if (
      line.startsWith("*** Begin Patch")
      || line.startsWith("*** Update File:")
      || line.startsWith("*** Add File:")
      || line.startsWith("*** Delete File:")
      || line.startsWith("*** Move to:")
    ) {
      hasApplyPatchHeader = true;
    }
  }

  return hasApplyPatchHeader || (hasUnifiedFileHeaders && hasUnifiedHunk) || (hasGitDiffHeader && (hasUnifiedFileHeaders || hasUnifiedHunk));
}

function summarizeListEntry(entry: unknown): string | undefined {
  if (typeof entry === "string") {
    return entry;
  }

  const record = asRecord(entry);
  if (!record) {
    return stringifyValue(entry);
  }

  const path = firstString(extractPathLike(record), record.file, record.name);
  const line = firstNumber(record.line, record.startLine, record.start_line);
  const text = firstString(record.text, record.content, record.preview, record.match);

  if (path && line !== undefined && text) {
    return `${path}:${line} ${text}`;
  }
  if (path && text) {
    return `${path} ${text}`;
  }
  if (path) {
    return path;
  }
  if (text) {
    return text;
  }

  return stringifyValue(entry);
}

function extractTextLikeContent(value: unknown): string | undefined {
  const record = asRecord(value);
  const nestedRecords = [
    asRecord(record?.file),
    asRecord(record?.result),
    asRecord(record?.response),
    asRecord(record?.output),
    asRecord(record?.data),
  ];

  const direct = firstString(
    record?.text,
    record?.content,
    record?.detailedContent,
    record?.stdout,
    record?.stderr,
    ...nestedRecords.flatMap((item) => item ? [item.text, item.content, item.detailedContent, item.stdout, item.stderr] : []),
    value,
  );
  if (direct) {
    return direct;
  }

  if (Array.isArray(record?.contents)) {
    const text = record.contents
      .map((item) => asRecord(item))
      .map((item) => firstString(item?.text, item?.content, asRecord(item?.file)?.content))
      .filter((item): item is string => Boolean(item))
      .join("\n");
    if (text) {
      return text;
    }
  }

  if (Array.isArray(record?.content)) {
    const text = record.content
      .map((item) => asRecord(item))
      .map((item) => firstString(item?.text, asRecord(item?.content)?.text, asRecord(item?.file)?.content))
      .filter((item): item is string => Boolean(item))
      .join("\n");
    if (text) {
      return text;
    }
  }

  const structuredContent = firstDefined(record?.structuredContent, ...nestedRecords.map((item) => item?.structuredContent));
  if (structuredContent !== undefined) {
    return stringifyValue(structuredContent);
  }

  return undefined;
}

function normalizeMultilineText(value: string): string {
  return stripAnsi(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "  ")
    .trim();
}

function formatLineRange(record: Record<string, unknown> | undefined): string {
  if (!record) {
    return "";
  }

  const firstLocation = Array.isArray(record.locations) ? asRecord(record.locations[0]) : undefined;
  const offset = firstNumber(
    record.offset,
    record.line,
    record.startLine,
    record.start_line,
    firstLocation?.line,
    firstLocation?.startLine,
    firstLocation?.start_line,
  );
  const limit = firstNumber(record.limit, record.count);
  if (offset === undefined && limit === undefined) {
    return "";
  }

  if (offset !== undefined && limit !== undefined) {
    return `:${offset}-${offset + Math.max(0, limit - 1)}`;
  }

  return offset !== undefined ? `:${offset}` : "";
}

function extractPathLike(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) {
    return undefined;
  }

  const location = asRecord(record.location);
  const firstLocation = Array.isArray(record.locations) ? asRecord(record.locations[0]) : undefined;
  const file = asRecord(record.file);
  const target = asRecord(record.target);

  return firstString(
    record.path,
    record.filePath,
    record.file_path,
    record.fileName,
    record.filename,
    location?.path,
    location?.filePath,
    location?.file_path,
    firstLocation?.path,
    firstLocation?.filePath,
    firstLocation?.file_path,
    file?.path,
    file?.filePath,
    file?.file_path,
    target?.path,
    target?.filePath,
    target?.file_path,
  );
}

const ANSI_COLOR_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function stripAnsi(text: string): string {
  return text.replace(ANSI_COLOR_PATTERN, "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

function firstDefined<T>(...values: (T | undefined)[]): T | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function stringifyValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  if (typeof value === "symbol") {
    return value.toString();
  }

  if (typeof value === "function") {
    return value.name ? `[Function: ${value.name}]` : "[Function]";
  }

  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > MAX_FALLBACK_JSON_LENGTH ? `${text.slice(0, MAX_FALLBACK_JSON_LENGTH)}\n…` : text;
  } catch {
    return Object.prototype.toString.call(value);
  }
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

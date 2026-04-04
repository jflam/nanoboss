import { summarizeText } from "../util/text.ts";

const MAX_HEADER_LENGTH = 140;
const MAX_WARNING_LENGTH = 180;
const MAX_PREVIEW_LINES = 16;
const MAX_PREVIEW_LINE_LENGTH = 160;
const MAX_BODY_CHARS = 4_000;

export interface ToolPreviewBlock {
  header?: string;
  bodyLines?: string[];
  warnings?: string[];
  truncated?: boolean;
}

interface ToolIdentity {
  title?: string;
  kind?: string;
}

interface ToolPreviewFields {
  callPreview?: ToolPreviewBlock;
  resultPreview?: ToolPreviewBlock;
  errorPreview?: ToolPreviewBlock;
  durationMs?: number;
}

export function summarizeToolCallStart(
  identity: ToolIdentity,
  rawInput: unknown,
): Pick<ToolPreviewFields, "callPreview"> {
  return {
    callPreview: summarizeToolInput(identity, rawInput),
  };
}

export function summarizeToolCallUpdate(
  identity: ToolIdentity,
  rawOutput: unknown,
): Pick<ToolPreviewFields, "resultPreview" | "errorPreview" | "durationMs"> {
  const record = asRecord(rawOutput);
  const durationMs = typeof record?.durationMs === "number" ? record.durationMs : undefined;

  const explicitErrorPreview = normalizeToolPreviewBlock(record?.errorPreview);
  const explicitResultPreview = normalizeToolPreviewBlock(record?.resultPreview);
  if (explicitErrorPreview || explicitResultPreview) {
    return {
      resultPreview: explicitResultPreview,
      errorPreview: explicitErrorPreview,
      durationMs,
    };
  }

  const errorPreview = summarizeToolError(rawOutput);
  if (errorPreview) {
    return {
      errorPreview,
      durationMs,
    };
  }

  return {
    resultPreview: summarizeToolOutput(identity, rawOutput),
    durationMs,
  };
}

export function compactToolCallInput(identity: ToolIdentity, rawInput: unknown): unknown {
  const callPreview = summarizeToolInput(identity, rawInput);
  return callPreview ? { callPreview } : undefined;
}

export function compactToolCallOutput(identity: ToolIdentity, rawOutput: unknown): unknown {
  if (rawOutput === undefined) {
    return undefined;
  }

  const preview = summarizeToolCallUpdate(identity, rawOutput);
  const record = asRecord(rawOutput);

  return cleanObject({
    ...(preview.resultPreview ? { resultPreview: preview.resultPreview } : {}),
    ...(preview.errorPreview ? { errorPreview: preview.errorPreview } : {}),
    ...(preview.durationMs !== undefined ? { durationMs: preview.durationMs } : {}),
    ...(record && typeof record.tokenUsage === "object" ? { tokenUsage: record.tokenUsage } : {}),
    ...(record && typeof record.tokenSnapshot === "object" ? { tokenSnapshot: record.tokenSnapshot } : {}),
  });
}

function summarizeToolInput(identity: ToolIdentity, rawInput: unknown): ToolPreviewBlock | undefined {
  const record = asRecord(rawInput);
  const explicit = normalizeToolPreviewBlock(
    record?.callPreview,
    buildSummaryPreviewBlock(record?.inputSummary ?? record?.preview),
  );
  if (explicit) {
    return explicit;
  }

  const toolName = normalizeToolName(identity);
  switch (toolName) {
    case "bash": {
      const command = firstString(record?.command, record?.cmd, rawInput);
      return command ? { header: summarizeInline(`$ ${command}`, MAX_HEADER_LENGTH) } : undefined;
    }
    case "read": {
      const path = firstString(record?.path, record?.filePath);
      const header = path ? summarizeInline(`read ${path}${formatLineRange(record)}`, MAX_HEADER_LENGTH) : undefined;
      return cleanPreviewBlock({
        header,
        warnings: summarizeWarnings(extractWarnings(record)),
      });
    }
    case "write": {
      const path = firstString(record?.path, record?.filePath);
      return cleanPreviewBlock({
        header: path ? summarizeInline(`write ${path}`, MAX_HEADER_LENGTH) : undefined,
        bodyLines: boundedPreviewLines(extractTextLikeContent(record?.content ?? record?.text ?? rawInput), "start").lines,
        warnings: summarizeWarnings(extractWarnings(record)),
      });
    }
    case "edit": {
      const path = firstString(record?.path, record?.filePath);
      const edits = Array.isArray(record?.edits) ? record.edits.length : undefined;
      const bodyLines = edits !== undefined ? [`${edits} edit${edits === 1 ? "" : "s"}`] : undefined;
      return cleanPreviewBlock({
        header: path ? summarizeInline(`edit ${path}`, MAX_HEADER_LENGTH) : undefined,
        bodyLines,
        warnings: summarizeWarnings(extractWarnings(record)),
      });
    }
    case "grep": {
      const pattern = firstString(record?.pattern, record?.query);
      const path = firstString(record?.path, record?.cwd);
      if (!pattern && !path) {
        break;
      }

      return cleanPreviewBlock({
        header: summarizeInline(path ? `grep ${pattern ?? ""} @ ${path}` : `grep ${pattern ?? path}`, MAX_HEADER_LENGTH),
        warnings: summarizeWarnings(extractWarnings(record)),
      });
    }
    case "find": {
      const query = firstString(record?.query, record?.pattern, record?.name);
      const path = firstString(record?.path, record?.cwd, record?.dir);
      if (!query && !path) {
        break;
      }

      return cleanPreviewBlock({
        header: summarizeInline(path && query ? `find ${query} @ ${path}` : `find ${query ?? path}`, MAX_HEADER_LENGTH),
        warnings: summarizeWarnings(extractWarnings(record)),
      });
    }
    case "ls": {
      const path = firstString(record?.path, record?.filePath, record?.dir, record?.cwd);
      return cleanPreviewBlock({
        header: path ? summarizeInline(`ls ${path}`, MAX_HEADER_LENGTH) : undefined,
        warnings: summarizeWarnings(extractWarnings(record)),
      });
    }
  }

  const prompt = firstString(record?.prompt, record?.text, rawInput);
  if (prompt) {
    return buildSummaryPreviewBlock(prompt);
  }

  const path = firstString(record?.path, record?.filePath);
  if (path) {
    return buildSummaryPreviewBlock(path);
  }

  return buildSummaryPreviewBlock(summarizeUnknown(rawInput, MAX_HEADER_LENGTH));
}

function summarizeToolOutput(identity: ToolIdentity, rawOutput: unknown): ToolPreviewBlock | undefined {
  const record = asRecord(rawOutput);
  const explicit = normalizeToolPreviewBlock(
    record?.resultPreview,
    buildSummaryPreviewBlock(record?.outputSummary ?? record?.preview),
  );
  if (explicit) {
    return explicit;
  }

  const toolName = normalizeToolName(identity);
  switch (toolName) {
    case "bash":
      return cleanPreviewBlock({
        bodyLines: boundedPreviewLines(
          firstString(record?.stdout, record?.stderr, record?.text, record?.content),
          "end",
        ).lines,
        warnings: summarizeWarnings(extractWarnings(record)),
        truncated: hasPreviewTruncation(firstString(record?.stdout, record?.stderr, record?.text, record?.content), record),
      });
    case "read": {
      const contents = extractTextLikeContent(rawOutput);
      const preview = boundedPreviewLines(contents, "start");
      return cleanPreviewBlock({
        bodyLines: preview.lines,
        warnings: summarizeWarnings(extractWarnings(record)),
        truncated: preview.truncated || hasExplicitTruncation(record),
      });
    }
    case "edit": {
      const diffText = firstString(record?.diff, record?.patch, record?.text, record?.content);
      const diffPreview = boundedPreviewLines(diffText, "start");
      const path = firstString(record?.path, record?.filePath);
      return cleanPreviewBlock({
        bodyLines: diffPreview.lines.length > 0
          ? diffPreview.lines
          : path
            ? [`updated ${path}`]
            : undefined,
        warnings: summarizeWarnings(extractWarnings(record)),
        truncated: diffPreview.truncated || hasExplicitTruncation(record),
      });
    }
    case "write": {
      const outputText = extractTextLikeContent(rawOutput);
      const preview = boundedPreviewLines(outputText, "start");
      const path = firstString(record?.path, record?.filePath);
      return cleanPreviewBlock({
        bodyLines: preview.lines.length > 0
          ? preview.lines
          : path
            ? [`wrote ${path}`]
            : undefined,
        warnings: summarizeWarnings(extractWarnings(record)),
        truncated: preview.truncated || hasExplicitTruncation(record),
      });
    }
    case "grep":
    case "find":
    case "ls": {
      const preview = summarizeListLikeResult(rawOutput);
      if (preview) {
        return cleanPreviewBlock({
          bodyLines: preview.lines,
          warnings: summarizeWarnings(extractWarnings(record)),
          truncated: preview.truncated || hasExplicitTruncation(record),
        });
      }
      break;
    }
  }

  const textLike = extractTextLikeContent(rawOutput);
  if (textLike) {
    const preview = boundedPreviewLines(textLike, "start");
    return cleanPreviewBlock({
      bodyLines: preview.lines,
      warnings: summarizeWarnings(extractWarnings(record)),
      truncated: preview.truncated || hasExplicitTruncation(record),
    });
  }

  const listPreview = summarizeListLikeResult(rawOutput);
  if (listPreview) {
    return cleanPreviewBlock({
      bodyLines: listPreview.lines,
      warnings: summarizeWarnings(extractWarnings(record)),
      truncated: listPreview.truncated || hasExplicitTruncation(record),
    });
  }

  const cell = record?.cell;
  if (isCellRef(cell)) {
    return { bodyLines: [`stored result in ${cell.cellId}`] };
  }

  const dataRef = asRecord(record?.dataRef);
  if (isCellRef(dataRef?.cell) && typeof dataRef?.path === "string") {
    return { bodyLines: [summarizeInline(`stored ref ${dataRef.path}`, MAX_PREVIEW_LINE_LENGTH)] };
  }

  const path = firstString(record?.path, record?.filePath);
  if (path) {
    return { bodyLines: [summarizeInline(path, MAX_PREVIEW_LINE_LENGTH)] };
  }

  return buildSummaryPreviewBlock(summarizeUnknown(rawOutput, MAX_HEADER_LENGTH));
}

function summarizeToolError(rawOutput: unknown): ToolPreviewBlock | undefined {
  const record = asRecord(rawOutput);
  const explicit = normalizeToolPreviewBlock(
    record?.errorPreview,
    buildSummaryPreviewBlock(record?.errorSummary),
  );
  if (explicit) {
    return explicit;
  }

  const errorText = firstString(record?.error, record?.message, record?.stderr);
  if (!errorText) {
    return undefined;
  }

  const preview = boundedPreviewLines(errorText, "start");
  return cleanPreviewBlock({
    bodyLines: preview.lines,
    warnings: summarizeWarnings(extractWarnings(record)),
    truncated: preview.truncated || hasExplicitTruncation(record),
  });
}

function normalizeToolPreviewBlock(value: unknown, fallback?: ToolPreviewBlock): ToolPreviewBlock | undefined {
  const record = asRecord(value);
  if (!record) {
    return fallback ? cleanPreviewBlock(fallback) : undefined;
  }

  const header = summarizeInline(firstString(record.header), MAX_HEADER_LENGTH);
  const bodyText = firstString(record.body, record.text, record.content);
  const bodyLines = Array.isArray(record.bodyLines)
    ? normalizePreviewLines(record.bodyLines)
    : bodyText
      ? boundedPreviewLines(bodyText, "start").lines
      : undefined;
  const warnings = Array.isArray(record.warnings)
    ? normalizePreviewLines(record.warnings, MAX_WARNING_LENGTH)
    : summarizeWarnings(extractWarnings(record));
  const truncated = record.truncated === true;

  return cleanPreviewBlock({
    header,
    bodyLines,
    warnings,
    truncated,
  }) ?? fallback;
}

function summarizeListLikeResult(value: unknown): { lines: string[]; truncated: boolean } | undefined {
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
    if (lines.length === 0) {
      continue;
    }

    return {
      lines: normalizePreviewLines(lines),
      truncated: candidate.length > lines.length || candidate.length > MAX_PREVIEW_LINES,
    };
  }

  return undefined;
}

function summarizeListEntry(entry: unknown): string | undefined {
  if (typeof entry === "string") {
    return summarizeInline(entry, MAX_PREVIEW_LINE_LENGTH);
  }

  const record = asRecord(entry);
  if (!record) {
    return summarizeUnknown(entry, MAX_PREVIEW_LINE_LENGTH);
  }

  const path = firstString(record.path, record.file, record.filePath, record.name);
  const line = typeof record.line === "number" ? record.line : undefined;
  const text = firstString(record.text, record.content, record.preview, record.match);

  if (path && line !== undefined && text) {
    return summarizeInline(`${path}:${line} ${text}`, MAX_PREVIEW_LINE_LENGTH);
  }
  if (path && text) {
    return summarizeInline(`${path} ${text}`, MAX_PREVIEW_LINE_LENGTH);
  }
  if (path) {
    return summarizeInline(path, MAX_PREVIEW_LINE_LENGTH);
  }
  if (text) {
    return summarizeInline(text, MAX_PREVIEW_LINE_LENGTH);
  }

  return summarizeUnknown(entry, MAX_PREVIEW_LINE_LENGTH);
}

function extractTextLikeContent(value: unknown): string | undefined {
  const record = asRecord(value);

  const direct = firstString(
    record?.text,
    record?.content,
    record?.detailedContent,
    record?.stdout,
    record?.stderr,
    value,
  );
  if (direct) {
    return direct;
  }

  if (Array.isArray(record?.contents)) {
    const text = record.contents
      .map((item) => asRecord(item))
      .map((item) => firstString(item?.text, item?.content))
      .filter((item): item is string => Boolean(item))
      .join("\n");
    if (text) {
      return text;
    }
  }

  if (Array.isArray(record?.content)) {
    const text = record.content
      .map((item) => asRecord(item))
      .map((item) => firstString(item?.text, asRecord(item?.content)?.text))
      .filter((item): item is string => Boolean(item))
      .join("\n");
    if (text) {
      return text;
    }
  }

  const structuredContent = record?.structuredContent;
  if (structuredContent !== undefined) {
    return summarizeUnknown(structuredContent, MAX_BODY_CHARS);
  }

  return undefined;
}

function buildSummaryPreviewBlock(value: unknown): ToolPreviewBlock | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const summary = summarizeInline(value, MAX_HEADER_LENGTH);
  return summary ? { bodyLines: [summary] } : undefined;
}

function boundedPreviewLines(
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
    ? normalizeMultilineText(normalized.slice(0, MAX_BODY_CHARS))?.split("\n") ?? rawLines
    : rawLines;
  const trimmed = mode === "end" ? sourceLines.slice(-MAX_PREVIEW_LINES) : sourceLines.slice(0, MAX_PREVIEW_LINES);
  return {
    lines: normalizePreviewLines(trimmed),
    truncated: limitedByChars || rawLines.length > MAX_PREVIEW_LINES,
  };
}

function normalizePreviewLines(lines: unknown[], maxLength = MAX_PREVIEW_LINE_LENGTH): string[] {
  return lines
    .map((line) => typeof line === "string" ? summarizeLine(line, maxLength) : undefined)
    .filter((line): line is string => Boolean(line));
}

function summarizeWarnings(values: string[]): string[] | undefined {
  const warnings = normalizePreviewLines(values, MAX_WARNING_LENGTH);
  return warnings.length > 0 ? warnings : undefined;
}

function summarizeInline(value: string, maxLength: number): string {
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

function extractWarnings(record: Record<string, unknown> | undefined): string[] {
  if (!record) {
    return [];
  }

  const warnings: string[] = [];
  const explicitWarnings = Array.isArray(record.warnings) ? normalizePreviewLines(record.warnings) : [];
  warnings.push(...explicitWarnings);

  if (record.truncated === true || record.isTruncated === true) {
    warnings.push("output truncated");
  }

  const fullOutputPath = firstString(
    record.fullOutputPath,
    record.truncatedOutputPath,
    record.outputPath,
    record.savedPath,
    record.savedTo,
    record.logFile,
  );
  if (fullOutputPath) {
    warnings.push(`full output: ${fullOutputPath}`);
  }

  const notice = firstString(record.notice, record.warning, record.warningMessage, record.truncationNotice);
  if (notice) {
    warnings.push(notice);
  }

  return warnings;
}

function formatLineRange(record: Record<string, unknown> | undefined): string {
  if (!record) {
    return "";
  }

  const offset = typeof record.offset === "number"
    ? record.offset
    : typeof record.line === "number"
      ? record.line
      : typeof record.startLine === "number"
        ? record.startLine
        : undefined;
  const limit = typeof record.limit === "number"
    ? record.limit
    : typeof record.count === "number"
      ? record.count
      : undefined;
  if (offset === undefined && limit === undefined) {
    return "";
  }

  if (offset !== undefined && limit !== undefined) {
    return `:${offset}-${offset + Math.max(0, limit - 1)}`;
  }

  return offset !== undefined ? `:${offset}` : "";
}

function hasPreviewTruncation(text: string | undefined, record: Record<string, unknown> | undefined): boolean {
  return boundedPreviewLines(text, "end").truncated || hasExplicitTruncation(record);
}

function hasExplicitTruncation(record: Record<string, unknown> | undefined): boolean {
  return record?.truncated === true || record?.isTruncated === true;
}

function summarizeUnknown(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string") {
    return summarizeInline(value, maxLength);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  try {
    return summarizeInline(JSON.stringify(value), maxLength);
  } catch {
    return summarizeInline(String(value), maxLength);
  }
}

function normalizeToolName(identity: ToolIdentity): string | undefined {
  const kind = identity.kind?.trim().toLowerCase();
  if (kind && kind !== "other" && kind !== "thought" && kind !== "wrapper") {
    return kind;
  }

  const title = identity.title?.trim().toLowerCase();
  if (!title) {
    return undefined;
  }

  if (title.startsWith("mock ")) {
    const parts = title.split(/\s+/);
    return parts[1];
  }

  if (title.startsWith("callagent") || title.startsWith("defaultsession:") || title.startsWith("calling ")) {
    return "agent";
  }

  const firstToken = title.split(/[\s:(\[]/, 1)[0] || "";
  const lastSegment = firstToken.split(".").at(-1);
  return lastSegment || firstToken || undefined;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
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

function cleanObject(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function cleanPreviewBlock(block: ToolPreviewBlock | undefined): ToolPreviewBlock | undefined {
  if (!block) {
    return undefined;
  }

  const header = typeof block.header === "string" && block.header.trim() ? block.header : undefined;
  const bodyLines = Array.isArray(block.bodyLines) && block.bodyLines.length > 0 ? block.bodyLines : undefined;
  const warnings = Array.isArray(block.warnings) && block.warnings.length > 0 ? block.warnings : undefined;
  const truncated = block.truncated === true ? true : undefined;

  if (!header && !bodyLines && !warnings && !truncated) {
    return undefined;
  }

  return {
    ...(header ? { header } : {}),
    ...(bodyLines ? { bodyLines } : {}),
    ...(warnings ? { warnings } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

function isCellRef(value: unknown): value is { sessionId: string; cellId: string } {
  const record = asRecord(value);
  return typeof record?.sessionId === "string" && typeof record?.cellId === "string";
}

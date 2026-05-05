import {
  asRecord,
  extractPathLike,
  extractToolErrorText,
  firstNumber,
  firstString,
  normalizeToolInputPayload,
  normalizeToolResultPayload,
} from "@nanoboss/procedure-sdk";
import type { ToolPayloadIdentity } from "@nanoboss/procedure-sdk";
import {
  MAX_HEADER_LENGTH,
  MAX_PREVIEW_LINE_LENGTH,
  MAX_WARNING_LENGTH,
  boundedListPreviewLines,
  boundedPreviewLines,
  normalizePreviewLines,
  summarizeInline,
  summarizeWarnings,
} from "./tool-preview-text.ts";

export interface ToolPreviewBlock {
  header?: string;
  bodyLines?: string[];
  warnings?: string[];
  truncated?: boolean;
}

interface ToolPreviewFields {
  callPreview?: ToolPreviewBlock;
  resultPreview?: ToolPreviewBlock;
  errorPreview?: ToolPreviewBlock;
  durationMs?: number;
}

export function summarizeToolCallStart(
  identity: ToolPayloadIdentity,
  rawInput: unknown,
): Pick<ToolPreviewFields, "callPreview"> {
  return {
    callPreview: summarizeToolInput(identity, rawInput),
  };
}

export function summarizeToolCallUpdate(
  identity: ToolPayloadIdentity,
  rawOutput: unknown,
): Pick<ToolPreviewFields, "resultPreview" | "errorPreview" | "durationMs"> {
  const record = asRecord(rawOutput);
  const durationMs = firstNumber(record?.durationMs, record?.duration_ms);

  const explicitErrorPreview = normalizeToolPreviewBlock(record?.errorPreview ?? record?.error_preview);
  const explicitResultPreview = normalizeToolPreviewBlock(record?.resultPreview ?? record?.result_preview);
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

function summarizeToolInput(identity: ToolPayloadIdentity, rawInput: unknown): ToolPreviewBlock | undefined {
  const record = asRecord(rawInput);
  const explicit = normalizeToolPreviewBlock(
    record?.callPreview ?? record?.call_preview,
    buildSummaryPreviewBlock(record?.inputSummary ?? record?.input_summary ?? record?.preview),
  );
  if (explicit) {
    return explicit;
  }

  const normalized = normalizeToolInputPayload(identity, rawInput);
  switch (normalized.toolName) {
    case "bash": {
      return normalized.header ? { header: summarizeInline(normalized.header, MAX_HEADER_LENGTH) } : undefined;
    }
    case "read": {
      return cleanPreviewBlock({
        header: normalized.header ? summarizeInline(normalized.header, MAX_HEADER_LENGTH) : undefined,
        warnings: summarizeWarnings(extractWarnings(record)),
      });
    }
    case "write": {
      return cleanPreviewBlock({
        header: normalized.header ? summarizeInline(normalized.header, MAX_HEADER_LENGTH) : undefined,
        bodyLines: boundedPreviewLines(normalized.text, "start").lines,
        warnings: summarizeWarnings(extractWarnings(record)),
      });
    }
    case "edit": {
      const edits = Array.isArray(record?.edits) ? record.edits.length : undefined;
      const bodyLines = edits !== undefined ? [`${edits} edit${edits === 1 ? "" : "s"}`] : undefined;
      return cleanPreviewBlock({
        header: normalized.header ? summarizeInline(normalized.header, MAX_HEADER_LENGTH) : undefined,
        bodyLines,
        warnings: summarizeWarnings(extractWarnings(record)),
      });
    }
    case "grep":
    case "find":
    case "ls": {
      return cleanPreviewBlock({
        header: normalized.header ? summarizeInline(normalized.header, MAX_HEADER_LENGTH) : undefined,
        warnings: summarizeWarnings(extractWarnings(record)),
      });
    }
  }

  const prompt = firstString(record?.prompt, record?.text, rawInput);
  if (prompt) {
    return buildSummaryPreviewBlock(prompt);
  }

  const path = extractPathLike(record);
  if (path) {
    return buildSummaryPreviewBlock(path);
  }

  return buildSummaryPreviewBlock(summarizeUnknown(rawInput, MAX_HEADER_LENGTH));
}

function summarizeToolOutput(identity: ToolPayloadIdentity, rawOutput: unknown): ToolPreviewBlock | undefined {
  const record = asRecord(rawOutput);
  const explicit = normalizeToolPreviewBlock(
    record?.resultPreview ?? record?.result_preview,
    buildSummaryPreviewBlock(record?.outputSummary ?? record?.output_summary ?? record?.preview),
  );
  if (explicit) {
    return explicit;
  }

  const normalized = normalizeToolResultPayload(identity, rawOutput);
  switch (normalized.toolName) {
    case "bash":
      return cleanPreviewBlock({
        bodyLines: boundedPreviewLines(normalized.text, "end").lines,
        warnings: summarizeWarnings(extractWarnings(record)),
        truncated: hasPreviewTruncation(normalized.text, record),
      });
    case "read": {
      const preview = boundedPreviewLines(normalized.text, "start");
      return cleanPreviewBlock({
        bodyLines: preview.lines,
        warnings: summarizeWarnings(extractWarnings(record)),
        truncated: preview.truncated || hasExplicitTruncation(record),
      });
    }
    case "edit": {
      const diffPreview = boundedPreviewLines(normalized.text, "start");
      return cleanPreviewBlock({
        bodyLines: diffPreview.lines.length > 0
          ? diffPreview.lines
          : normalized.path
            ? [`updated ${normalized.path}`]
            : undefined,
        warnings: summarizeWarnings(extractWarnings(record)),
        truncated: diffPreview.truncated || hasExplicitTruncation(record),
      });
    }
    case "write": {
      const preview = boundedPreviewLines(normalized.text, "start");
      return cleanPreviewBlock({
        bodyLines: preview.lines.length > 0
          ? preview.lines
          : normalized.path
            ? [`wrote ${normalized.path}`]
            : undefined,
        warnings: summarizeWarnings(extractWarnings(record)),
        truncated: preview.truncated || hasExplicitTruncation(record),
      });
    }
    case "grep":
    case "find":
    case "ls": {
      const preview = boundedListPreviewLines(normalized.lines);
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

  if (normalized.text) {
    const preview = boundedPreviewLines(normalized.text, "start");
    return cleanPreviewBlock({
      bodyLines: preview.lines,
      warnings: summarizeWarnings(extractWarnings(record)),
      truncated: preview.truncated || hasExplicitTruncation(record),
    });
  }

  const listPreview = boundedListPreviewLines(normalized.lines);
  if (listPreview) {
    return cleanPreviewBlock({
      bodyLines: listPreview.lines,
      warnings: summarizeWarnings(extractWarnings(record)),
      truncated: listPreview.truncated || hasExplicitTruncation(record),
    });
  }

  const run = record?.run;
  if (isRunRef(run)) {
    return { bodyLines: [`stored result in ${run.runId}`] };
  }

  const dataRef = asRecord(record?.dataRef);
  if (dataRef && isRunRef(dataRef.run) && typeof dataRef.path === "string") {
    return { bodyLines: [summarizeInline(`stored ref ${dataRef.path}`, MAX_PREVIEW_LINE_LENGTH)] };
  }

  if (normalized.path) {
    return { bodyLines: [summarizeInline(normalized.path, MAX_PREVIEW_LINE_LENGTH)] };
  }

  return buildSummaryPreviewBlock(summarizeUnknown(rawOutput, MAX_HEADER_LENGTH));
}

function summarizeToolError(rawOutput: unknown): ToolPreviewBlock | undefined {
  const record = asRecord(rawOutput);
  const explicit = normalizeToolPreviewBlock(
    record?.errorPreview ?? record?.error_preview,
    buildSummaryPreviewBlock(record?.errorSummary ?? record?.error_summary),
  );
  if (explicit) {
    return explicit;
  }

  const errorText = extractToolErrorText(rawOutput);
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

  const headerText = firstString(record.header);
  const header = headerText ? summarizeInline(headerText, MAX_HEADER_LENGTH) : undefined;
  const bodyText = firstString(record.body, record.text, record.content);
  const bodyLines = Array.isArray(record.bodyLines)
    ? normalizePreviewLines(record.bodyLines)
    : Array.isArray(record.body_lines)
      ? normalizePreviewLines(record.body_lines)
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

function buildSummaryPreviewBlock(value: unknown): ToolPreviewBlock | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const summary = summarizeInline(value, MAX_HEADER_LENGTH);
  return summary ? { bodyLines: [summary] } : undefined;
}

function extractWarnings(record: Record<string, unknown> | undefined): string[] {
  if (!record) {
    return [];
  }

  const warnings: string[] = [];
  const explicitWarnings = Array.isArray(record.warnings) ? normalizePreviewLines(record.warnings) : [];
  warnings.push(...explicitWarnings);

  if (record.truncated === true || record.isTruncated === true || record.is_truncated === true) {
    warnings.push("output truncated");
  }

  const fullOutputPath = firstString(
    record.fullOutputPath,
    record.full_output_path,
    record.truncatedOutputPath,
    record.truncated_output_path,
    record.outputPath,
    record.output_path,
    record.savedPath,
    record.savedTo,
    record.saved_to,
    record.logFile,
    record.log_file,
  );
  if (fullOutputPath) {
    warnings.push(`full output: ${fullOutputPath}`);
  }

  const notice = firstString(
    record.notice,
    record.warning,
    record.warningMessage,
    record.warning_message,
    record.truncationNotice,
    record.truncation_notice,
  );
  if (notice) {
    warnings.push(notice);
  }

  return warnings;
}

function hasPreviewTruncation(text: string | undefined, record: Record<string, unknown> | undefined): boolean {
  return boundedPreviewLines(text, "end").truncated || hasExplicitTruncation(record);
}

function hasExplicitTruncation(record: Record<string, unknown> | undefined): boolean {
  return record?.truncated === true || record?.isTruncated === true || record?.is_truncated === true;
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

  if (typeof value === "bigint" || typeof value === "symbol") {
    return String(value);
  }

  if (typeof value === "function") {
    return summarizeInline(Object.prototype.toString.call(value), maxLength);
  }

  try {
    return summarizeInline(JSON.stringify(value), maxLength);
  } catch {
    return summarizeInline(Object.prototype.toString.call(value), maxLength);
  }
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

function isRunRef(value: unknown): value is { sessionId: string; runId: string } {
  const record = asRecord(value);
  return record !== undefined && typeof record.sessionId === "string" && typeof record.runId === "string";
}

import { summarizeText } from "./session-store.ts";

const MAX_INPUT_SUMMARY_LENGTH = 140;
const MAX_OUTPUT_SUMMARY_LENGTH = 220;
const MAX_ERROR_SUMMARY_LENGTH = 180;

interface ToolIdentity {
  title?: string;
  kind?: string;
}

interface ToolPreviewFields {
  inputSummary?: string;
  outputSummary?: string;
  errorSummary?: string;
  durationMs?: number;
}

export function summarizeToolCallStart(
  identity: ToolIdentity,
  rawInput: unknown,
): Pick<ToolPreviewFields, "inputSummary"> {
  return {
    inputSummary: summarizeToolInput(identity, rawInput),
  };
}

export function summarizeToolCallUpdate(
  identity: ToolIdentity,
  rawOutput: unknown,
): Pick<ToolPreviewFields, "outputSummary" | "errorSummary" | "durationMs"> {
  const record = asRecord(rawOutput);
  const durationMs = typeof record?.durationMs === "number" ? record.durationMs : undefined;
  const explicitErrorSummary = summarizeBounded(record?.errorSummary, MAX_ERROR_SUMMARY_LENGTH);
  const explicitOutputSummary = summarizeBounded(record?.outputSummary, MAX_OUTPUT_SUMMARY_LENGTH);

  if (explicitErrorSummary || explicitOutputSummary) {
    return {
      outputSummary: explicitOutputSummary,
      errorSummary: explicitErrorSummary,
      durationMs,
    };
  }

  const errorSummary = summarizeToolError(rawOutput);
  if (errorSummary) {
    return {
      errorSummary,
      durationMs,
    };
  }

  return {
    outputSummary: summarizeToolOutput(identity, rawOutput),
    durationMs,
  };
}

export function compactToolCallInput(identity: ToolIdentity, rawInput: unknown): unknown {
  const inputSummary = summarizeToolInput(identity, rawInput);
  return inputSummary ? { inputSummary } : undefined;
}

export function compactToolCallOutput(identity: ToolIdentity, rawOutput: unknown): unknown {
  if (rawOutput === undefined) {
    return undefined;
  }

  const preview = summarizeToolCallUpdate(identity, rawOutput);
  const record = asRecord(rawOutput);

  return cleanObject({
    ...(preview.outputSummary ? { outputSummary: preview.outputSummary } : {}),
    ...(preview.errorSummary ? { errorSummary: preview.errorSummary } : {}),
    ...(preview.durationMs !== undefined ? { durationMs: preview.durationMs } : {}),
    ...(record && typeof record.tokenUsage === "object" ? { tokenUsage: record.tokenUsage } : {}),
    ...(record && typeof record.tokenSnapshot === "object" ? { tokenSnapshot: record.tokenSnapshot } : {}),
  });
}

function summarizeToolInput(identity: ToolIdentity, rawInput: unknown): string | undefined {
  const record = asRecord(rawInput);
  const explicit = summarizeBounded(record?.inputSummary ?? record?.preview, MAX_INPUT_SUMMARY_LENGTH);
  if (explicit) {
    return explicit;
  }

  const toolName = normalizeToolName(identity);
  switch (toolName) {
    case "bash": {
      const command = firstString(record?.command, record?.cmd, rawInput);
      return summarizeBounded(command, MAX_INPUT_SUMMARY_LENGTH);
    }
    case "read":
    case "write":
    case "find":
    case "ls": {
      const path = firstString(record?.path, record?.filePath, record?.dir, record?.cwd);
      if (path) {
        return summarizeBounded(path, MAX_INPUT_SUMMARY_LENGTH);
      }
      break;
    }
    case "edit": {
      const path = firstString(record?.path, record?.filePath);
      const edits = Array.isArray(record?.edits) ? record.edits.length : undefined;
      if (path && edits !== undefined) {
        return summarizeBounded(`${path} (${edits} edit${edits === 1 ? "" : "s"})`, MAX_INPUT_SUMMARY_LENGTH);
      }
      if (path) {
        return summarizeBounded(path, MAX_INPUT_SUMMARY_LENGTH);
      }
      break;
    }
    case "grep": {
      const pattern = firstString(record?.pattern, record?.query);
      const path = firstString(record?.path, record?.cwd);
      if (pattern && path) {
        return summarizeBounded(`${pattern} @ ${path}`, MAX_INPUT_SUMMARY_LENGTH);
      }
      if (pattern) {
        return summarizeBounded(pattern, MAX_INPUT_SUMMARY_LENGTH);
      }
      break;
    }
  }

  const prompt = firstString(record?.prompt, record?.text, rawInput);
  if (prompt) {
    return summarizeBounded(prompt, MAX_INPUT_SUMMARY_LENGTH);
  }

  const path = firstString(record?.path, record?.filePath);
  if (path) {
    return summarizeBounded(path, MAX_INPUT_SUMMARY_LENGTH);
  }

  return summarizeUnknown(rawInput, MAX_INPUT_SUMMARY_LENGTH);
}

function summarizeToolOutput(identity: ToolIdentity, rawOutput: unknown): string | undefined {
  const record = asRecord(rawOutput);
  const explicit = summarizeBounded(record?.preview, MAX_OUTPUT_SUMMARY_LENGTH);
  if (explicit) {
    return explicit;
  }

  const toolName = normalizeToolName(identity);
  switch (toolName) {
    case "bash": {
      const output = firstString(record?.stdout, record?.stderr, record?.text, record?.content);
      if (output) {
        return summarizeBounded(output, MAX_OUTPUT_SUMMARY_LENGTH);
      }
      break;
    }
    case "read": {
      const contents = extractTextLikeContent(rawOutput);
      if (contents) {
        return summarizeBounded(contents, MAX_OUTPUT_SUMMARY_LENGTH);
      }
      break;
    }
    case "write":
    case "edit": {
      const path = firstString(record?.path, record?.filePath);
      if (path) {
        return summarizeBounded(path, MAX_OUTPUT_SUMMARY_LENGTH);
      }
      break;
    }
  }

  const textLike = extractTextLikeContent(rawOutput);
  if (textLike) {
    return summarizeBounded(textLike, MAX_OUTPUT_SUMMARY_LENGTH);
  }

  const cell = record?.cell;
  if (isCellRef(cell)) {
    return `stored result in ${cell.cellId}`;
  }

  const dataRef = asRecord(record?.dataRef);
  if (isCellRef(dataRef?.cell) && typeof dataRef?.path === "string") {
    return summarizeBounded(`stored ref ${dataRef.path}`, MAX_OUTPUT_SUMMARY_LENGTH);
  }

  const path = firstString(record?.path, record?.filePath);
  if (path) {
    return summarizeBounded(path, MAX_OUTPUT_SUMMARY_LENGTH);
  }

  return summarizeUnknown(rawOutput, MAX_OUTPUT_SUMMARY_LENGTH);
}

function summarizeToolError(rawOutput: unknown): string | undefined {
  const record = asRecord(rawOutput);
  const error = firstString(record?.error, record?.message, record?.stderr);
  return summarizeBounded(error, MAX_ERROR_SUMMARY_LENGTH);
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
    return summarizeUnknown(structuredContent, MAX_OUTPUT_SUMMARY_LENGTH);
  }

  return undefined;
}

function summarizeUnknown(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string") {
    return summarizeBounded(value, maxLength);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  try {
    return summarizeBounded(JSON.stringify(value), maxLength);
  } catch {
    return summarizeBounded(String(value), maxLength);
  }
}

function summarizeBounded(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const compact = stripAnsi(value).replace(/\s+/g, " ").trim();
  if (!compact) {
    return undefined;
  }

  return summarizeText(compact, maxLength);
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

  if (title.startsWith("callagent") || title.startsWith("defaultsession:")) {
    return "agent";
  }

  return title.split(/[\s:(\[]/, 1)[0] || undefined;
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

function isCellRef(value: unknown): value is { sessionId: string; cellId: string } {
  const record = asRecord(value);
  return typeof record?.sessionId === "string" && typeof record?.cellId === "string";
}

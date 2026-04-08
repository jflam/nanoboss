export interface ToolPayloadIdentity {
  title?: string;
  kind?: string;
}

export interface NormalizedToolPayload {
  toolName?: string;
  header?: string;
  text?: string;
  lines?: string[];
  path?: string;
}

const MAX_FALLBACK_JSON_LENGTH = 200_000;

export function normalizeToolName(identity: ToolPayloadIdentity): string | undefined {
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

  const firstToken = title.split(/[[\s:(]/, 1)[0] || "";
  const lastSegment = firstToken.split(".").at(-1);
  return lastSegment || firstToken || undefined;
}

export function normalizeToolInputPayload(identity: ToolPayloadIdentity, rawInput: unknown): NormalizedToolPayload {
  const toolName = normalizeToolName(identity);
  const record = asRecord(rawInput);

  switch (toolName) {
    case "bash": {
      const command = firstString(record?.command, record?.cmd, rawInput);
      return {
        toolName,
        header: command ? `$ ${command}` : undefined,
      };
    }
    case "read": {
      const path = extractPathLike(record);
      return {
        toolName,
        header: path ? `read ${path}${formatLineRange(record)}` : undefined,
        path,
      };
    }
    case "write":
    case "edit": {
      const path = extractPathLike(record);
      return {
        toolName,
        header: path ? `${toolName} ${path}` : undefined,
        text: toolName === "write" ? extractTextLikeContent(record?.content ?? record?.text ?? rawInput) : undefined,
        path,
      };
    }
    case "grep": {
      const pattern = firstString(record?.pattern, record?.query);
      const path = firstString(record?.path, extractPathLike(record), record?.cwd);
      return {
        toolName,
        header: pattern || path
          ? path
            ? `grep ${pattern ?? ""} @ ${path}`
            : `grep ${pattern ?? path}`
          : undefined,
        path,
      };
    }
    case "find": {
      const query = firstString(record?.query, record?.pattern, record?.name);
      const path = firstString(record?.path, extractPathLike(record), record?.cwd, record?.dir);
      return {
        toolName,
        header: query || path
          ? path && query
            ? `find ${query} @ ${path}`
            : `find ${query ?? path}`
          : undefined,
        path,
      };
    }
    case "ls": {
      const path = firstString(extractPathLike(record), record?.dir, record?.cwd);
      return {
        toolName,
        header: path ? `ls ${path}` : undefined,
        path,
      };
    }
    default:
      return {
        toolName,
        text: firstString(record?.prompt, record?.text, rawInput),
        path: extractPathLike(record),
      };
  }
}

export function normalizeToolResultPayload(identity: ToolPayloadIdentity, rawOutput: unknown): NormalizedToolPayload {
  const toolName = normalizeToolName(identity);
  const record = asRecord(rawOutput);

  switch (toolName) {
    case "bash":
      return {
        toolName,
        text: firstString(record?.stdout, record?.stderr, record?.text, record?.content),
        path: extractPathLike(record),
      };
    case "read":
    case "write":
      return {
        toolName,
        text: extractTextLikeContent(rawOutput),
        path: extractPathLike(record),
      };
    case "edit":
      return {
        toolName,
        text: firstString(record?.diff, record?.patch, record?.text, record?.content),
        path: extractPathLike(record),
      };
    case "grep":
    case "find":
    case "ls":
      return {
        toolName,
        lines: extractListLikeLines(rawOutput),
        text: extractTextLikeContent(rawOutput),
        path: extractPathLike(record),
      };
    default:
      return {
        toolName,
        lines: extractListLikeLines(rawOutput),
        text: extractTextLikeContent(rawOutput),
        path: extractPathLike(record),
      };
  }
}

export function extractToolErrorText(rawOutput: unknown): string | undefined {
  const record = asRecord(rawOutput);
  return firstString(record?.error, record?.error_message, record?.message, record?.stderr);
}

export function extractListLikeLines(value: unknown): string[] {
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
      .map((entry) => formatListEntry(entry))
      .filter((entry): entry is string => Boolean(entry));
    if (lines.length > 0) {
      return lines;
    }
  }

  return [];
}

export function extractTextLikeContent(value: unknown): string | undefined {
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
    ...nestedRecords.flatMap((item) => item ? [
      item.text,
      item.content,
      item.detailedContent,
      item.stdout,
      item.stderr,
    ] : []),
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
  return structuredContent === undefined ? undefined : stringifyValue(structuredContent);
}

export function formatLineRange(record: Record<string, unknown> | undefined): string {
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

export function extractPathLike(record: Record<string, unknown> | undefined): string | undefined {
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

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return undefined;
}

export function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

export function stringifyValue(value: unknown): string | undefined {
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

function firstDefined<T>(...values: (T | undefined)[]): T | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function formatListEntry(entry: unknown): string | undefined {
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

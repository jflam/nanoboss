import type { CellRef, JsonValue, ValueRef } from "./types.ts";

const MAX_DEPTH = 4;
const MAX_OBJECT_KEYS = 12;
const MAX_ARRAY_ITEMS = 3;
const MAX_LITERAL_LENGTH = 24;

export function inferDataShape(value: unknown, depth = 0): JsonValue {
  if (isCellRef(value)) {
    return "CellRef";
  }

  if (isValueRef(value)) {
    return "ValueRef";
  }

  if (value === null) {
    return "null";
  }

  if (typeof value === "boolean") {
    return "boolean";
  }

  if (typeof value === "number") {
    return "number";
  }

  if (typeof value === "string") {
    return inferStringShape(value);
  }

  if (depth >= MAX_DEPTH) {
    return Array.isArray(value) ? ["…"] : { "…": "…" };
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [];
    }

    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => inferDataShape(item, depth + 1));
  }

  if (typeof value === "object") {
    const entries = Object.entries(value)
      .slice(0, MAX_OBJECT_KEYS)
      .map(([key, nestedValue]) => [key, inferDataShape(nestedValue, depth + 1)] as const);

    const shape: Record<string, JsonValue> = Object.fromEntries(entries);
    if (Object.keys(value).length > MAX_OBJECT_KEYS) {
      shape["…"] = "…";
    }
    return shape;
  }

  return typeof value;
}

export function stringifyCompactShape(value: JsonValue | undefined, maxLength = 240): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const serialized = JSON.stringify(value);
  if (serialized.length <= maxLength) {
    return serialized;
  }

  return `${serialized.slice(0, maxLength - 3)}...`;
}

function inferStringShape(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length > 0 &&
    trimmed.length <= MAX_LITERAL_LENGTH &&
    !/\s/.test(trimmed)
  ) {
    return trimmed;
  }

  return "string";
}

function isCellRef(value: unknown): value is CellRef {
  return (
    typeof value === "object" &&
    value !== null &&
    "sessionId" in value &&
    typeof (value as { sessionId: unknown }).sessionId === "string" &&
    "cellId" in value &&
    typeof (value as { cellId: unknown }).cellId === "string"
  );
}

function isValueRef(value: unknown): value is ValueRef {
  return (
    typeof value === "object" &&
    value !== null &&
    "cell" in value &&
    typeof (value as { cell: unknown }).cell === "object" &&
    (value as { cell: unknown }).cell !== null &&
    "path" in value &&
    typeof (value as { path: unknown }).path === "string"
  );
}

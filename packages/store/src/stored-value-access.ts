interface CellRefLike {
  sessionId: string;
  cellId: string;
}

interface ValueRefLike {
  cell: CellRefLike;
  path: string;
}

export function getValueAtPath(root: unknown, path: string): unknown {
  if (!path.trim()) {
    return root;
  }

  return path.split(".").reduce((current, segment) => {
    if (current === null || current === undefined) {
      throw new Error(`Invalid ref path: ${path}`);
    }

    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new Error(`Invalid ref path: ${path}`);
      }
      return current[index];
    }

    if (typeof current !== "object") {
      throw new Error(`Invalid ref path: ${path}`);
    }

    const value = (current as Record<string, unknown>)[segment];
    if (value === undefined) {
      throw new Error(`Invalid ref path: ${path}`);
    }
    return value;
  }, root);
}

export function inferType(value: unknown): string {
  if (isCellRef(value)) {
    return "cell_ref";
  }

  if (isValueRef(value)) {
    return "value_ref";
  }

  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  return typeof value;
}

export function buildPreview(value: unknown): string | undefined {
  const serialized = serializeValue(value).replace(/\s+/g, " ").trim();
  if (!serialized) {
    return undefined;
  }

  return serialized.length > 120 ? `${serialized.slice(0, 117)}...` : serialized;
}

export function serializeValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function materializeForFile(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  const serialized = JSON.stringify(value, null, 2);
  return serialized.endsWith("\n") ? serialized : `${serialized}\n`;
}

function isCellRef(value: unknown): value is CellRefLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "sessionId" in value &&
    typeof (value as { sessionId: unknown }).sessionId === "string" &&
    "cellId" in value &&
    typeof (value as { cellId: unknown }).cellId === "string"
  );
}

function isValueRef(value: unknown): value is ValueRefLike {
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

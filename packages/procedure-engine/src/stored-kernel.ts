import type { KernelValue } from "@nanoboss/procedure-sdk";

export function publicKernelValueFromStored(value: unknown): KernelValue | undefined {
  if (value === undefined || value === null) {
    return value;
  }

  if (isStoredValueRefLike(value)) {
    return {
      run: storedRunRefFromCellRef(value.cell),
      path: value.path,
    };
  }

  if (isStoredCellRefLike(value)) {
    return storedRunRefFromCellRef(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => publicKernelValueFromStored(entry) as KernelValue);
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, publicKernelValueFromStored(entry as KernelValue)]),
    );
  }

  return value;
}

function storedRunRefFromCellRef(value: { sessionId: string; cellId: string }) {
  return {
    sessionId: value.sessionId,
    runId: value.cellId,
  };
}

function isStoredCellRefLike(value: unknown): value is { sessionId: string; cellId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { sessionId?: unknown }).sessionId === "string" &&
    typeof (value as { cellId?: unknown }).cellId === "string" &&
    !("path" in (value as object))
  );
}

function isStoredValueRefLike(value: unknown): value is {
  cell: { sessionId: string; cellId: string };
  path: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { path?: unknown }).path === "string" &&
    isStoredCellRefLike((value as { cell?: unknown }).cell)
  );
}

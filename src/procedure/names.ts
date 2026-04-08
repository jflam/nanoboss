export function normalizeProcedureName(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    throw new Error("Procedure name was empty");
  }

  const segments = trimmed
    .split(/\/+/)
    .map((segment) => normalizeProcedureNameSegment(segment));

  return segments.join("/");
}

export function resolveProcedureEntryRelativePath(name: string): string {
  const segments = normalizeProcedureName(name).split("/");
  const leaf = segments.pop();
  if (!leaf) {
    throw new Error("Procedure name was empty");
  }

  return segments.length === 0 ? `${leaf}.ts` : `${segments.join("/")}/${leaf}.ts`;
}

export function resolveProcedureImportPrefix(name: string): string {
  return "../".repeat(normalizeProcedureName(name).split("/").length);
}

function normalizeProcedureNameSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  if (!sanitized) {
    throw new Error(`Procedure name segment was invalid: ${value}`);
  }

  return sanitized;
}

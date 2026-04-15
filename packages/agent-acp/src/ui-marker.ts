export const PROCEDURE_UI_MARKER_PREFIX = "[[nanoboss-ui]] ";

export function parseProcedureUiMarker(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith(PROCEDURE_UI_MARKER_PREFIX)) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed.slice(PROCEDURE_UI_MARKER_PREFIX.length));
  } catch {
    return undefined;
  }
}

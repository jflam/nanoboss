export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (
    typeof error === "object"
    && error !== null
    && "message" in error
    && typeof (error as { message?: unknown }).message === "string"
    && (error as { message: string }).message.trim().length > 0
  ) {
    return (error as { message: string }).message;
  }

  if (typeof error === "object" && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      // Fall through to String(error).
    }
  }

  return String(error);
}

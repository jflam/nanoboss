export type RunCancellationReason = "soft_stop" | "abort";

export class RunCancelledError extends Error {
  constructor(
    message = defaultCancellationMessage("soft_stop"),
    readonly reason: RunCancellationReason = "soft_stop",
  ) {
    super(message);
    this.name = "RunCancelledError";
  }
}

export function defaultCancellationMessage(reason: RunCancellationReason): string {
  return reason === "soft_stop" ? "Stopped." : "Cancelled.";
}

export function normalizeRunCancelledError(
  error: unknown,
  reason: RunCancellationReason = "abort",
): RunCancelledError | undefined {
  if (error instanceof RunCancelledError) {
    return error;
  }

  if (error instanceof Error && error.name === "AbortError") {
    return new RunCancelledError(defaultCancellationMessage(reason), reason);
  }

  return undefined;
}

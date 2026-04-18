export type RunCancellationReason = "soft_stop" | "abort";

type CancellationSignals = {
  signal?: AbortSignal;
  softStopSignal?: AbortSignal;
};

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

  if (isRunCancelledErrorLike(error)) {
    return new RunCancelledError(
      error.message || defaultCancellationMessage(error.reason ?? reason),
      error.reason ?? reason,
    );
  }

  if (error instanceof Error && error.name === "AbortError") {
    return new RunCancelledError(defaultCancellationMessage(reason), reason);
  }

  return undefined;
}

export function toCancelledError(
  error: unknown,
  signals: CancellationSignals,
): RunCancelledError | undefined {
  return normalizeRunCancelledError(error, resolveCancellationReason(signals) ?? "abort");
}

export function throwIfCancelled(
  signals: CancellationSignals,
): void {
  const reason = resolveCancellationReason(signals);
  if (!reason) {
    return;
  }

  throw new RunCancelledError(defaultCancellationMessage(reason), reason);
}

function resolveCancellationReason(
  signals: CancellationSignals,
): RunCancellationReason | undefined {
  if (signals.softStopSignal?.aborted) {
    return "soft_stop";
  }

  if (signals.signal?.aborted) {
    return "abort";
  }

  return undefined;
}

function isRunCancelledErrorLike(error: unknown): error is Error & {
  reason?: RunCancellationReason;
} {
  if (
    !(error instanceof Error) ||
    (error.name !== "RunCancelledError" && error.name !== "ProcedureCancelledError")
  ) {
    return false;
  }

  const candidate = error as Error & { reason?: RunCancellationReason };
  return (
    candidate.reason === undefined ||
    candidate.reason === "soft_stop" ||
    candidate.reason === "abort"
  );
}

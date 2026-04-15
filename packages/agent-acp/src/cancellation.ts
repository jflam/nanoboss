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

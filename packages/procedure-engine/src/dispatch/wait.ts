const DEFAULT_WAIT_MS = 1_000;
const MAX_WAIT_MS = 2_000;

export const PROCEDURE_DISPATCH_WAIT_POLL_MS = 100;

export function clampProcedureDispatchWaitMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_WAIT_MS;
  }

  return Math.min(Math.max(Math.floor(value), 1), MAX_WAIT_MS);
}

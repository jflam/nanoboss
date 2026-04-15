import type { StoredRunResult } from "@nanoboss/store";
import type { KernelValue, RunResult } from "@nanoboss/procedure-sdk";

export function toPublicRunResult<T extends KernelValue>(
  result: StoredRunResult<T>,
): RunResult<T> {
  return {
    run: result.run,
    data: result.data,
    dataRef: result.dataRef,
    displayRef: result.displayRef,
    streamRef: result.streamRef,
    pause: result.pause,
    pauseRef: result.pauseRef,
    summary: result.summary,
    rawRef: result.rawRef,
  };
}

import { describe, expect, test } from "bun:test";

import {
  RunCancelledError,
  expectData,
  expectDataRef,
  formatErrorMessage,
  normalizeRunCancelledError,
  type RunResult,
} from "@nanoboss/procedure-sdk";

describe("result and failure helpers", () => {
  test("expectData and expectDataRef preserve valid falsy payloads and fail when absent", () => {
    const result: RunResult<0> = {
      run: {
        sessionId: "session-1",
        runId: "run-1",
      },
      data: 0,
      dataRef: {
        run: {
          sessionId: "session-1",
          runId: "run-1",
        },
        path: "output.data",
      },
    };

    expect(expectData(result)).toBe(0);
    expect(expectDataRef(result)).toEqual(result.dataRef);
    expect(() => expectData({
      run: result.run,
    })).toThrow("Missing result data");
    expect(() => expectDataRef({
      run: result.run,
    })).toThrow("Missing result data ref");
  });

  test("normalizeRunCancelledError bridges aborts and foreign cancellation errors into the sdk type", () => {
    const foreignCancellation = Object.assign(new Error("Stopped."), {
      name: "TopLevelProcedureCancelledError",
      reason: "soft_stop" as const,
    });
    const normalizedForeign = normalizeRunCancelledError(foreignCancellation);

    expect(normalizedForeign).toBeInstanceOf(RunCancelledError);
    expect(normalizedForeign?.reason).toBe("soft_stop");
    expect(normalizedForeign?.message).toBe("Stopped.");

    const normalizedAbort = normalizeRunCancelledError(new DOMException("aborted", "AbortError"));
    expect(normalizedAbort).toBeInstanceOf(RunCancelledError);
    expect(normalizedAbort?.reason).toBe("abort");
    expect(normalizedAbort?.message).toBe("Cancelled.");
  });

  test("formatErrorMessage extracts useful text from structured failures", () => {
    expect(formatErrorMessage({ message: "structured failure" })).toBe("structured failure");
    expect(formatErrorMessage({ code: "E_FAIL" })).toBe("{\"code\":\"E_FAIL\"}");
  });
});

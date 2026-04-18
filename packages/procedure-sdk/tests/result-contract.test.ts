import { describe, expect, test } from "bun:test";

import {
  RunCancelledError,
  defaultCancellationMessage,
  expectData,
  expectDataRef,
  formatErrorMessage,
  normalizeRunCancelledError,
  throwIfCancelled,
  toCancelledError,
  type RunResult,
} from "@nanoboss/procedure-sdk";

describe("result and failure helpers", () => {
  test("expectData and expectDataRef preserve valid falsy payloads and fail when absent", () => {
    const result = {
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
    } satisfies RunResult<0>;

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
      name: "ProcedureCancelledError",
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

  test("normalizeRunCancelledError preserves sdk cancellations and falls back to default messages only for recognized reasons", () => {
    const existing = new RunCancelledError("Stopped manually.", "soft_stop");
    expect(normalizeRunCancelledError(existing)).toBe(existing);

    const foreignWithoutMessage = Object.assign(new Error(""), {
      name: "RunCancelledError",
    });
    const normalizedFallback = normalizeRunCancelledError(foreignWithoutMessage, "soft_stop");

    expect(normalizedFallback).toBeInstanceOf(RunCancelledError);
    expect(normalizedFallback?.reason).toBe("soft_stop");
    expect(normalizedFallback?.message).toBe(defaultCancellationMessage("soft_stop"));

    const invalidForeignReason = Object.assign(new Error("weird"), {
      name: "RunCancelledError",
      reason: "timeout",
    });
    expect(normalizeRunCancelledError(invalidForeignReason)).toBeUndefined();
  });

  test("toCancelledError resolves the cancellation reason from signals before normalizing", () => {
    const abort = new AbortController();
    const softStop = new AbortController();
    abort.abort();
    softStop.abort();

    const normalizedSoftStop = toCancelledError(new DOMException("aborted", "AbortError"), {
      signal: abort.signal,
      softStopSignal: softStop.signal,
    });
    expect(normalizedSoftStop).toBeInstanceOf(RunCancelledError);
    expect(normalizedSoftStop?.reason).toBe("soft_stop");
    expect(normalizedSoftStop?.message).toBe(defaultCancellationMessage("soft_stop"));

    const normalizedAbort = toCancelledError(new DOMException("aborted", "AbortError"), {
      signal: abort.signal,
    });
    expect(normalizedAbort).toBeInstanceOf(RunCancelledError);
    expect(normalizedAbort?.reason).toBe("abort");
    expect(normalizedAbort?.message).toBe(defaultCancellationMessage("abort"));
  });

  test("throwIfCancelled throws the resolved sdk cancellation error", () => {
    const abort = new AbortController();
    abort.abort();
    expect(() => {
      try {
        throwIfCancelled({ signal: abort.signal });
      } catch (error) {
        expect(error).toBeInstanceOf(RunCancelledError);
        if (error instanceof RunCancelledError) {
          expect(error.reason).toBe("abort");
        }
        throw error;
      }
    }).toThrow("Cancelled.");

    const softStop = new AbortController();
    softStop.abort();
    expect(() => {
      try {
        throwIfCancelled({
          signal: abort.signal,
          softStopSignal: softStop.signal,
        });
      } catch (error) {
        expect(error).toBeInstanceOf(RunCancelledError);
        if (error instanceof RunCancelledError) {
          expect(error.reason).toBe("soft_stop");
        }
        throw error;
      }
    }).toThrow("Stopped.");

    expect(() => throwIfCancelled({})).not.toThrow();
  });

  test("formatErrorMessage extracts useful text from structured failures", () => {
    expect(formatErrorMessage({ message: "structured failure" })).toBe("structured failure");
    expect(formatErrorMessage({ code: "E_FAIL" })).toBe("{\"code\":\"E_FAIL\"}");
  });
});

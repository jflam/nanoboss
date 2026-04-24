import { describe, expect, test } from "bun:test";

import { inferDataShape, stringifyCompactShape } from "@nanoboss/procedure-sdk";

describe("data shape helpers", () => {
  test("infers compact data shapes with bounded literals and references", () => {
    expect(inferDataShape({
      subject: "diff",
      longText: "missing edge-case coverage",
      count: 3,
      ok: true,
      empty: null,
      nested: [{ path: "src/index.ts" }],
      run: { sessionId: "session-1", runId: "run-1" },
      ref: { run: { sessionId: "session-1", runId: "run-1" }, path: "output.data" },
    })).toEqual({
      subject: "diff",
      longText: "string",
      count: "number",
      ok: "boolean",
      empty: "null",
      nested: [{ path: "src/index.ts" }],
      run: "RunRef",
      ref: "Ref",
    });
  });

  test("uses ascii overflow markers and compact string truncation", () => {
    expect(inferDataShape([[[[["deep"]]]]])).toEqual([[[[["..."]]]]]);
    expect(inferDataShape({
      a: 1,
      b: 2,
      c: 3,
      d: 4,
      e: 5,
      f: 6,
      g: 7,
      h: 8,
      i: 9,
      j: 10,
      k: 11,
      l: 12,
      m: 13,
    })).toEqual({
      a: "number",
      b: "number",
      c: "number",
      d: "number",
      e: "number",
      f: "number",
      g: "number",
      h: "number",
      i: "number",
      j: "number",
      k: "number",
      l: "number",
      "...": "...",
    });

    expect(stringifyCompactShape(undefined)).toBeUndefined();
    expect(stringifyCompactShape({ value: "abcdefghijklmnopqrstuvwxyz" }, 20)).toBe("{\"value\":\"abcdefg...");
  });
});

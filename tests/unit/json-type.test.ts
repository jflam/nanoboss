import { describe, expect, test } from "bun:test";

import { jsonType } from "../../src/types.ts";

describe("jsonType", () => {
  test("fails fast when typia transform is unavailable", () => {
    expect(() => jsonType<{ answer: number }>()).toThrow(
      "jsonType<T>() requires typia's compile-time transform",
    );
  });
});

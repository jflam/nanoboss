import { expect, test } from "bun:test";

import { formatErrorMessage } from "@nanoboss/procedure-engine";

test("formats JSON-RPC style error objects using their message", () => {
  expect(formatErrorMessage({
    code: -32602,
    message: "Invalid model 'claude-opus-4.6-fast'.",
  })).toBe("Invalid model 'claude-opus-4.6-fast'.");
});

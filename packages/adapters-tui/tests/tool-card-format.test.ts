import { describe, expect, test } from "bun:test";

import type { UiToolCall } from "../src/state/state.ts";
import {
  formatExpandedToolHeader,
  getExpandedToolInputBlock,
  getExpandedToolResultBlock,
} from "../src/components/tool-card-format.ts";

describe("tool card formatting normalization", () => {
  test("uses the shared normalizer for expanded headers and full content", () => {
    const readCall = toolCall({
      toolName: "read",
      rawInput: {
        location: { path: "src/file.ts" },
        line: 4,
        limit: 2,
      },
    });

    expect(formatExpandedToolHeader(readCall)).toBe("read src/file.ts:4-5");

    const writeCall = toolCall({
      toolName: "write",
      rawInput: {
        path: "src/file.ts",
        content: "hello\nworld",
      },
    });

    expect(getExpandedToolInputBlock(writeCall)).toEqual({
      bodyLines: ["hello", "world"],
    });
  });

  test("uses the shared normalizer for list-like result lines", () => {
    expect(getExpandedToolResultBlock(toolCall({
      toolName: "grep",
      rawOutput: {
        matches: [
          { path: "src/a.ts", line: 2, text: "needle" },
        ],
      },
    }))).toEqual({
      bodyLines: ["src/a.ts:2 needle"],
    });
  });
});

function toolCall(overrides: Partial<UiToolCall>): UiToolCall {
  return {
    id: "tool-1",
    runId: "run-1",
    title: "tool",
    kind: "other",
    status: "completed",
    depth: 0,
    isWrapper: false,
    ...overrides,
  };
}

import { describe, expect, test } from "bun:test";

import {
  summarizeToolCallStart,
  summarizeToolCallUpdate,
} from "../src/tool-call-preview.ts";

describe("tool call preview normalization", () => {
  test("builds read input headers through the shared payload normalizer", () => {
    expect(summarizeToolCallStart({
      toolName: "read",
    }, {
      location: { path: "src/file.ts" },
      line: 4,
      limit: 2,
      warnings: ["cached"],
    })).toEqual({
      callPreview: {
        header: "read src/file.ts:4-5",
        warnings: ["cached"],
      },
    });
  });

  test("builds list result previews through the shared payload normalizer", () => {
    expect(summarizeToolCallUpdate({
      toolName: "grep",
    }, {
      matches: [
        { path: "src/a.ts", line: 2, text: "needle" },
      ],
      duration_ms: 12,
    })).toEqual({
      resultPreview: {
        bodyLines: ["src/a.ts:2 needle"],
      },
      errorPreview: undefined,
      durationMs: 12,
    });
  });
});

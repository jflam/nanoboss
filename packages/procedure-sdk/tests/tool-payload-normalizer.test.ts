import { describe, expect, test } from "bun:test";

import {
  extractPathLike,
  extractToolErrorText,
  normalizeToolInputPayload,
  normalizeToolName,
  normalizeToolResultPayload,
  stringifyValue,
} from "@nanoboss/procedure-sdk";

describe("tool payload normalizer", () => {
  test("normalizes tool identity from explicit names, kinds, and titles", () => {
    expect(normalizeToolName({ toolName: " Bash " })).toBe("bash");
    expect(normalizeToolName({ kind: "read" })).toBe("read");
    expect(normalizeToolName({ title: "Mock grep" })).toBe("grep");
    expect(normalizeToolName({ title: "Calling default session" })).toBe("agent");
    expect(normalizeToolName({ title: "mcp.read(path)" })).toBe("read");
  });

  test("normalizes input headers, text, and paths", () => {
    expect(normalizeToolInputPayload({
      toolName: "read",
    }, {
      location: { path: "src/file.ts" },
      line: 4,
      limit: 2,
    })).toEqual({
      toolName: "read",
      header: "read src/file.ts:4-5",
      path: "src/file.ts",
    });

    expect(normalizeToolInputPayload({
      toolName: "write",
    }, {
      path: "src/file.ts",
      content: "hello",
    })).toEqual({
      toolName: "write",
      header: "write src/file.ts",
      text: "hello",
      path: "src/file.ts",
    });
  });

  test("normalizes result text, list lines, errors, and fallbacks", () => {
    expect(normalizeToolResultPayload({
      toolName: "grep",
    }, {
      matches: [
        { path: "src/a.ts", line: 2, text: "needle" },
      ],
    })).toEqual({
      toolName: "grep",
      lines: ["src/a.ts:2 needle"],
      path: undefined,
      text: undefined,
    });

    expect(normalizeToolResultPayload({
      toolName: "read",
    }, {
      file: { path: "src/a.ts", content: "file text" },
    })).toEqual({
      toolName: "read",
      text: "file text",
      path: "src/a.ts",
    });

    expect(extractToolErrorText({ error_message: "boom", stderr: "ignored" })).toBe("boom");
    expect(extractPathLike({ target: { file_path: "target.ts" } })).toBe("target.ts");
    expect(stringifyValue({ ok: true })).toBe("{\n  \"ok\": true\n}");
  });
});

import { describe, expect, test } from "bun:test";

import { parseSessionPromptRequestBody } from "@nanoboss/adapters-http";

describe("HTTP prompt submission", () => {
  test("rejects empty structured prompt input before accepting the request", () => {
    expect(parseSessionPromptRequestBody({
      promptInput: {
        parts: [
          { type: "text", text: "   " },
        ],
      },
    })).toEqual({
      error: "prompt is required",
    });
  });

  test("accepts non-empty structured prompt input", () => {
    expect(parseSessionPromptRequestBody({
      promptInput: {
        parts: [
          { type: "text", text: "inspect " },
          {
            type: "image",
            token: "[Image 1: PNG 10x10 1KB]",
            mimeType: "image/png",
            data: "YWJj",
          },
        ],
      },
    })).toEqual({
      prompt: {
        parts: [
          { type: "text", text: "inspect " },
          {
            type: "image",
            token: "[Image 1: PNG 10x10 1KB]",
            mimeType: "image/png",
            data: "YWJj",
          },
        ],
      },
    });
  });
});

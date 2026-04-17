import { describe, expect, test } from "bun:test";

import {
  createTextPromptInput,
  normalizePromptInput,
  parsePromptInputPayload,
  promptInputAttachmentSummaries,
  promptInputDisplayText,
  promptInputToPlainText,
} from "@nanoboss/procedure-sdk";

describe("prompt input helpers", () => {
  test("normalizes image-rich payloads into procedure-facing text and attachment views", () => {
    const parsed = parsePromptInputPayload({
      parts: [
        { type: "text", text: "before " },
        {
          type: "image",
          token: "[Image 1: PNG 10x8 3B]",
          mimeType: "image/png",
          data: "YWJj",
          width: 10,
          height: 8,
          byteLength: 3,
        },
        { type: "text", text: " after" },
      ],
    });

    expect(parsed).toBeDefined();
    if (!parsed) {
      throw new Error("Expected parsed prompt input");
    }

    expect(promptInputDisplayText(parsed)).toBe("before [Image 1: PNG 10x8 3B] after");
    expect(promptInputToPlainText(parsed)).toBe("before  after");
    expect(promptInputAttachmentSummaries(parsed)).toEqual([
      {
        token: "[Image 1: PNG 10x8 3B]",
        mimeType: "image/png",
        width: 10,
        height: 8,
        byteLength: 3,
      },
    ]);
  });

  test("rejects malformed numeric image metadata at the API boundary", () => {
    expect(parsePromptInputPayload({
      parts: [
        {
          type: "image",
          token: "[Image 1: PNG]",
          mimeType: "image/png",
          data: "YWJj",
          width: -1,
        },
      ],
    })).toBeUndefined();

    expect(parsePromptInputPayload({
      parts: [
        {
          type: "image",
          token: "[Image 1: PNG]",
          mimeType: "image/png",
          data: "YWJj",
          height: 3.5,
        },
      ],
    })).toBeUndefined();

    expect(parsePromptInputPayload({
      parts: [
        {
          type: "image",
          token: "[Image 1: PNG]",
          mimeType: "image/png",
          data: "YWJj",
          byteLength: "3",
        },
      ],
    })).toBeUndefined();
  });

  test("createTextPromptInput remains the minimal client entrypoint", () => {
    expect(createTextPromptInput("plain prompt")).toEqual({
      parts: [
        {
          type: "text",
          text: "plain prompt",
        },
      ],
    });
  });

  test("normalizePromptInput merges adjacent text, drops empty text parts, and preserves image placement", () => {
    expect(normalizePromptInput({
      parts: [
        { type: "text", text: "" },
        { type: "text", text: "alpha" },
        { type: "text", text: " beta" },
        {
          type: "image",
          token: "[Image 1: PNG]",
          mimeType: "image/png",
          data: "YWJj",
        },
        { type: "text", text: "" },
        { type: "text", text: " gamma" },
      ],
    })).toEqual({
      parts: [
        { type: "text", text: "alpha beta" },
        {
          type: "image",
          token: "[Image 1: PNG]",
          mimeType: "image/png",
          data: "YWJj",
        },
        { type: "text", text: " gamma" },
      ],
    });

    expect(normalizePromptInput({
      parts: [
        { type: "text", text: "" },
        { type: "text", text: "" },
      ],
    })).toEqual({
      parts: [
        { type: "text", text: "" },
      ],
    });
  });

  test("parsePromptInputPayload applies the same normalization rules used for author-facing prompt input", () => {
    expect(parsePromptInputPayload({
      parts: [
        { type: "text", text: "" },
        { type: "text", text: "alpha" },
        { type: "text", text: " beta" },
        {
          type: "image",
          token: "[Image 1: PNG]",
          mimeType: "image/png",
          data: "YWJj",
        },
        { type: "text", text: "" },
        { type: "text", text: " gamma" },
      ],
    })).toEqual({
      parts: [
        { type: "text", text: "alpha beta" },
        {
          type: "image",
          token: "[Image 1: PNG]",
          mimeType: "image/png",
          data: "YWJj",
        },
        { type: "text", text: " gamma" },
      ],
    });
  });
});

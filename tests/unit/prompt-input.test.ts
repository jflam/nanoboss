import { describe, expect, test } from "bun:test";

import {
  normalizePromptInput,
  promptInputDisplayText,
} from "@nanoboss/procedure-sdk";
import {
  promptInputFromAcpBlocks,
  promptInputToAcpBlocks,
  summarizePromptInputForAcpLog,
} from "@nanoboss/agent-acp";
import {
  attachClipboardImage,
  createComposerState,
  reconcileComposerState,
} from "../../packages/adapters-tui/src/app/composer.ts";
import { buildPromptInputFromComposer } from "../../packages/adapters-tui/src/app/composer-prompt-input.ts";

describe("prompt input helpers", () => {
  test("preserve text-image-text ordering through ACP block conversion", () => {
    const input = normalizePromptInput({
      parts: [
        { type: "text", text: "before " },
        {
          type: "image",
          token: "[Image 1: PNG 10x10 1KB]",
          mimeType: "image/png",
          data: "YWJj",
          width: 10,
          height: 10,
          byteLength: 1024,
        },
        { type: "text", text: " after" },
      ],
    });

    const blocks = promptInputToAcpBlocks(input);
    expect(blocks).toEqual([
      { type: "text", text: "before " },
      { type: "image", mimeType: "image/png", data: "YWJj" },
      { type: "text", text: " after" },
    ]);
    expect(summarizePromptInputForAcpLog(input)).toEqual([
      { type: "text", text: "before " },
      {
        type: "image",
        token: "[Image 1: PNG 10x10 1KB]",
        mimeType: "image/png",
        width: 10,
        height: 10,
        byteLength: 1024,
      },
      { type: "text", text: " after" },
    ]);

    const roundTripped = promptInputFromAcpBlocks(blocks);
    expect(promptInputDisplayText(roundTripped)).toContain("[Image 1: PNG 3B]");
    expect(roundTripped.parts.map((part) => part.type)).toEqual(["text", "image", "text"]);
  });

  test("drops edited tokens back to plain text and removes stale attachments", () => {
    const composer = createComposerState();
    const image = attachClipboardImage(composer, {
      mimeType: "image/png",
      data: "YWJj",
      width: 12,
      height: 8,
      byteLength: 2048,
    });

    const intact = buildPromptInputFromComposer(composer, `look ${image.token} now`);
    expect(intact.parts.map((part) => part.type)).toEqual(["text", "image", "text"]);

    const editedTokenText = `look ${image.token.replace("PNG", "Png")} now`;
    const edited = buildPromptInputFromComposer(composer, editedTokenText);
    expect(edited.parts).toEqual([{ type: "text", text: editedTokenText }]);

    reconcileComposerState(composer, editedTokenText);
    expect(composer.imagesByToken.size).toBe(0);
  });

});

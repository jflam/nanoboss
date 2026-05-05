import { describe, expect, test } from "bun:test";
import { normalizePromptInput } from "@nanoboss/procedure-sdk";

import { prependPromptInputText } from "../src/runtime-prompt.ts";

describe("runtime prompt helpers", () => {
  test("prepends runtime guidance without disturbing prompt input structure", () => {
    const prefixed = prependPromptInputText(normalizePromptInput("final question"), [
      "Runtime guidance",
      "User message:",
    ]);

    expect(prefixed.parts).toEqual([
      {
        type: "text",
        text: "Runtime guidance\n\nUser message:\n\nfinal question",
      },
    ]);
  });
});

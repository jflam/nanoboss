import type { PromptInput, PromptPart } from "@nanoboss/contracts";
import {
  createTextPromptInput,
  normalizePromptInput,
} from "@nanoboss/procedure-sdk";

import type { ComposerState } from "./composer.ts";

export function buildPromptInputFromComposer(state: ComposerState, text: string): PromptInput {
  if (state.imagesByToken.size === 0) {
    return createTextPromptInput(text);
  }

  const parts: PromptPart[] = [];
  const sortedTokens = [...state.imagesByToken.keys()].sort((left, right) => right.length - left.length);
  const usedTokens = new Set<string>();
  let index = 0;
  let textBuffer = "";

  while (index < text.length) {
    const matchedToken = sortedTokens.find((token) => !usedTokens.has(token) && text.startsWith(token, index));
    if (!matchedToken) {
      textBuffer += text[index];
      index += 1;
      continue;
    }

    if (textBuffer.length > 0) {
      parts.push({ type: "text", text: textBuffer });
      textBuffer = "";
    }

    const image = state.imagesByToken.get(matchedToken);
    if (image) {
      parts.push(image);
      usedTokens.add(matchedToken);
      index += matchedToken.length;
      continue;
    }

    textBuffer += text[index];
    index += 1;
  }

  if (textBuffer.length > 0) {
    parts.push({ type: "text", text: textBuffer });
  }

  return normalizePromptInput({ parts });
}

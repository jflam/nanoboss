import {
  normalizePromptInput,
  type PromptPart,
  type PromptInput,
} from "@nanoboss/procedure-sdk";

export function prependPromptInputText(input: PromptInput, blocks: string[]): PromptInput {
  if (blocks.length === 0) {
    return normalizePromptInput(input);
  }

  const prefix = blocks.join("\n\n");
  const prefixedParts: PromptPart[] = prefix.length > 0
    ? [{ type: "text", text: `${prefix}\n\n` }]
    : [];

  return {
    parts: normalizePromptInput({
      parts: [...prefixedParts, ...input.parts],
    }).parts,
  };
}

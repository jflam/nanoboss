import type {
  ProcedurePromptInput,
  PromptInput,
} from "@nanoboss/procedure-sdk";
import {
  normalizePromptInput,
  promptInputAttachmentSummaries,
  promptInputDisplayText,
} from "@nanoboss/procedure-sdk";

export function normalizeProcedurePromptInput(input: string | PromptInput): ProcedurePromptInput {
  const normalized = normalizePromptInput(input);
  return {
    parts: normalized.parts,
    text: promptInputToPlainText(normalized),
    displayText: promptInputDisplayText(normalized),
    images: promptInputAttachmentSummaries(normalized),
  };
}

export function promptInputToPlainText(input: PromptInput): string {
  return input.parts
    .map((part) => part.type === "text" ? part.text : "")
    .join("");
}

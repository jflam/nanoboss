import type {
  ProcedurePromptInput,
  PromptInput,
} from "@nanoboss/procedure-sdk";
import {
  normalizePromptInput,
  promptInputAttachmentSummaries,
  promptInputDisplayText,
  promptInputToPlainText,
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

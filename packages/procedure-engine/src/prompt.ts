import type {
  ProcedurePromptInput,
  PromptImagePart,
  PromptImageSummary,
  PromptInput,
  PromptPart,
} from "@nanoboss/procedure-sdk";

export function createTextPromptInput(text: string): PromptInput {
  return {
    parts: [
      {
        type: "text",
        text,
      },
    ],
  };
}

export function normalizePromptInput(input: string | PromptInput): PromptInput {
  if (typeof input === "string") {
    return createTextPromptInput(input);
  }

  return {
    parts: normalizePromptParts(input.parts),
  };
}

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

export function promptInputDisplayText(input: PromptInput): string {
  return input.parts
    .map((part) => part.type === "text" ? part.text : part.token)
    .join("");
}

export function promptInputAttachmentSummaries(input: PromptInput): PromptImageSummary[] {
  return input.parts
    .filter((part): part is PromptImagePart => part.type === "image")
    .map((part) => ({
      token: part.token,
      mimeType: part.mimeType,
      width: part.width,
      height: part.height,
      byteLength: part.byteLength,
    }));
}

function normalizePromptParts(parts: PromptPart[]): PromptPart[] {
  const normalized: PromptPart[] = [];

  for (const part of parts) {
    if (part.type === "text") {
      if (part.text.length === 0) {
        continue;
      }

      const previous = normalized.at(-1);
      if (previous?.type === "text") {
        previous.text += part.text;
      } else {
        normalized.push({
          type: "text",
          text: part.text,
        });
      }
      continue;
    }

    normalized.push(part);
  }

  return normalized.length > 0 ? normalized : [{ type: "text", text: "" }];
}

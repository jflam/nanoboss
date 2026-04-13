import type * as acp from "@agentclientprotocol/sdk";

import type {
  ProcedurePromptInput,
  PromptImagePart,
  PromptImageSummary,
  PromptInput,
  PromptPart,
} from "./types.ts";

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

export function parsePromptInputPayload(value: unknown): PromptInput | undefined {
  if (!value || typeof value !== "object" || !("parts" in value)) {
    return undefined;
  }

  const rawParts = (value as { parts?: unknown }).parts;
  if (!Array.isArray(rawParts)) {
    return undefined;
  }

  const parts: PromptPart[] = [];
  for (const rawPart of rawParts) {
    if (!rawPart || typeof rawPart !== "object") {
      return undefined;
    }

    const type = (rawPart as { type?: unknown }).type;
    if (type === "text") {
      const text = (rawPart as { text?: unknown }).text;
      if (typeof text !== "string") {
        return undefined;
      }

      parts.push({ type: "text", text });
      continue;
    }

    if (type === "image") {
      const token = (rawPart as { token?: unknown }).token;
      const mimeType = (rawPart as { mimeType?: unknown }).mimeType;
      const data = (rawPart as { data?: unknown }).data;
      if (typeof token !== "string" || typeof mimeType !== "string" || typeof data !== "string") {
        return undefined;
      }

      parts.push({
        type: "image",
        token,
        mimeType,
        data,
        width: asOptionalNumber((rawPart as { width?: unknown }).width),
        height: asOptionalNumber((rawPart as { height?: unknown }).height),
        byteLength: asOptionalNumber((rawPart as { byteLength?: unknown }).byteLength),
      });
      continue;
    }

    return undefined;
  }

  return normalizePromptInput({ parts });
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

export function hasPromptInputImages(input: PromptInput): boolean {
  return input.parts.some((part) => part.type === "image");
}

export function hasPromptInputContent(input: PromptInput): boolean {
  return input.parts.some((part) => part.type === "image" || part.text.trim().length > 0);
}

export function prependPromptInputText(input: PromptInput, blocks: string[]): PromptInput {
  if (blocks.length === 0) {
    return normalizePromptInput(input);
  }

  const prefix = blocks.join("\n\n");
  const prefixedParts: PromptPart[] = prefix.length > 0
    ? [{ type: "text", text: `${prefix}\n\n` }]
    : [];

  return {
    parts: normalizePromptParts([...prefixedParts, ...input.parts]),
  };
}

export function promptInputFromAcpBlocks(blocks: acp.PromptRequest["prompt"]): PromptInput {
  let imageIndex = 0;
  const parts: PromptPart[] = [];

  for (const block of blocks) {
    if (block.type === "text") {
      parts.push({
        type: "text",
        text: block.text,
      });
      continue;
    }

    if (block.type === "image") {
      imageIndex += 1;
      parts.push({
        type: "image",
        token: buildImageTokenLabel({
          index: imageIndex,
          mimeType: block.mimeType,
          byteLength: estimateBase64ByteLength(block.data),
        }),
        mimeType: block.mimeType,
        data: block.data,
        byteLength: estimateBase64ByteLength(block.data),
      });
    }
  }

  return {
    parts: normalizePromptParts(parts),
  };
}

export function promptInputToAcpBlocks(input: PromptInput): acp.ContentBlock[] {
  const blocks: acp.ContentBlock[] = [];

  for (const part of input.parts) {
    if (part.type === "text") {
      if (part.text.length > 0) {
        blocks.push({
          type: "text",
          text: part.text,
        });
      }
      continue;
    }

    blocks.push({
      type: "image",
      mimeType: part.mimeType,
      data: part.data,
    });
  }

  return blocks;
}

export function summarizePromptInputForAcpLog(input: PromptInput): Array<
  | { type: "text"; text: string }
  | {
      type: "image";
      token: string;
      mimeType: string;
      width?: number;
      height?: number;
      byteLength?: number;
    }
> {
  return input.parts.map((part) => {
    if (part.type === "text") {
      return {
        type: "text",
        text: part.text,
      };
    }

    return {
      type: "image",
      token: part.token,
      mimeType: part.mimeType,
      width: part.width,
      height: part.height,
      byteLength: part.byteLength,
    };
  });
}

export function buildImageTokenLabel(params: {
  index: number;
  mimeType: string;
  width?: number;
  height?: number;
  byteLength?: number;
}): string {
  const segments = [`Image ${params.index}:`, formatMimeTypeLabel(params.mimeType)];
  if (params.width && params.height) {
    segments.push(`${params.width}x${params.height}`);
  }
  if (params.byteLength !== undefined) {
    segments.push(formatByteLength(params.byteLength));
  }
  return `[${segments.join(" ")}]`;
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

function estimateBase64ByteLength(data: string): number {
  const trimmed = data.trim();
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(trimmed.length * 3 / 4) - padding);
}

function formatMimeTypeLabel(mimeType: string): string {
  const subtype = mimeType.split("/")[1] ?? mimeType;
  return subtype.replace(/\+.*/, "").toUpperCase();
}

function formatByteLength(byteLength: number): string {
  if (byteLength >= 1024 * 1024) {
    const mb = byteLength / (1024 * 1024);
    return `${Number.isInteger(mb) ? mb.toFixed(0) : mb.toFixed(1)}MB`;
  }

  if (byteLength >= 1024) {
    return `${Math.round(byteLength / 1024)}KB`;
  }

  return `${byteLength}B`;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

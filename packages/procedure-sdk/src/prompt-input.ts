import type {
  PromptImagePart,
  PromptImageSummary,
  PromptInput,
  PromptPart,
} from "@nanoboss/contracts";

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

export function promptInputDisplayText(input: PromptInput): string {
  return input.parts
    .map((part) => part.type === "text" ? part.text : part.token)
    .join("");
}

export function promptInputToPlainText(input: PromptInput): string {
  return input.parts
    .map((part) => part.type === "text" ? part.text : "")
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

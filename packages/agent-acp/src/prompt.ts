import type * as acp from "@agentclientprotocol/sdk";

import {
  buildImageTokenLabel,
  normalizePromptInput,
} from "@nanoboss/procedure-sdk";
import type { PromptInput } from "@nanoboss/contracts";

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

export function promptInputFromAcpBlocks(blocks: acp.PromptRequest["prompt"]): PromptInput {
  let imageIndex = 0;
  const parts: PromptInput["parts"] = [];

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
      const byteLength = estimateBase64ByteLength(block.data);
      parts.push({
        type: "image",
        token: buildImageTokenLabel({
          index: imageIndex,
          mimeType: block.mimeType,
          byteLength,
        }),
        mimeType: block.mimeType,
        data: block.data,
        byteLength,
      });
    }
  }

  return normalizePromptInput({ parts });
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

function estimateBase64ByteLength(data: string): number {
  const trimmed = data.trim();
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(trimmed.length * 3 / 4) - padding);
}

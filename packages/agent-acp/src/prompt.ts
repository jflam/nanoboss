import type * as acp from "@agentclientprotocol/sdk";

import type { PromptInput } from "@nanoboss/contracts";

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

export function hasPromptInputImages(input: PromptInput): boolean {
  return input.parts.some((part) => part.type === "image");
}

export function promptInputDisplayText(input: PromptInput): string {
  return input.parts
    .map((part) => part.type === "text" ? part.text : part.token)
    .join("");
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

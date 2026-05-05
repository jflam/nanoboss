import type { PromptImagePart } from "@nanoboss/contracts";
import { buildImageTokenLabel } from "@nanoboss/procedure-sdk";

export interface ComposerImageRecord extends PromptImagePart {
  imageNumber: number;
}

export interface ComposerState {
  nextImageNumber: number;
  imagesByToken: Map<string, ComposerImageRecord>;
}

export interface ClipboardImage {
  mimeType: string;
  data: string;
  width?: number;
  height?: number;
  byteLength?: number;
}

export function createComposerState(): ComposerState {
  return {
    nextImageNumber: 1,
    imagesByToken: new Map(),
  };
}

export function attachClipboardImage(state: ComposerState, image: ClipboardImage): ComposerImageRecord {
  const imageNumber = state.nextImageNumber;
  const token = buildImageTokenLabel({
    index: imageNumber,
    mimeType: image.mimeType,
    width: image.width,
    height: image.height,
    byteLength: image.byteLength,
  });
  const record: ComposerImageRecord = {
    type: "image",
    imageNumber,
    token,
    mimeType: image.mimeType,
    data: image.data,
    width: image.width,
    height: image.height,
    byteLength: image.byteLength,
  };

  state.nextImageNumber += 1;
  state.imagesByToken.set(token, record);
  return record;
}

export function clearComposerState(state: ComposerState): void {
  state.imagesByToken.clear();
}

export function reconcileComposerState(state: ComposerState, text: string): void {
  for (const [token] of state.imagesByToken) {
    if (!text.includes(token)) {
      state.imagesByToken.delete(token);
    }
  }
}

export function findImageTokenRangeAtCursor(
  state: ComposerState,
  text: string,
  cursorIndex: number,
  direction: "backspace" | "delete",
): { token: string; start: number; end: number } | undefined {
  for (const token of state.imagesByToken.keys()) {
    let start = text.indexOf(token);
    while (start >= 0) {
      const end = start + token.length;
      const matches = direction === "backspace"
        ? cursorIndex > start && cursorIndex <= end
        : cursorIndex >= start && cursorIndex < end;
      if (matches) {
        return { token, start, end };
      }
      start = text.indexOf(token, start + 1);
    }
  }

  return undefined;
}

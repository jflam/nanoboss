import type { ClipboardImageProvider } from "./provider.ts";

export function createUnsupportedClipboardImageProvider(): ClipboardImageProvider {
  return {
    async readImage() {
      return undefined;
    },
  };
}

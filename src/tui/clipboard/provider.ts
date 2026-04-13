import type { ClipboardImage } from "../composer.ts";

import { createDarwinClipboardImageProvider } from "./darwin.ts";
import { createLinuxClipboardImageProvider } from "./linux.ts";
import { createUnsupportedClipboardImageProvider } from "./unsupported.ts";
import { createWin32ClipboardImageProvider } from "./win32.ts";

export interface ClipboardImageProvider {
  readImage(): Promise<ClipboardImage | undefined>;
}

export function createClipboardImageProvider(platform = process.platform): ClipboardImageProvider {
  switch (platform) {
    case "darwin":
      return createDarwinClipboardImageProvider();
    case "linux":
      return createLinuxClipboardImageProvider();
    case "win32":
      return createWin32ClipboardImageProvider();
    default:
      return createUnsupportedClipboardImageProvider();
  }
}

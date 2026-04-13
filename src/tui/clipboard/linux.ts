import type { ClipboardImageProvider } from "./provider.ts";

import { parseClipboardImageRecord, readJsonFromCommand } from "./shared.ts";

const LINUX_CLIPBOARD_IMAGE_SCRIPT = `
set -eu

if command -v wl-paste >/dev/null 2>&1; then
  types="$(wl-paste --list-types 2>/dev/null || true)"
  if printf '%s' "$types" | grep -q '^image/png$'; then
    data="$(wl-paste --no-newline --type image/png | base64 | tr -d '\\n')"
    printf '{"mimeType":"image/png","data":"%s"}\\n' "$data"
    exit 0
  fi
fi

if command -v xclip >/dev/null 2>&1; then
  if xclip -selection clipboard -t TARGETS -o 2>/dev/null | tr ' ' '\\n' | grep -q '^image/png$'; then
    data="$(xclip -selection clipboard -t image/png -o | base64 | tr -d '\\n')"
    printf '{"mimeType":"image/png","data":"%s"}\\n' "$data"
    exit 0
  fi
fi

exit 1
`;

export function createLinuxClipboardImageProvider(): ClipboardImageProvider {
  return {
    async readImage() {
      const result = await readJsonFromCommand("/bin/sh", ["-lc", LINUX_CLIPBOARD_IMAGE_SCRIPT]);
      return parseClipboardImageRecord(result);
    },
  };
}

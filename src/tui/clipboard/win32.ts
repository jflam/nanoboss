import type { ClipboardImageProvider } from "./provider.ts";

import { parseClipboardImageRecord, readJsonFromCommand } from "./shared.ts";

const WIN32_CLIPBOARD_IMAGE_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) {
  exit 1
}

$image = [System.Windows.Forms.Clipboard]::GetImage()
$stream = New-Object System.IO.MemoryStream
$image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
$bytes = $stream.ToArray()

$payload = @{
  mimeType = "image/png"
  data = [System.Convert]::ToBase64String($bytes)
  width = [int]$image.Width
  height = [int]$image.Height
  byteLength = [int]$bytes.Length
}

$payload | ConvertTo-Json -Compress
`;

export function createWin32ClipboardImageProvider(): ClipboardImageProvider {
  return {
    async readImage() {
      const result = await readJsonFromCommand("powershell.exe", [
        "-NoProfile",
        "-STA",
        "-Command",
        WIN32_CLIPBOARD_IMAGE_SCRIPT,
      ]);
      return parseClipboardImageRecord(result);
    },
  };
}

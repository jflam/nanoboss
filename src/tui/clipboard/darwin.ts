import type { ClipboardImageProvider } from "./provider.ts";

import { parseClipboardImageRecord, readJsonFromCommand } from "./shared.ts";

const DARWIN_CLIPBOARD_IMAGE_SCRIPT = `
import AppKit
import Foundation

func emit(_ payload: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: payload, options: [])
    print(String(data: data, encoding: .utf8)!)
}

let pasteboard = NSPasteboard.general
let typeNames = pasteboard.types?.map(\\.rawValue) ?? []

func imagePayload(from image: NSImage) -> [String: Any]? {
    guard let tiffData = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiffData),
          let pngData = bitmap.representation(using: .png, properties: [:]) else {
        return nil
    }

    return [
        "mimeType": "image/png",
        "data": pngData.base64EncodedString(),
        "width": Int(bitmap.pixelsWide),
        "height": Int(bitmap.pixelsHigh),
        "byteLength": pngData.count,
    ]
}

if let directImage = NSImage(pasteboard: pasteboard), let payload = imagePayload(from: directImage) {
    emit(payload)
} else if let objects = pasteboard.readObjects(forClasses: [NSImage.self], options: nil) as? [NSImage],
          let first = objects.first,
          let payload = imagePayload(from: first) {
    emit(payload)
} else if let pngData = pasteboard.data(forType: .png),
          let bitmap = NSBitmapImageRep(data: pngData) {
    emit([
        "mimeType": "image/png",
        "data": pngData.base64EncodedString(),
        "width": Int(bitmap.pixelsWide),
        "height": Int(bitmap.pixelsHigh),
        "byteLength": pngData.count,
    ])
} else if let tiffData = pasteboard.data(forType: .tiff),
          let bitmap = NSBitmapImageRep(data: tiffData),
          let pngData = bitmap.representation(using: .png, properties: [:]) {
    emit([
        "mimeType": "image/png",
        "data": pngData.base64EncodedString(),
        "width": Int(bitmap.pixelsWide),
        "height": Int(bitmap.pixelsHigh),
        "byteLength": pngData.count,
    ])
} else {
    emit([
        "error": "no_image",
        "types": typeNames,
    ])
}
`;

export function createDarwinClipboardImageProvider(): ClipboardImageProvider {
  return {
    async readImage() {
      const result = await readJsonFromCommand(
        "swift",
        ["-e", DARWIN_CLIPBOARD_IMAGE_SCRIPT],
        {
          SWIFT_MODULECACHE_PATH: "/tmp/nanoboss-swift-module-cache",
          CLANG_MODULE_CACHE_PATH: "/tmp/nanoboss-swift-module-cache",
        },
      );
      return parseClipboardImageRecord(result);
    },
  };
}

import { basename } from "node:path";

import {
  discoverDiskModules,
  getDiskModuleDefaultExport,
  loadDiskModule,
} from "@nanoboss/app-support";
import type { TuiExtension, TuiExtensionMetadata } from "@nanoboss/tui-extension-sdk";

import { assertTuiExtension } from "./loadable-registry.ts";

interface DiscoveredDiskTuiExtension {
  metadata: TuiExtensionMetadata;
  path: string;
}

const EXTENSION_CACHE_NAMESPACE = "tui-extension-builds";
const EXTENSION_ENTRY_DIR_HINTS = ["extensions"] as const;

export function discoverDiskTuiExtensions(extensionRoot: string): DiscoveredDiskTuiExtension[] {
  return discoverDiskModules<TuiExtensionMetadata>({
    root: extensionRoot,
    readMetadata: ({ path, source }) => readTuiExtensionMetadata(path, source),
  }).map(({ path, metadata }) => ({ path, metadata }));
}

export async function loadTuiExtensionFromPath(path: string): Promise<TuiExtension> {
  const loaded = await loadDiskModule({
    path,
    cacheNamespace: EXTENSION_CACHE_NAMESPACE,
    entryDirHints: EXTENSION_ENTRY_DIR_HINTS,
  });
  const extension = getDiskModuleDefaultExport(loaded);
  assertTuiExtension(extension);
  return extension;
}

function readTuiExtensionMetadata(path: string, source: string): TuiExtensionMetadata | undefined {
  if (!looksLikeTuiExtensionModule(source)) {
    return undefined;
  }

  const name = readStaticStringProperty(source, "name") ?? basename(path, ".ts");
  const version = readStaticStringProperty(source, "version") ?? "0.0.0";
  const description = readStaticStringProperty(source, "description")
    ?? `TUI extension from ${basename(path)}`;

  return { name, version, description };
}

function looksLikeTuiExtensionModule(source: string): boolean {
  if (!/\bexport\s+default\b/u.test(source)) {
    return false;
  }
  if (!/\bmetadata\s*:/u.test(source)) {
    return false;
  }
  return /\b(?:async\s+)?activate\s*\(/u.test(source) || /\bactivate\s*:/u.test(source);
}

function readStaticStringProperty(source: string, propertyName: string): string | undefined {
  const patterns = [
    new RegExp(`\\b${escapeRegExp(propertyName)}\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "u"),
    new RegExp(`\\b${escapeRegExp(propertyName)}\\s*:\\s*'((?:\\\\.|[^'\\\\])*)'`, "u"),
    new RegExp(`\\b${escapeRegExp(propertyName)}\\s*:\\s*` + "`((?:\\\\.|[^`\\\\])*)`", "u"),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (match?.[1] !== undefined) {
      return decodeStringLiteral(match[1]);
    }
  }

  return undefined;
}

function decodeStringLiteral(value: string): string {
  return value.replace(/\\([\\'"`nrt])/g, (_, escaped: string) => {
    switch (escaped) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return escaped;
    }
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

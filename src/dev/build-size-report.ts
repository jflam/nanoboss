import { TraceMap, decodedMappings } from "@jridgewell/trace-mapping";
import type { SourceMapInput } from "@jridgewell/trace-mapping";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface SourceByteAttribution {
  sourceBytes: Map<string, number>;
  unmappedBytes: number;
}

interface SizeGroup {
  label: string;
  bytes: number;
}

interface BundleSizeSummary {
  appBytes: number;
  dependencyBytes: number;
  unmappedBytes: number;
  appGroups: SizeGroup[];
  dependencyGroups: SizeGroup[];
}

export function attributeSourceMapBytes(
  bundleText: string,
  sourceMap: SourceMapInput,
  sourceMapPath: string,
): SourceByteAttribution {
  const traceMap = new TraceMap(sourceMap, sourceMapPath);
  const mappings = decodedMappings(traceMap);
  const lines = bundleText.split("\n");
  const trailingNewline = bundleText.endsWith("\n");
  const lineCount = trailingNewline ? lines.length - 1 : lines.length;
  const sourceBytes = new Map<string, number>();
  let unmappedBytes = 0;

  for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const segments = mappings[lineIndex] ?? [];
    const hasNewline = trailingNewline || lineIndex < lineCount - 1;

    if (segments.length === 0) {
      unmappedBytes += Buffer.byteLength(line) + (hasNewline ? 1 : 0);
      continue;
    }

    let coveredColumns = 0;

    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      const segment = segments[segmentIndex];
      if (!segment) {
        continue;
      }

      const startColumn = segment[0];
      if (startColumn > coveredColumns) {
        unmappedBytes += Buffer.byteLength(line.slice(coveredColumns, startColumn));
      }

      const nextSegment = segments[segmentIndex + 1];
      const endColumn = nextSegment ? nextSegment[0] : line.length;
      const spanBytes = Buffer.byteLength(line.slice(startColumn, endColumn));
      addSegmentBytes(segment, spanBytes);
      coveredColumns = endColumn;
    }

    if (coveredColumns < line.length) {
      unmappedBytes += Buffer.byteLength(line.slice(coveredColumns));
    }

    if (hasNewline) {
      const lastSegment = segments[segments.length - 1];
      if (lastSegment) {
        addSegmentBytes(lastSegment, 1);
      } else {
        unmappedBytes += 1;
      }
    }
  }

  return {
    sourceBytes,
    unmappedBytes,
  };

  function addSegmentBytes(segment: readonly number[], bytes: number): void {
    if (bytes === 0) {
      return;
    }

    if (segment.length < 4) {
      unmappedBytes += bytes;
      return;
    }

    const sourceIndex = segment[1];
    if (typeof sourceIndex !== "number") {
      unmappedBytes += bytes;
      return;
    }

    const resolvedSource = traceMap.resolvedSources[sourceIndex];
    const sourcePath = typeof resolvedSource === "string"
      ? normalizeSourcePath(resolvedSource)
      : null;
    if (!sourcePath) {
      unmappedBytes += bytes;
      return;
    }

    sourceBytes.set(sourcePath, (sourceBytes.get(sourcePath) ?? 0) + bytes);
  }
}

export function summarizeBundledSources(
  attribution: SourceByteAttribution,
  repoRoot: string,
  topGroupCount = 5,
): BundleSizeSummary {
  const appGroups = new Map<string, number>();
  const dependencyGroups = new Map<string, number>();
  let appBytes = 0;
  let dependencyBytes = 0;

  for (const [sourcePath, bytes] of attribution.sourceBytes) {
    const group = classifySourcePath(sourcePath, repoRoot);
    if (group.kind === "app") {
      appBytes += bytes;
      appGroups.set(group.label, (appGroups.get(group.label) ?? 0) + bytes);
      continue;
    }

    dependencyBytes += bytes;
    dependencyGroups.set(group.label, (dependencyGroups.get(group.label) ?? 0) + bytes);
  }

  return {
    appBytes,
    dependencyBytes,
    unmappedBytes: attribution.unmappedBytes,
    appGroups: collapseGroups(appGroups, topGroupCount),
    dependencyGroups: collapseGroups(dependencyGroups, topGroupCount),
  };
}

export function formatByteSize(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const formattedValue = unitIndex === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${formattedValue} ${units[unitIndex]} (${bytes.toLocaleString()} bytes)`;
}

function normalizeSourcePath(sourcePath: string): string | null {
  if (sourcePath.startsWith("file://")) {
    return fileURLToPath(sourcePath);
  }
  if (sourcePath.startsWith("bun:") || sourcePath.startsWith("node:")) {
    return sourcePath;
  }
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(sourcePath)) {
    return null;
  }
  return sourcePath;
}

function classifySourcePath(
  sourcePath: string,
  repoRoot: string,
): { kind: "app" | "dependency"; label: string } {
  const normalizedSourcePath = sourcePath.replaceAll("\\", "/");
  const nodeModulesIndex = normalizedSourcePath.lastIndexOf("/node_modules/");
  if (nodeModulesIndex >= 0) {
    const packagePath = normalizedSourcePath.slice(nodeModulesIndex + "/node_modules/".length);
    return {
      kind: "dependency",
      label: packageNameFromNodeModulesPath(packagePath),
    };
  }

  if (normalizedSourcePath.startsWith("bun:") || normalizedSourcePath.startsWith("node:")) {
    return {
      kind: "dependency",
      label: normalizedSourcePath,
    };
  }

  const relativePath = relative(repoRoot, resolve(sourcePath)).replaceAll("\\", "/");
  if (relativePath.startsWith("../")) {
    return {
      kind: "dependency",
      label: relativePath.split("/")[0] ?? relativePath,
    };
  }

  if (relativePath.startsWith("src/")) {
    const [, area = "root"] = relativePath.split("/");
    return {
      kind: "app",
      label: `src/${area}`,
    };
  }

  if (relativePath.startsWith("procedures/")) {
    return {
      kind: "app",
      label: "procedures",
    };
  }

  if (relativePath.startsWith("scripts/")) {
    return {
      kind: "app",
      label: "scripts",
    };
  }

  if (!relativePath.includes("/")) {
    return {
      kind: "app",
      label: "entrypoints",
    };
  }

  return {
    kind: "app",
    label: relativePath.split("/")[0] ?? relativePath,
  };
}

function packageNameFromNodeModulesPath(packagePath: string): string {
  const segments = packagePath.split("/");
  const firstSegment = segments[0];
  if (!firstSegment) {
    return "node_modules";
  }
  if (firstSegment.startsWith("@")) {
    const secondSegment = segments[1];
    return secondSegment ? `${firstSegment}/${secondSegment}` : firstSegment;
  }
  return firstSegment;
}

function collapseGroups(groupBytes: Map<string, number>, limit: number): SizeGroup[] {
  const groups = Array.from(groupBytes, ([label, bytes]) => ({ label, bytes }))
    .sort((left, right) => right.bytes - left.bytes || left.label.localeCompare(right.label));
  if (groups.length <= limit) {
    return groups;
  }

  const otherBytes = groups
    .slice(limit)
    .reduce((total, group) => total + group.bytes, 0);
  return [
    ...groups.slice(0, limit),
    {
      label: "other",
      bytes: otherBytes,
    },
  ];
}

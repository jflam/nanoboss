export function formatDiskBuildFailure(path: string, logs: readonly unknown[]): string {
  const diagnostics = formatBuildLogs(logs);
  return [
    `Failed to compile disk module: ${path}`,
    diagnostics.length > 0
      ? diagnostics.join("\n")
      : "Bundle failed without diagnostics from Bun.build().",
  ].join("\n");
}

export function extractBuildLogs(error: unknown): readonly unknown[] {
  if (
    error instanceof AggregateError
    && Array.isArray(error.errors)
  ) {
    return error.errors;
  }

  if (
    typeof error === "object"
    && error !== null
    && "errors" in error
    && Array.isArray((error as { errors?: unknown[] }).errors)
  ) {
    return (error as { errors: unknown[] }).errors;
  }

  return [];
}

function formatBuildLogs(logs: readonly unknown[]): string[] {
  return logs.map((log, index) => {
    if (typeof log === "string") {
      return `Build diagnostic ${index + 1}: ${log}`;
    }

    if (!log || typeof log !== "object") {
      return `Build diagnostic ${index + 1}: ${String(log)}`;
    }

    const message = "message" in log && typeof log.message === "string"
      ? log.message
      : JSON.stringify(log);
    const level = "level" in log && typeof log.level === "string"
      ? log.level
      : undefined;
    const code = "code" in log && typeof log.code === "string"
      ? log.code
      : undefined;
    const specifier = "specifier" in log && typeof log.specifier === "string"
      ? log.specifier
      : undefined;
    const importKind = "importKind" in log && typeof log.importKind === "string"
      ? log.importKind
      : undefined;
    const referrer = "referrer" in log && typeof log.referrer === "string" && log.referrer.trim().length > 0
      ? log.referrer
      : undefined;
    const position = "position" in log && log.position && typeof log.position === "object"
      ? log.position
      : undefined;
    const location = position && "file" in position && typeof position.file === "string"
      ? formatBuildLogLocation(position)
      : undefined;
    const sourceLine = position && "lineText" in position && typeof position.lineText === "string"
      ? position.lineText.trim()
      : undefined;

    const header = [
      `Build diagnostic ${index + 1}:`,
      level ? level : undefined,
      code ? `[${code}]` : undefined,
      location ? `at ${location}` : referrer ? `from ${referrer}` : undefined,
    ].filter((value): value is string => Boolean(value)).join(" ");
    const details = [
      message,
      specifier ? `specifier: ${specifier}` : undefined,
      importKind ? `import kind: ${importKind}` : undefined,
      sourceLine ? `source: ${sourceLine}` : undefined,
    ].filter((value): value is string => Boolean(value));

    return [header, ...details.map((line) => `  ${line}`)].join("\n");
  });
}

function formatBuildLogLocation(position: { file?: unknown; line?: unknown; column?: unknown }): string {
  const file = typeof position.file === "string" ? position.file : undefined;
  const line = typeof position.line === "number" && Number.isFinite(position.line) ? position.line : undefined;
  const column = typeof position.column === "number" && Number.isFinite(position.column) ? position.column : undefined;

  if (!file) {
    return "unknown location";
  }

  if (line !== undefined && column !== undefined) {
    return `${file}:${line}:${column}`;
  }

  if (line !== undefined) {
    return `${file}:${line}`;
  }

  return file;
}

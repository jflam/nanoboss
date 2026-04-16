import {
  createTaggedJsonLineStream,
  summarizeText,
} from "@nanoboss/procedure-sdk";
import {
  extractPreCommitPhaseResults,
  parsePreCommitMarkerPayload,
  PRE_COMMIT_MARKER_PREFIX,
  stripPreCommitMarkers,
  type PreCommitMarkerEvent,
  type PreCommitPhaseName,
  type PreCommitPhaseStatus,
} from "./pre-commit-checks-protocol.ts";
import { ensureTrailingNewline, type ResolvedPreCommitChecksResult } from "./test-cache-lib.ts";

interface PreCommitChunkRenderState {
  currentPhase?: PreCommitPhaseName;
}

const FAILURE_HELP_LINE = "Run `/nanoboss/pre-commit-checks --refresh --verbose` to inspect the full raw output.";

export function createPreCommitOutputStreamer(verbose: boolean): {
  consume(chunk: string): string;
  flush(): string;
} {
  const state: PreCommitChunkRenderState = {};
  return createTaggedJsonLineStream<PreCommitMarkerEvent>({
    markerPrefix: PRE_COMMIT_MARKER_PREFIX,
    parseMarker: parsePreCommitMarkerPayload,
    onMarker(marker) {
      if (marker.type === "phase_start") {
        state.currentPhase = marker.phase;
      }
    },
    renderTextLine(line, options) {
      if (!verbose && !isTestPhase(state.currentPhase)) {
        return undefined;
      }
      return options.complete ? `${line}\n` : line;
    },
  });
}

export function printPreCommitRunOutput(
  print: (text: string) => void,
  result: ResolvedPreCommitChecksResult,
  options: {
    refresh: boolean;
    verbose: boolean;
  },
): void {
  if (options.verbose || result.passed) {
    if (!result.cacheHit) {
      return;
    }

    print(renderPreCommitHeader(result, options.refresh));
    const cleanOutput = stripPreCommitMarkers(result.combinedOutput);
    if (cleanOutput.length > 0) {
      print(ensureTrailingNewline(cleanOutput));
    }
    return;
  }

  if (result.cacheHit) {
    print(renderPreCommitHeader(result, options.refresh));
  }
  print(`${renderPreCommitFailureDigest(result)}\n`);
}

export function renderPreCommitDisplay(result: ResolvedPreCommitChecksResult): string {
  const source = result.cacheHit ? "cached" : "fresh";
  const status = result.passed ? "passed" : `failed (exit ${result.exitCode})`;
  return `Pre-commit checks ${status} using ${source} result for \`${result.command}\`.\n`;
}

export function renderPreCommitFailureDigest(result: ResolvedPreCommitChecksResult): string {
  const phaseResults = extractPreCommitPhaseResults(result.combinedOutput);
  if (phaseResults.length === 0) {
    return renderLegacyFailureDigest(result);
  }

  const failedPhase = phaseResults.find((phaseResult) => phaseResult.status === "failed");
  const details = isTypecheckPhase(failedPhase?.phase)
    ? renderTypeScriptFailureDetails(result.combinedOutput)
    : compactFailureExcerpt(stripPreCommitMarkers(result.combinedOutput));

  return [
    "Validation summary:",
    ...phaseResults.map((phaseResult) =>
      `- ${phaseResult.phase}: ${renderPhaseStatus(phaseResult.status, phaseResult.exitCode)}`),
    ...(details.length > 0 ? [details] : []),
    FAILURE_HELP_LINE,
  ].join("\n");
}

export function renderPreCommitFreshRunHeader(
  reason: ResolvedPreCommitChecksResult["runReason"],
  command: string,
): string {
  switch (reason) {
    case "refresh":
      return `Refresh requested; re-running pre-commit checks with \`${command}\`.\n`;
    case "cold_cache":
      return `No cached pre-commit result matched; running \`${command}\`.\n`;
    case "workspace_changed":
      return `Dirty repo detected; re-running checks for confidence with \`${command}\`.\n`;
    case "runtime_changed":
      return `Runtime changed since the last cached result; re-running \`${command}\`.\n`;
    case "command_changed":
      return `Pre-commit command changed; re-running \`${command}\`.\n`;
    case "cache_hit":
      return `Pre-commit checks cache hit for \`${command}\`.\n`;
  }
}

export function renderPreCommitSummary(result: ResolvedPreCommitChecksResult): string {
  const status = result.passed ? "pass" : `fail (${result.exitCode})`;
  return `nanoboss/pre-commit-checks: ${status}${result.cacheHit ? " cached" : ""}`;
}

function renderLegacyFailureDigest(result: ResolvedPreCommitChecksResult): string {
  const diagnostics = extractTypeScriptDiagnostics(result.combinedOutput);
  if (diagnostics.length > 0) {
    const uniqueFiles = new Set(diagnostics.map((diagnostic) => diagnostic.file)).size;
    const preview = diagnostics
      .slice(0, 5)
      .map((diagnostic) =>
        `- ${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.code} ${summarizeText(diagnostic.message, 120)}`);
    if (diagnostics.length > preview.length) {
      preview.push(`- ... and ${diagnostics.length - preview.length} more TypeScript errors.`);
    }

    return [
      `Typecheck reported ${diagnostics.length} error${diagnostics.length === 1 ? "" : "s"} across ${uniqueFiles} file${uniqueFiles === 1 ? "" : "s"}.`,
      ...preview,
      FAILURE_HELP_LINE,
    ].join("\n");
  }

  const excerpt = compactFailureExcerpt(result.combinedOutput);
  return [
    `Validation failed with exit ${result.exitCode}.`,
    excerpt.length > 0 ? excerpt : "No concise failure excerpt was available.",
    FAILURE_HELP_LINE,
  ].join("\n");
}

function renderPreCommitHeader(result: ResolvedPreCommitChecksResult, refresh: boolean): string {
  if (result.cacheHit) {
    return `Pre-commit checks cache hit for \`${result.command}\`.\n`;
  }

  if (refresh) {
    return `Refreshing pre-commit checks with \`${result.command}\`.\n`;
  }

  return `Running pre-commit checks with \`${result.command}\`.\n`;
}

function renderTypeScriptFailureDetails(output: string): string {
  const diagnostics = extractTypeScriptDiagnostics(output);
  if (diagnostics.length === 0) {
    return compactFailureExcerpt(stripPreCommitMarkers(output));
  }

  const grouped = new Map<string, typeof diagnostics>();
  for (const diagnostic of diagnostics) {
    const entries = grouped.get(diagnostic.file);
    if (entries) {
      entries.push(diagnostic);
    } else {
      grouped.set(diagnostic.file, [diagnostic]);
    }
  }

  const preview = [...grouped.entries()]
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([file, fileDiagnostics]) => renderDiagnosticGroupPreview(file, fileDiagnostics));
  if (grouped.size > preview.length) {
    preview.push(`- ... and ${grouped.size - preview.length} more files with TypeScript errors.`);
  }

  return [
    `Typecheck reported ${diagnostics.length} error${diagnostics.length === 1 ? "" : "s"} across ${grouped.size} file${grouped.size === 1 ? "" : "s"}.`,
    ...preview,
  ].join("\n");
}

function compactFailureExcerpt(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith("$ "))
    .slice(0, 6)
    .map((line) => `- ${summarizeText(line, 140)}`)
    .join("\n");
}

function extractTypeScriptDiagnostics(output: string): Array<{
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}> {
  const diagnostics: Array<{
    file: string;
    line: number;
    column: number;
    code: string;
    message: string;
  }> = [];

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(.*)\((\d+),(\d+)\): error (TS\d+): (.+)$/);
    if (!match) {
      continue;
    }

    const [file, lineNumber, columnNumber, code, message] = match.slice(1);
    if (!file || !lineNumber || !columnNumber || !code || !message) {
      continue;
    }

    diagnostics.push({
      file,
      line: Number.parseInt(lineNumber, 10),
      column: Number.parseInt(columnNumber, 10),
      code,
      message,
    });
  }

  return diagnostics;
}

function renderDiagnosticGroupPreview(
  file: string,
  fileDiagnostics: Array<{
    file: string;
    line: number;
    column: number;
    code: string;
    message: string;
  }>,
): string {
  const first = fileDiagnostics[0];
  if (!first) {
    return `- ${file}`;
  }

  const suffix = fileDiagnostics.length > 1 ? ` (${fileDiagnostics.length} errors)` : "";
  return `- ${file}${suffix}: ${first.line}:${first.column} ${first.code} ${summarizeText(first.message, 110)}`;
}

function renderPhaseStatus(status: PreCommitPhaseStatus, exitCode?: number): string {
  switch (status) {
    case "passed":
      return "passed";
    case "failed":
      return typeof exitCode === "number" ? `failed (exit ${exitCode})` : "failed";
    case "not_run":
      return "not run";
  }
}

function isTestPhase(phase: PreCommitPhaseName | undefined): boolean {
  return phase === "test" || phase === "test:packages";
}

function isTypecheckPhase(phase: PreCommitPhaseName | undefined): boolean {
  return phase === "typecheck" || phase === "typecheck:packages";
}

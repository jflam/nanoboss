import { isAbsolute, relative, resolve } from "node:path";

import typia from "typia";

import { expectData } from "../src/core/run-result.ts";
import { jsonType } from "../src/core/types.ts";
import type {
  ProcedureApi,
  Procedure,
} from "../src/core/types.ts";

export interface LinterError {
  file: string;
  line: number;
  column: number;
  message: string;
  rule: string;
}

interface ProcessCommand {
  executable: string;
  args: string[];
}

type LintAdapterCommand = ProcessCommand;

export interface LintExecutionPlan {
  cwd: string;
  executable: string;
  args: string[];
  adapter?: LintAdapterCommand | null;
  parser: LintOutputParser;
}

interface FileErrorGroup {
  normalizedFile: string;
  displayFile: string;
  errors: LinterError[];
}

interface LinterDiscoveryResult {
  status: "configured" | "missing_linter";
  summary: string;
  errors: LinterError[];
  recommendations: string[];
  plan: LintExecutionPlan | null;
}

interface LintRunResult {
  status: "configured" | "missing_linter";
  summary: string;
  errors: LinterError[];
  recommendations: string[];
  command: string | null;
}

type JsonScalar = string | number | boolean | null;

interface BaseJsonLintParser {
  entriesPath?: string[];
  lineField?: string;
  columnField?: string;
  messageField: string;
  ruleField?: string;
  severityField?: string;
  errorSeverities?: JsonScalar[];
  defaultRule?: string;
}

export interface DiagnosticArrayJsonParser extends BaseJsonLintParser {
  kind: "diagnostic-array-json";
  fileField: string;
}

export interface FileMessageArrayJsonParser extends BaseJsonLintParser {
  kind: "file-message-array-json";
  fileField: string;
  messagesField: string;
}

export type LintOutputParser =
  | "eslint-json"
  | DiagnosticArrayJsonParser
  | FileMessageArrayJsonParser;

const LinterDiscoveryResultType = jsonType<LinterDiscoveryResult>(
  typia.json.schema<LinterDiscoveryResult>(),
  typia.createValidate<LinterDiscoveryResult>(),
);

const MAX_ROUNDS = 3;
const MAX_FILES_PER_ROUND = 3;
const textDecoder = new TextDecoder();
const ESLINT_JSON_PARSER: FileMessageArrayJsonParser = {
  kind: "file-message-array-json",
  fileField: "filePath",
  messagesField: "messages",
  lineField: "line",
  columnField: "column",
  messageField: "message",
  ruleField: "ruleId",
  severityField: "severity",
  errorSeverities: [2],
  defaultRule: "parsing",
};

function renderRecommendations(recommendations: string[]): string {
  if (recommendations.length === 0) {
    return "";
  }

  return recommendations.map((item) => `- ${item}`).join("\n");
}

function normalizeErrorFile(cwd: string, file: string): string {
  return isAbsolute(file) ? file : resolve(cwd, file);
}

function displayErrorFile(cwd: string, file: string): string {
  const relativePath = relative(cwd, file);
  return relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)
    ? relativePath
    : file;
}

function renderProcessCommand(command: ProcessCommand): string {
  return [command.executable, ...command.args].join(" ");
}

function renderCommand(plan: LintExecutionPlan): string {
  const linterCommand = renderProcessCommand(plan);
  return plan.adapter ? `${linterCommand} | ${renderProcessCommand(plan.adapter)}` : linterCommand;
}

function decodeProcessText(output: Uint8Array): string {
  return textDecoder.decode(output).trim();
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function groupErrorsByFile(cwd: string, errors: LinterError[]): FileErrorGroup[] {
  const groups = new Map<string, FileErrorGroup>();

  for (const error of errors) {
    const normalizedFile = normalizeErrorFile(cwd, error.file);
    const existing = groups.get(normalizedFile);

    if (existing) {
      existing.errors.push(error);
      continue;
    }

    groups.set(normalizedFile, {
      normalizedFile,
      displayFile: displayErrorFile(cwd, normalizedFile),
      errors: [error],
    });
  }

  return Array.from(groups.values());
}

export function selectFixWave(fileGroups: FileErrorGroup[], limit: number): FileErrorGroup[] {
  return fileGroups.slice(0, limit);
}

interface LintErrorDelta {
  resolvedCount: number;
  surfacedCount: number;
}

function buildLintErrorKey(cwd: string, error: LinterError): string {
  return [
    normalizeErrorFile(cwd, error.file),
    String(error.line),
    String(error.column),
    error.message,
    error.rule,
  ].join("\u0000");
}

function countLintErrorsByKey(cwd: string, errors: LinterError[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const error of errors) {
    const key = buildLintErrorKey(cwd, error);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
}

export function diffLintErrors(
  cwd: string,
  before: LinterError[],
  after: LinterError[],
): LintErrorDelta {
  const beforeCounts = countLintErrorsByKey(cwd, before);
  const afterCounts = countLintErrorsByKey(cwd, after);
  const keys = new Set([...beforeCounts.keys(), ...afterCounts.keys()]);
  let resolvedCount = 0;
  let surfacedCount = 0;

  for (const key of keys) {
    const beforeCount = beforeCounts.get(key) ?? 0;
    const afterCount = afterCounts.get(key) ?? 0;

    if (beforeCount > afterCount) {
      resolvedCount += beforeCount - afterCount;
      continue;
    }

    if (afterCount > beforeCount) {
      surfacedCount += afterCount - beforeCount;
    }
  }

  return { resolvedCount, surfacedCount };
}

export function buildFixPrompt(group: FileErrorGroup): string {
  const diagnostics = group.errors.map((error) =>
    `- ${group.displayFile}:${error.line}:${error.column} ${error.message} (rule: ${error.rule})`
  );

  return [
    `Fix only the following linter errors in ${group.normalizedFile}:`,
    ...diagnostics,
    `Prefer editing only ${group.normalizedFile}.`,
    "Do not run the full repo linter or any repo-wide lint command.",
    "Do not search for or fix unrelated lint errors in other files.",
    "Do not run build or tests unless they are strictly necessary for this targeted file fix.",
    "Do not commit changes.",
    "The caller will rerun lint and manage commits after you return.",
    "Reply briefly with what you changed.",
  ].join("\n");
}

function buildDiscoveryPrompt(cwd: string, prompt: string): string {
  return [
    `Inspect the repo at ${cwd} and determine whether an existing linter can be run or adapted into machine-readable JSON mode.`,
    "Check existing scripts and linter config if needed, but do not install or configure anything.",
    "If a linter is runnable, actually run it once and return normalized lint errors from that run.",
    "If a linter is runnable, also return a reusable `plan` object with:",
    "- `cwd`: the absolute working directory to run from",
    "- `executable`: the direct executable to invoke",
    "- `args`: the exact argv needed to rerun the linter in JSON mode",
    "- `adapter` (optional): a direct executable + args that reads the raw linter stdout on stdin and emits JSON for `parser`",
    "- `parser`: either `eslint-json`, or a JSON parser descriptor using `diagnostic-array-json` or `file-message-array-json`",
    "- custom parser descriptors may include `entriesPath`, `severityField`, and `errorSeverities` so reruns can filter errors correctly",
    "If the linter cannot emit JSON directly, you may return an adapter command. It must be deterministic and rerunnable without extra reasoning.",
    "The plan must avoid shell operators, pipes, command substitution, and inline environment-variable assignments.",
    "If you cannot express the runnable linter in this schema, return status `missing_linter` with a short complaint and 1-3 concrete recommendations.",
    "If the linter runs successfully with zero errors, return status `configured` with an empty errors array and a valid plan.",
    `Additional user instructions: ${prompt || "none"}`,
  ].join("\n\n");
}

function findErrorGroup(
  cwd: string,
  errors: LinterError[],
  normalizedFile: string,
): FileErrorGroup | undefined {
  return groupErrorsByFile(cwd, errors).find((group) => group.normalizedFile === normalizedFile);
}

async function discoverLinter(
  ctx: ProcedureApi,
  prompt: string,
): Promise<LinterDiscoveryResult> {
  const result = await ctx.agent.run(
    buildDiscoveryPrompt(ctx.cwd, prompt),
    LinterDiscoveryResultType,
    { stream: false },
  );

  return expectData(result, "Linter discovery returned no data");
}

function parseJsonOutput(output: string, parserName: string): unknown {
  if (output.trim().length === 0) {
    throw new Error("Expected JSON output from the discovered linter command, but stdout was empty");
  }

  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(
      `Failed to parse ${parserName} output: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
}

function asText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return undefined;
}

function asLineNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function resolveEntries(parsed: unknown, entriesPath: string[] | undefined, parserName: string): unknown[] {
  let current = parsed;

  for (const segment of entriesPath ?? []) {
    const record = asRecord(current);
    if (!record || !(segment in record)) {
      const renderedPath = (entriesPath ?? []).join(".");
      throw new Error(`Expected ${parserName} output to contain an array at path \`${renderedPath}\``);
    }

    current = record[segment];
  }

  if (!Array.isArray(current)) {
    throw new Error(`Expected ${parserName} output to resolve to an array of lint entries`);
  }

  return current;
}

function isErrorSeverity(record: Record<string, unknown>, parser: BaseJsonLintParser): boolean {
  const severityField = parser.severityField;
  const errorSeverities = parser.errorSeverities;

  if (!severityField || !errorSeverities || errorSeverities.length === 0) {
    return true;
  }

  return errorSeverities.some((severity) => record[severityField] === severity);
}

function normalizeLintMessage(
  cwd: string,
  filePath: string,
  record: Record<string, unknown>,
  parser: BaseJsonLintParser,
): LinterError | null {
  if (!isErrorSeverity(record, parser)) {
    return null;
  }

  return {
    file: normalizeErrorFile(cwd, filePath),
    line: parser.lineField ? asLineNumber(record[parser.lineField]) ?? 0 : 0,
    column: parser.columnField ? asLineNumber(record[parser.columnField]) ?? 0 : 0,
    message: asText(record[parser.messageField]) ?? "Unknown lint error",
    rule: parser.ruleField
      ? asText(record[parser.ruleField]) ?? (parser.defaultRule ?? "unknown")
      : (parser.defaultRule ?? "unknown"),
  };
}

function parseDiagnosticArrayJsonOutput(
  cwd: string,
  output: string,
  parser: DiagnosticArrayJsonParser,
): LinterError[] {
  const parsed = parseJsonOutput(output, parser.kind);
  const entries = resolveEntries(parsed, parser.entriesPath, parser.kind);
  const errors: LinterError[] = [];

  for (const entry of entries) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }

    const filePath = asText(record[parser.fileField]);
    if (!filePath) {
      continue;
    }

    const normalized = normalizeLintMessage(cwd, filePath, record, parser);
    if (normalized) {
      errors.push(normalized);
    }
  }

  return errors;
}

function parseFileMessageArrayJsonOutput(
  cwd: string,
  output: string,
  parser: FileMessageArrayJsonParser,
): LinterError[] {
  const parsed = parseJsonOutput(output, parser.kind);
  const entries = resolveEntries(parsed, parser.entriesPath, parser.kind);

  const errors: LinterError[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }

    const filePath = asText(record[parser.fileField]);
    if (!filePath) {
      continue;
    }

    const rawMessages = record[parser.messagesField];
    const messages: unknown[] = Array.isArray(rawMessages) ? rawMessages : [];
    for (const message of messages) {
      const messageRecord = asRecord(message);
      if (!messageRecord) {
        continue;
      }

      const normalized = normalizeLintMessage(cwd, filePath, messageRecord, parser);
      if (normalized) {
        errors.push(normalized);
      }
    }
  }

  return errors;
}

function resolveLintParser(parser: LintOutputParser): DiagnosticArrayJsonParser | FileMessageArrayJsonParser {
  return parser === "eslint-json" ? ESLINT_JSON_PARSER : parser;
}

export function parseLintOutput(cwd: string, output: string, parser: LintOutputParser): LinterError[] {
  const resolved = resolveLintParser(parser);

  switch (resolved.kind) {
    case "diagnostic-array-json":
      return parseDiagnosticArrayJsonOutput(cwd, output, resolved);
    case "file-message-array-json":
      return parseFileMessageArrayJsonOutput(cwd, output, resolved);
  }
}

export function parseEslintJsonOutput(cwd: string, output: string): LinterError[] {
  return parseLintOutput(cwd, output, "eslint-json");
}

interface ProcessRunResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

function runProcess(
  command: ProcessCommand,
  cwd: string,
  description: string,
  stdin?: Uint8Array,
): ProcessRunResult {
  let result: Bun.SyncSubprocess;
  try {
    result = Bun.spawnSync({
      cmd: [command.executable, ...command.args],
      cwd,
      env: process.env,
      stdin,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new Error(
      `Failed to start ${description} \`${renderProcessCommand(command)}\`: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }

  return {
    exitCode: result.exitCode,
    stdout: result.stdout ?? new Uint8Array(),
    stderr: result.stderr ?? new Uint8Array(),
  };
}

export function runPlannedLinter(plan: LintExecutionPlan): LintRunResult {
  const linterResult = runProcess(
    {
      executable: plan.executable,
      args: plan.args,
    },
    plan.cwd,
    "discovered linter command",
  );

  let parseOutput = linterResult.stdout;
  const linterStdout = decodeProcessText(linterResult.stdout);
  const linterStderr = decodeProcessText(linterResult.stderr);
  let adapterStderr = "";

  if (plan.adapter) {
    const adapterResult = runProcess(
      plan.adapter,
      plan.cwd,
      "discovered linter adapter command",
      linterResult.stdout,
    );
    parseOutput = adapterResult.stdout;
    adapterStderr = decodeProcessText(adapterResult.stderr);

    if (adapterResult.exitCode !== 0) {
      const details = [linterStdout, linterStderr, adapterStderr]
        .filter((value) => value.length > 0)
        .join("\n");
      throw new Error(
        `Discovered linter adapter command \`${renderProcessCommand(plan.adapter)}\` failed with exit code ${adapterResult.exitCode}${details ? `: ${details}` : ""}`,
      );
    }
  }

  const parserOutput = decodeProcessText(parseOutput);
  const errors = parseLintOutput(plan.cwd, parserOutput, plan.parser);

  if (linterResult.exitCode !== 0 && linterResult.exitCode !== 1 && errors.length === 0) {
    const details = [linterStdout, linterStderr, adapterStderr]
      .filter((value) => value.length > 0)
      .join("\n");
    throw new Error(
      `Discovered linter command \`${renderCommand(plan)}\` failed with exit code ${linterResult.exitCode}${details ? `: ${details}` : ""}`,
    );
  }

  return {
    status: "configured",
    summary: errors.length === 0 ? "Lint command ran cleanly." : `Found ${pluralize(errors.length, "error")}.`,
    errors,
    recommendations: [],
    command: renderCommand(plan),
  };
}

function buildMissingLinterResult(linter: LintRunResult, fixedErrors: number) {
  const recommendations = renderRecommendations(linter.recommendations);

  return {
    data: buildSummaryData(linter, fixedErrors),
    display: `${linter.summary}\n${recommendations ? `${recommendations}\n` : ""}`,
    summary: linter.summary,
  };
}

function buildSummaryData(linter: LintRunResult, fixedErrors: number) {
  return {
    status: linter.status,
    command: linter.command,
    fixedErrors,
    remainingErrors: linter.errors.length,
  };
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export default {
  name: "linter",
  description: "Fix all linter errors in the project",
  inputHint: "Optional focus area or instructions",
  async execute(prompt, ctx) {
    let fixedErrors = 0;

    ctx.ui.text("Starting linter workflow...\n");
    const discovery = await discoverLinter(ctx, prompt);

    if (discovery.status === "missing_linter" || !discovery.plan) {
      ctx.ui.text("No runnable linter found.\n");
      return buildMissingLinterResult(
        {
          status: discovery.status,
          summary: discovery.summary,
          errors: discovery.errors,
          recommendations: discovery.recommendations,
          command: discovery.plan ? renderCommand(discovery.plan) : null,
        },
        fixedErrors,
      );
    }

    let linter: LintRunResult = {
      status: discovery.status,
      summary: discovery.summary,
      errors: discovery.errors,
      recommendations: discovery.recommendations,
      command: renderCommand(discovery.plan),
    };

    const initialGroups = groupErrorsByFile(ctx.cwd, linter.errors);
    ctx.ui.text(
      `Using \`${linter.command}\`. Found ${pluralize(linter.errors.length, "error")} across ${pluralize(initialGroups.length, "file")}.\n`,
    );

    if (linter.errors.length === 0) {
      ctx.ui.text("Repo is already lint-clean.\n");
      return {
        data: buildSummaryData(linter, fixedErrors),
        display: `Linter command \`${linter.command}\` ran cleanly. ${linter.summary}\n`,
        summary: `linter: clean (${linter.command})`,
      };
    }

    for (let round = 0; round < MAX_ROUNDS && linter.errors.length > 0; round += 1) {
      const allGroups = groupErrorsByFile(ctx.cwd, linter.errors);
      const wave = selectFixWave(allGroups, MAX_FILES_PER_ROUND);

      ctx.ui.text(
        `Round ${round + 1}/${MAX_ROUNDS}: ${pluralize(linter.errors.length, "error")} across ${pluralize(allGroups.length, "file")}.\n`,
      );

      for (const fileGroup of wave) {
        ctx.ui.text(`Fixing ${pluralize(fileGroup.errors.length, "error")} in \`${fileGroup.displayFile}\`...\n`);
        await ctx.agent.run(buildFixPrompt(fileGroup), { stream: false });
      }

      const rerun = runPlannedLinter(discovery.plan);
      const roundDelta = diffLintErrors(ctx.cwd, linter.errors, rerun.errors);
      const resolvedThisRound = roundDelta.resolvedCount;
      let resolvedInTargetedFiles = 0;

      for (const fileGroup of wave) {
        const afterCount = findErrorGroup(
          ctx.cwd,
          rerun.errors,
          fileGroup.normalizedFile,
        )?.errors.length ?? 0;
        const resolvedCount = Math.max(0, fileGroup.errors.length - afterCount);

        if (resolvedCount === 0) {
          ctx.ui.text(`No progress in \`${fileGroup.displayFile}\`.\n`);
          continue;
        }

        resolvedInTargetedFiles += resolvedCount;
        ctx.ui.text(
          `Resolved ${pluralize(resolvedCount, "error")} in \`${fileGroup.displayFile}\`; ${pluralize(rerun.errors.length, "error")} remain.\n`,
        );
      }

      if (resolvedThisRound === 0) {
        ctx.ui.text("No further progress this round; stopping.\n");
        linter = rerun;
        break;
      }

      if (resolvedThisRound > resolvedInTargetedFiles) {
        const spillover = resolvedThisRound - resolvedInTargetedFiles;
        ctx.ui.text(`Resolved ${pluralize(spillover, "additional error")} outside the targeted files.\n`);
      }

      if (roundDelta.surfacedCount > 0) {
        ctx.ui.text(
          `Lint rerun surfaced ${pluralize(roundDelta.surfacedCount, "additional error")} outside the previously reported set.\n`,
        );
      }

      fixedErrors += resolvedThisRound;
      linter = rerun;
      ctx.ui.text(
        `Round ${round + 1} resolved ${pluralize(resolvedThisRound, "error")}; ${pluralize(linter.errors.length, "error")} remain.\n`,
      );
      await ctx.procedures.run("nanoboss/commit", `linter round ${round + 1}`);
    }

    ctx.ui.text(
      `Completed linter workflow: fixed ${pluralize(fixedErrors, "error")}; ${pluralize(linter.errors.length, "error")} remain.\n`,
    );

    return {
      data: buildSummaryData(linter, fixedErrors),
      display: `Done. Fixed ${fixedErrors} errors, ${linter.errors.length} remaining with \`${linter.command}\`.\n`,
      summary: `linter: fixed ${fixedErrors}, remaining ${linter.errors.length}`,
    };
  },
} satisfies Procedure;

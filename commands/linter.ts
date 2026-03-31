import { isAbsolute, relative, resolve } from "node:path";

import { expectData } from "../src/run-result.ts";
import type {
  CommandContext,
  Procedure,
  TypeDescriptor,
} from "../src/types.ts";

export interface LinterError {
  file: string;
  line: number;
  column: number;
  message: string;
  rule: string;
}

interface FileErrorGroup {
  normalizedFile: string;
  displayFile: string;
  errors: LinterError[];
}

interface LinterRunResult {
  status: "configured" | "missing_linter";
  command: string | null;
  summary: string;
  errors: LinterError[];
  recommendations: string[];
}

const LinterRunResultType: TypeDescriptor<LinterRunResult> = {
  schema: {
    type: "object",
    properties: {
      status: { enum: ["configured", "missing_linter"] },
      command: {
        anyOf: [
          { type: "string" },
          { type: "null" },
        ],
      },
      summary: { type: "string" },
      errors: {
        type: "array",
        items: {
          type: "object",
          properties: {
            file: { type: "string" },
            line: { type: "number" },
            column: { type: "number" },
            message: { type: "string" },
            rule: { type: "string" },
          },
          required: ["file", "line", "column", "message", "rule"],
          additionalProperties: false,
        },
      },
      recommendations: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["status", "command", "summary", "errors", "recommendations"],
    additionalProperties: false,
  },
  validate(input: unknown): input is LinterRunResult {
    return isLinterRunResult(input);
  },
};

const MAX_ROUNDS = 3;

function isLinterError(input: unknown): input is LinterError {
  return (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { file?: unknown }).file === "string" &&
    typeof (input as { line?: unknown }).line === "number" &&
    typeof (input as { column?: unknown }).column === "number" &&
    typeof (input as { message?: unknown }).message === "string" &&
    typeof (input as { rule?: unknown }).rule === "string"
  );
}

function isLinterRunResult(input: unknown): input is LinterRunResult {
  return (
    typeof input === "object" &&
    input !== null &&
    ((input as { status?: unknown }).status === "configured" || (input as { status?: unknown }).status === "missing_linter") &&
    (typeof (input as { command?: unknown }).command === "string" || (input as { command?: unknown }).command === null) &&
    typeof (input as { summary?: unknown }).summary === "string" &&
    Array.isArray((input as { errors?: unknown }).errors) &&
    (input as { errors: unknown[] }).errors.every((error) => isLinterError(error)) &&
    Array.isArray((input as { recommendations?: unknown }).recommendations) &&
    (input as { recommendations: unknown[] }).recommendations.every((item) => typeof item === "string")
  );
}

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

function buildDiscoveryPrompt(cwd: string, prompt: string, command?: string): string {
  const commandInstruction = command
    ? [
        `Use this exact linter command and run it from ${cwd}: ${command}`,
        "Do not invent a different command unless this one clearly no longer works.",
      ].join("\n")
    : [
        `Inspect the repo at ${cwd} and figure out whether an existing linter is configured.`,
        "Check package.json scripts and common config files if needed.",
        "If a linter appears to be configured, try to actually run it.",
      ].join("\n");

  return [
    commandInstruction,
    "Do not install or configure anything.",
    "If no linter is configured or runnable, return status `missing_linter` with a short complaint and 1-3 concrete recommendations.",
    "If a linter exists, return status `configured`, the exact command you used, a short summary, and all current lint errors.",
    "If the linter runs successfully with zero errors, return status `configured` and an empty errors array.",
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

async function runLinter(
  ctx: CommandContext,
  prompt: string,
  command?: string,
): Promise<LinterRunResult> {
  const result = await ctx.callAgent(
    buildDiscoveryPrompt(ctx.cwd, prompt, command),
    LinterRunResultType,
    { stream: false },
  );

  return expectData(result, "Linter discovery returned no data");
}

function buildMissingLinterResult(linter: LinterRunResult, fixedErrors: number) {
  const recommendations = renderRecommendations(linter.recommendations);

  return {
    data: buildSummaryData(linter, fixedErrors),
    display: `${linter.summary}\n${recommendations ? `${recommendations}\n` : ""}`,
    summary: linter.summary,
  };
}

function buildSummaryData(linter: LinterRunResult, fixedErrors: number) {
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

    ctx.print("Starting linter workflow...\n");
    let linter = await runLinter(ctx, prompt);

    if (linter.status === "missing_linter" || !linter.command) {
      ctx.print("No runnable linter found.\n");
      return buildMissingLinterResult(linter, fixedErrors);
    }

    const initialGroups = groupErrorsByFile(ctx.cwd, linter.errors);
    ctx.print(
      `Using \`${linter.command}\`. Found ${pluralize(linter.errors.length, "error")} across ${pluralize(initialGroups.length, "file")}.\n`,
    );

    if (linter.errors.length === 0) {
      ctx.print("Repo is already lint-clean.\n");
      return {
        data: buildSummaryData(linter, fixedErrors),
        display: `Linter command \`${linter.command}\` ran cleanly. ${linter.summary}\n`,
        summary: `linter: clean (${linter.command})`,
      };
    }

    for (let round = 0; round < MAX_ROUNDS && linter.errors.length > 0; round += 1) {
      const fileGroups = groupErrorsByFile(ctx.cwd, linter.errors);
      let fixedThisRound = 0;

      ctx.print(
        `Round ${round + 1}/${MAX_ROUNDS}: ${pluralize(linter.errors.length, "error")} across ${pluralize(fileGroups.length, "file")}.\n`,
      );

      for (const fileGroup of fileGroups) {
        const currentGroup = findErrorGroup(ctx.cwd, linter.errors, fileGroup.normalizedFile);
        if (!currentGroup) {
          continue;
        }

        const beforeCount = currentGroup.errors.length;
        ctx.print(`Fixing ${pluralize(beforeCount, "error")} in \`${currentGroup.displayFile}\`...\n`);

        await ctx.callAgent(buildFixPrompt(currentGroup), { stream: false });

        linter = await runLinter(ctx, prompt, linter.command);
        if (linter.status === "missing_linter" || !linter.command) {
          ctx.print("Linter stopped being runnable; stopping early.\n");
          return buildMissingLinterResult(linter, fixedErrors);
        }

        const afterCount = findErrorGroup(
          ctx.cwd,
          linter.errors,
          currentGroup.normalizedFile,
        )?.errors.length ?? 0;
        const resolvedCount = Math.max(0, beforeCount - afterCount);

        if (resolvedCount === 0) {
          ctx.print(`No progress in \`${currentGroup.displayFile}\`.\n`);
          continue;
        }

        fixedThisRound += resolvedCount;
        fixedErrors += resolvedCount;
        ctx.print(
          `Resolved ${pluralize(resolvedCount, "error")} in \`${currentGroup.displayFile}\`; ${pluralize(linter.errors.length, "error")} remain.\n`,
        );
        await ctx.callProcedure("commit", `linter fixes for ${currentGroup.displayFile}`);

        if (linter.errors.length === 0) {
          break;
        }
      }

      if (fixedThisRound === 0) {
        ctx.print("No further progress this round; stopping.\n");
        break;
      }
    }

    ctx.print(
      `Completed linter workflow: fixed ${pluralize(fixedErrors, "error")}; ${pluralize(linter.errors.length, "error")} remain.\n`,
    );

    return {
      data: buildSummaryData(linter, fixedErrors),
      display: `Done. Fixed ${fixedErrors} errors, ${linter.errors.length} remaining with \`${linter.command}\`.\n`,
      summary: `linter: fixed ${fixedErrors}, remaining ${linter.errors.length}`,
    };
  },
} satisfies Procedure;

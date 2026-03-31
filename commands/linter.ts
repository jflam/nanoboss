import { isAbsolute, relative, resolve } from "node:path";

import {
  type CommandContext,
  type KernelValue,
  type Procedure,
  type RunResult,
  type TypeDescriptor,
  type ValueRef,
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

interface LintFixResult {
  applied: boolean;
  description: string;
}

const LinterRunResultType: TypeDescriptor<LinterRunResult> = {
  schema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["configured", "missing_linter"],
      },
      command: {
        type: ["string", "null"],
      },
      summary: {
        type: "string",
      },
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
    return (
      typeof input === "object" &&
      input !== null &&
      "status" in input &&
      ((input as { status: unknown }).status === "configured" ||
        (input as { status: unknown }).status === "missing_linter") &&
      "command" in input &&
      ((input as { command: unknown }).command === null ||
        typeof (input as { command: unknown }).command === "string") &&
      "summary" in input &&
      typeof (input as { summary: unknown }).summary === "string" &&
      "errors" in input &&
      Array.isArray((input as { errors: unknown }).errors) &&
      (input as { errors: unknown[] }).errors.every(
        (item) => isLinterError(item),
      ) &&
      "recommendations" in input &&
      Array.isArray((input as { recommendations: unknown }).recommendations) &&
      (input as { recommendations: unknown[] }).recommendations.every(
        (item) => typeof item === "string",
      )
    );
  },
};

const LintFixResultType: TypeDescriptor<LintFixResult> = {
  schema: {
    type: "object",
    properties: {
      applied: { type: "boolean" },
      description: { type: "string" },
    },
    required: ["applied", "description"],
    additionalProperties: false,
  },
  validate(input: unknown): input is LintFixResult {
    return (
      typeof input === "object" &&
      input !== null &&
      "applied" in input &&
      typeof (input as { applied: unknown }).applied === "boolean" &&
      "description" in input &&
      typeof (input as { description: unknown }).description === "string"
    );
  },
};

const MAX_RETRIES = 3;
const MAX_FIX_RETRIES = 2;

function isLinterError(item: unknown): item is LinterError {
  if (typeof item !== "object" || item === null) {
    return false;
  }

  const candidate = item as Partial<LinterError>;
  return (
    typeof candidate.file === "string" &&
    typeof candidate.line === "number" &&
    typeof candidate.column === "number" &&
    typeof candidate.message === "string" &&
    typeof candidate.rule === "string"
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

function getFileErrorGroup(
  cwd: string,
  errors: LinterError[],
  normalizedFile: string,
): FileErrorGroup | undefined {
  return groupErrorsByFile(cwd, errors).find((group) => group.normalizedFile === normalizedFile);
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
    "Return whether the targeted file-level fix was successful.",
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

async function runLinter(
  ctx: CommandContext,
  prompt: string,
  command?: string,
): Promise<RunResult<LinterRunResult>> {
  const result = await ctx.callAgent(
    buildDiscoveryPrompt(ctx.cwd, prompt, command),
    LinterRunResultType,
  );

  requireData(result, "Linter discovery returned no data");
  return result;
}

export default {
  name: "linter",
  description: "Fix all linter errors in the project",
  inputHint: "Optional focus area or instructions",
  async execute(prompt, ctx) {
    let retries = 0;
    let totalFixed = 0;
    let totalFailed = 0;

    let linterRun = await runLinter(ctx, prompt);
    let linter = requireData(linterRun, "Missing linter result");
    if (linter.status === "missing_linter" || !linter.command) {
      const recommendations = renderRecommendations(linter.recommendations);
      return {
        data: buildSummaryData(linterRun, linter, totalFixed, totalFailed),
        display: `${linter.summary}\n${recommendations ? `${recommendations}\n` : ""}`,
        summary: linter.summary,
      };
    }

    let linterCommand = linter.command;
    let errors = linter.errors;

    if (errors.length === 0) {
      return {
        data: buildSummaryData(linterRun, linter, totalFixed, totalFailed),
        display: `Linter command \`${linterCommand}\` ran cleanly. ${linter.summary}\n`,
        summary: `linter: clean (${linterCommand})`,
      };
    }

    while (errors.length > 0 && retries < MAX_RETRIES) {
      const fileGroups = groupErrorsByFile(ctx.cwd, errors);
      ctx.print(
        `Round ${retries + 1}: ${errors.length} errors across ${fileGroups.length} files with \`${linterCommand}\`\n`,
      );

      for (const fileGroup of fileGroups) {
        const activeGroup = getFileErrorGroup(
          ctx.cwd,
          errors,
          fileGroup.normalizedFile,
        );
        if (!activeGroup || activeGroup.errors.length === 0) {
          continue;
        }

        const beforeCount = activeGroup.errors.length;
        let fixRetries = 0;
        let agentReportedFixed = false;

        ctx.print(
          `Fixing ${beforeCount} errors in \`${activeGroup.displayFile}\`\n`,
        );

        while (fixRetries < MAX_FIX_RETRIES) {
          const result = await ctx.callAgent(
            buildFixPrompt(activeGroup),
            LintFixResultType,
          );
          fixRetries += 1;
          const fixData = requireData(result, "Missing fix result");
          if (fixData.applied) {
            agentReportedFixed = true;
            break;
          }
        }

        linterRun = await runLinter(ctx, prompt, linterCommand);
        linter = requireData(linterRun, "Missing rerun linter result");
        if (linter.status === "missing_linter" || !linter.command) {
          const recommendations = renderRecommendations(linter.recommendations);
          return {
            data: buildSummaryData(linterRun, linter, totalFixed, totalFailed),
            display: `${linter.summary}\n${recommendations ? `${recommendations}\n` : ""}`,
            summary: linter.summary,
          };
        }

        linterCommand = linter.command;
        errors = linter.errors;

        const remainingGroup = getFileErrorGroup(
          ctx.cwd,
          errors,
          activeGroup.normalizedFile,
        );
        const afterCount = remainingGroup?.errors.length ?? 0;
        const resolvedCount = Math.max(0, beforeCount - afterCount);

        if (resolvedCount > 0) {
          totalFixed += resolvedCount;
          await ctx.callProcedure(
            "commit",
            `linter fixes for ${activeGroup.displayFile}`,
          );
        } else if (!agentReportedFixed) {
          totalFailed += beforeCount;
        } else {
          totalFailed += beforeCount;
        }

        if (errors.length === 0) {
          break;
        }
      }

      retries += 1;
    }

    return {
      data: buildSummaryData(linterRun, linter, totalFixed, totalFailed),
      display: `Done. Fixed ${totalFixed} errors, ${totalFailed} failed, ${errors.length} remaining with \`${linterCommand}\`.\n`,
      summary: `linter: fixed ${totalFixed}, remaining ${errors.length}`,
    };
  },
} satisfies Procedure;

function buildSummaryData(
  linterRun: RunResult<LinterRunResult>,
  linter: LinterRunResult,
  fixedErrors: number,
  failedErrors: number,
): {
  status: LinterRunResult["status"];
  command: string | null;
  linterRun: ValueRef;
  fixedErrors: number;
  failedErrors: number;
  remainingErrors: number;
} {
  return {
    status: linter.status,
    command: linter.command,
    linterRun: requireDataRef(linterRun, "Missing linter run ref"),
    fixedErrors,
    failedErrors,
    remainingErrors: linter.errors.length,
  };
}

function requireData<T extends KernelValue>(result: RunResult<T>, message: string): T {
  if (result.data === undefined) {
    throw new Error(message);
  }

  return result.data;
}

function requireDataRef<T extends KernelValue>(result: RunResult<T>, message: string): ValueRef {
  if (!result.dataRef) {
    throw new Error(message);
  }

  return result.dataRef;
}

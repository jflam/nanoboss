import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import typia from "typia";

import { expectData, expectDataRef } from "../src/core/run-result.ts";
import {
  jsonType,
  type ProcedureApi,
  type Procedure,
} from "../src/core/types.ts";

interface ResearchBrief {
  researchQuestion: string;
  contextSummary: string;
  mustCover: string[];
  constraints: string[];
}

interface ResearchResult {
  report: string;
  abstract: string;
  descriptionWords: string[];
}

const ResearchBriefType = jsonType<ResearchBrief>(
  typia.json.schema<ResearchBrief>(),
  typia.createValidate<ResearchBrief>(),
);

const ResearchResultType = jsonType<ResearchResult>(
  typia.json.schema<ResearchResult>(),
  typia.createValidate<ResearchResult>(),
);

const DESCRIPTION_WORD_COUNT = 3;

export default {
  name: "research",
  description: "Research a topic with a cited report and abstract",
  inputHint: "Research question or topic",
  async execute(prompt, ctx) {
    const trimmed = prompt.trim();
    if (!trimmed) {
      return {
        display: "Provide a research prompt for /research.\n",
        summary: "research: missing prompt",
      };
    }

    ctx.ui.text("Starting research...\n");
    ctx.ui.text("Preparing a research brief from the current conversation...\n");

    const briefResult = await ctx.agent.run(
      buildResearchBriefPrompt(trimmed),
      ResearchBriefType,
      {
        session: "default",
        stream: false,
      },
    );
    const brief = expectData(briefResult, "Research brief returned no data");
    const briefDataRef = expectDataRef(briefResult, "Research brief returned no data ref");

    if (!brief.researchQuestion.trim()) {
      throw new Error("Research brief question was empty");
    }

    ctx.ui.text("Dispatching an isolated research agent...\n");

    const result = await ctx.agent.run(
      buildResearchExecutionPrompt(trimmed),
      ResearchResultType,
      {
        refs: {
          brief: briefDataRef,
        },
        stream: false,
      },
    );
    const research = expectData(result, "Research returned no data");

    if (!research.report.trim()) {
      throw new Error("Research report was empty");
    }

    if (!research.abstract.trim()) {
      throw new Error("Research abstract was empty");
    }

    const descriptionWords = normalizeDescriptionWords(research.descriptionWords);
    const reportPath = await writeReportToPlans(ctx, research.report, descriptionWords);
    ctx.ui.text(`Wrote detailed report to ${reportPath}.\n`);

    ctx.ui.text("Completed research.\n");

    return {
      data: {
        report: research.report,
        abstract: research.abstract,
      },
      display: renderDisplay(research.abstract, reportPath),
      summary: buildSummary(trimmed, reportPath),
      memory: buildMemory(trimmed, reportPath),
    };
  },
} satisfies Procedure;

function buildResearchBriefPrompt(prompt: string): string {
  return [
    "You are preparing a research brief for a separate worker agent.",
    "Use the current conversation and the user request below to clarify the task.",
    "Return a JSON object with exactly four fields: `researchQuestion`, `contextSummary`, `mustCover`, and `constraints`.",
    "`researchQuestion` must restate the core research task as a single explicit question or objective.",
    "`contextSummary` must capture the relevant chat context that the worker should know before researching.",
    "`mustCover` must be an array of concrete points the final report should address.",
    "`constraints` must be an array of concrete limitations, preferences, or uncertainties from the conversation.",
    "If the conversation does not provide extra context for a field, use an empty string or empty array rather than inventing details.",
    "Return no extra keys and no prose outside the JSON object.",
    "",
    `User request:\n${prompt}`,
  ].join("\n");
}

function buildResearchExecutionPrompt(prompt: string): string {
  return [
    "You are a research agent working from the referenced brief `brief`.",
    "Treat `brief.researchQuestion` as the primary task.",
    "Use `brief.contextSummary`, `brief.mustCover`, and `brief.constraints` to scope the work.",
    "Research the user's request and return a JSON object with exactly three fields: `report`, `abstract`, and `descriptionWords`.",
    "`report` must be a detailed Markdown research report.",
    "Every researched factual claim in `report` must have an inline citation immediately adjacent to the claim.",
    "Do not include any uncited factual claims in `report`; if a fact cannot be sourced, omit it or mark it clearly as uncertainty.",
    "Include a `## Sources` section at the end of `report` listing every cited source with enough detail to identify it, including URLs when available.",
    "`abstract` must be a concise executive summary for the calling agent.",
    "Keep the abstract self-contained and focused on the most important findings and uncertainties.",
    "`descriptionWords` must be an array of exactly 3 short descriptive lowercase words for a filename slug.",
    "Choose words that capture the topic of the research rather than generic words like report or research.",
    "Return no extra keys and no prose outside the JSON object.",
    "",
    `Original user request:\n${prompt}`,
  ].join("\n");
}

async function writeReportToPlans(
  ctx: ProcedureApi,
  report: string,
  descriptionWords: string[],
): Promise<string> {
  const plansDir = join(ctx.cwd, "plans");
  await mkdir(plansDir, { recursive: true });

  const datePrefix = new Date().toISOString().slice(0, 10);
  const serial = await nextPlanSerial(plansDir, datePrefix);
  const description = descriptionWords.join("-");
  const relativePath = `plans/${datePrefix}-${serial}-${description}.md`;
  const absolutePath = join(ctx.cwd, relativePath);

  await Bun.write(absolutePath, ensureTrailingNewline(report));

  return relativePath;
}

async function nextPlanSerial(plansDir: string, datePrefix: string): Promise<number> {
  const entries = await readdir(plansDir, { withFileTypes: true });
  const matcher = new RegExp(`^${escapeRegExp(datePrefix)}-(\\d+)-`);

  let maxSerial = 0;
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const match = entry.name.match(matcher);
    if (!match) {
      continue;
    }

    const capturedSerial = match[1];
    if (!capturedSerial) {
      continue;
    }

    const serial = Number.parseInt(capturedSerial, 10);
    if (Number.isFinite(serial)) {
      maxSerial = Math.max(maxSerial, serial);
    }
  }

  return maxSerial > 0 ? maxSerial + 1 : 1;
}

function normalizeDescriptionWords(words: string[]): string[] {
  const normalized = words
    .flatMap((word) => word.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .slice(0, DESCRIPTION_WORD_COUNT);

  while (normalized.length < DESCRIPTION_WORD_COUNT) {
    normalized.push("research");
  }

  return normalized;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
}

function renderDisplay(abstract: string, reportPath: string): string {
  return `${abstract.trim()}\n\nDetailed report written to ${reportPath}.\n`;
}

function buildSummary(prompt: string, reportPath: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  const subject = compact.length > 60 ? `${compact.slice(0, 57)}...` : compact;
  return `research: ${subject} -> ${reportPath}`;
}

function buildMemory(prompt: string, reportPath: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return `Research completed for ${compact}. The cited report was also written to ${reportPath}.`;
}

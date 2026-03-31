import { expectData, expectDataRef } from "../src/run-result.ts";
import type {
  Procedure,
  TypeDescriptor,
} from "../src/types.ts";

interface CritiqueResult {
  verdict: "sound" | "mixed" | "flawed";
  summary: string;
  issues: string[];
  revisedAnswer: string;
}

const CritiqueResultType: TypeDescriptor<CritiqueResult> = {
  schema: {
    type: "object",
    properties: {
      verdict: { enum: ["sound", "mixed", "flawed"] },
      summary: { type: "string" },
      issues: {
        type: "array",
        items: { type: "string" },
      },
      revisedAnswer: { type: "string" },
    },
    required: ["verdict", "summary", "issues", "revisedAnswer"],
    additionalProperties: false,
  },
  validate(input: unknown): input is CritiqueResult {
    return (
      typeof input === "object" &&
      input !== null &&
      ((input as { verdict?: unknown }).verdict === "sound" ||
        (input as { verdict?: unknown }).verdict === "mixed" ||
        (input as { verdict?: unknown }).verdict === "flawed") &&
      typeof (input as { summary?: unknown }).summary === "string" &&
      Array.isArray((input as { issues?: unknown }).issues) &&
      (input as { issues: unknown[] }).issues.every((issue) => typeof issue === "string") &&
      typeof (input as { revisedAnswer?: unknown }).revisedAnswer === "string"
    );
  },
};

export default {
  name: "second-opinion",
  description: "Get a Claude answer, then ask Codex to critique and revise it",
  inputHint: "Question or task to review",
  async execute(prompt, ctx) {
    const trimmed = prompt.trim();
    if (!trimmed) {
      return {
        display: "Provide a question or task for /second-opinion.\n",
        summary: "second-opinion: missing prompt",
      };
    }

    ctx.print("Starting second-opinion workflow...\n");
    ctx.print("Asking Claude for the first answer...\n");

    const firstPass = await ctx.callAgent(
      buildClaudePrompt(trimmed),
      {
        agent: {
          provider: "claude",
          model: "opus",
        },
        stream: false,
      },
    );
    const firstPassDataRef = expectDataRef(firstPass, "Missing first-pass data ref");
    const firstPassText = firstPass.data ?? "";

    ctx.print("Asking Codex to critique the answer...\n");

    const critique = await ctx.callAgent(
      [
        "Critique the referenced answer `answer` and return a critique object.",
        "Use the original user request below as the task being answered.",
        "",
        `Original user request:\n${trimmed}`,
      ].join("\n"),
      CritiqueResultType,
      {
        agent: {
          provider: "codex",
          model: "gpt-5.4",
        },
        stream: false,
        refs: {
          answer: firstPassDataRef,
        },
      },
    );
    const critiqueData: CritiqueResult = expectData(critique, "Missing critique data");
    const critiqueDataRef = expectDataRef(critique, "Missing critique data ref");

    ctx.print(`Completed second-opinion workflow with verdict: ${critiqueData.verdict}.\n`);

    return {
      data: {
        subject: trimmed,
        answer: firstPassDataRef,
        critique: critiqueDataRef,
        verdict: critiqueData.verdict,
      },
      display: renderSecondOpinion(firstPassText, critiqueData),
      summary: `second-opinion: ${trimmed} (${critiqueData.verdict})`,
    };
  },
} satisfies Procedure;

function buildClaudePrompt(prompt: string): string {
  return [
    "Answer the user's request directly.",
    "Be explicit about assumptions and uncertainty.",
    "Prefer a concise but complete answer.",
    "",
    `User request:\n${prompt}`,
  ].join("\n");
}

function renderSecondOpinion(
  firstPass: string,
  critique: CritiqueResult,
): string {
  const issueLines = critique.issues.length > 0
    ? critique.issues.map((issue) => `- ${issue}`).join("\n")
    : "- none";

  return [
    "Claude (opus)",
    firstPass.trim(),
    "",
    "Codex critique (gpt-5.4)",
    `Verdict: ${critique.verdict}`,
    critique.summary.trim(),
    "",
    "Issues",
    issueLines,
    "",
    "Revised answer",
    critique.revisedAnswer.trim(),
    "",
  ].join("\n");
}

import type { Procedure } from "../src/types.ts";

interface CritiqueResult {
  verdict: "sound" | "mixed" | "flawed";
  summary: string;
  issues: string[];
  revisedAnswer: string;
}

const CritiqueResultType = {
  schema: {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        enum: ["sound", "mixed", "flawed"],
      },
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
      "verdict" in input &&
      (
        (input as { verdict: unknown }).verdict === "sound" ||
        (input as { verdict: unknown }).verdict === "mixed" ||
        (input as { verdict: unknown }).verdict === "flawed"
      ) &&
      "summary" in input &&
      typeof (input as { summary: unknown }).summary === "string" &&
      "issues" in input &&
      Array.isArray((input as { issues: unknown }).issues) &&
      (input as { issues: unknown[] }).issues.every((item) => typeof item === "string") &&
      "revisedAnswer" in input &&
      typeof (input as { revisedAnswer: unknown }).revisedAnswer === "string"
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
      ctx.print("Provide a question or task for /second-opinion.\n");
      return;
    }

    const firstPass = await ctx.callAgent(
      buildClaudePrompt(trimmed),
      undefined,
      {
        agent: {
          provider: "claude",
          model: "opus",
        },
        stream: false,
      },
    );

    const critique = await ctx.callAgent<CritiqueResult>(
      buildCritiquePrompt(trimmed, firstPass.value),
      CritiqueResultType,
      {
        agent: {
          provider: "codex",
          model: "gpt-5.4",
        },
        stream: false,
      },
    );

    ctx.print(renderSecondOpinion(firstPass.value, critique.value));
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

function buildCritiquePrompt(prompt: string, answer: string): string {
  return [
    "You are providing a second opinion on another agent's answer.",
    "Critique the answer rigorously.",
    "Identify factual mistakes, weak assumptions, missing context, and places where the answer should be tightened.",
    "If the answer is already strong, say so briefly and keep the issues list empty.",
    "Always provide a revised answer that you would give instead.",
    "",
    `Original user request:\n${prompt}`,
    "",
    `Claude's answer:\n${answer}`,
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

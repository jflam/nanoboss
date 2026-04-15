import typia from "typia";

import {
  expectData,
  expectDataRef,
  formatAgentBanner,
  jsonType,
  type Procedure,
} from "@nanoboss/procedure-sdk";

interface CritiqueResult {
  verdict: "sound" | "mixed" | "flawed";
  summary: string;
  issues: string[];
  mainIssue: string | null;
  revisedAnswer: string;
}

const CritiqueResultType = jsonType<CritiqueResult>(
  typia.json.schema<CritiqueResult>(),
  typia.createValidate<CritiqueResult>(),
);

export default {
  name: "second-opinion",
  description: "Get a first answer using the current default model, then ask Codex to critique and revise it",
  inputHint: "Question or task to review",
  async execute(prompt, ctx) {
    const trimmed = prompt.trim();
    if (!trimmed) {
      return {
        display: "Provide a question or task for /second-opinion.\n",
        summary: "second-opinion: missing prompt",
      };
    }

    const firstPassAgent = ctx.session.getDefaultAgentConfig();
    const firstPassAgentLabel = formatAgentBanner(firstPassAgent);

    ctx.ui.text("Starting second-opinion workflow...\n");
    ctx.ui.text(`Asking the current default model (${firstPassAgentLabel}) for the first answer...\n`);

    const firstPass = await ctx.agent.run(
      buildFirstPassPrompt(trimmed),
      {
        stream: false,
      },
    );
    const firstPassDataRef = expectDataRef(firstPass, "Missing first-pass data ref");
    const firstPassText = firstPass.data ?? "";

    ctx.ui.text("Asking Codex to critique the answer...\n");

    const critique = await ctx.agent.run(
      [
        "Critique the referenced answer `answer` and return a critique object.",
        "Use the original user request below as the task being answered.",
        "Set `mainIssue` to the single most important problem with the answer.",
        "If the answer is sound and there is no meaningful problem, set `mainIssue` to null.",
        "Do not rely on issue ordering alone; explicitly choose the most important issue.",
        "",
        `Original user request:\n${trimmed}`,
      ].join("\n"),
      CritiqueResultType,
      {
        agent: {
          provider: "codex",
          model: "gpt-5.4/high",
        },
        stream: false,
        refs: {
          answer: firstPassDataRef,
        },
      },
    );
    const critiqueData: CritiqueResult = expectData(critique, "Missing critique data");
    const critiqueDataRef = expectDataRef(critique, "Missing critique data ref");

    ctx.ui.text(`Completed second-opinion workflow with verdict: ${critiqueData.verdict}.\n`);

    return {
      data: {
        subject: trimmed,
        answer: firstPassDataRef,
        critique: critiqueDataRef,
        verdict: critiqueData.verdict,
        mainIssue: critiqueData.mainIssue,
        critiqueMainIssue: critiqueData.mainIssue,
      },
      display: renderSecondOpinion(firstPassText, critiqueData, firstPassAgentLabel),
      summary: `second-opinion: ${trimmed} (${critiqueData.verdict})`,
      memory: buildSecondOpinionMemory(trimmed, critiqueData),
    };
  },
} satisfies Procedure;

function buildFirstPassPrompt(prompt: string): string {
  return [
    "Answer the user's request directly.",
    "Be explicit about assumptions and uncertainty.",
    "Prefer a concise but complete answer.",
    "",
    `User request:\n${prompt}`,
  ].join("\n");
}

function buildSecondOpinionMemory(
  subject: string,
  critique: CritiqueResult,
): string {
  const issueCount = critique.issues.length;
  const mainIssue = critique.mainIssue ?? critique.summary;

  return [
    `Second opinion for ${subject} was ${critique.verdict}.`,
    `Most important critique issue: ${mainIssue}.`,
    issueCount > 0
      ? `There ${issueCount === 1 ? "was 1 critique issue" : `were ${issueCount} critique issues`} total; exact issue details are available in the stored critique result.`
      : "No concrete critique issues were identified.",
  ].join(" ");
}

function renderSecondOpinion(
  firstPass: string,
  critique: CritiqueResult,
  firstPassAgentLabel: string,
): string {
  const issueLines = critique.issues.length > 0
    ? critique.issues.map((issue) => `- ${issue}`).join("\n")
    : "- none";

  return [
    `First answer (${firstPassAgentLabel})`,
    firstPass.trim(),
    "",
    "Codex critique (gpt-5.4/high)",
    `Verdict: ${critique.verdict}`,
    critique.summary.trim(),
    "",
    "Main critique issue",
    critique.mainIssue?.trim() || "none",
    "",
    "Issues",
    issueLines,
    "",
    "Revised answer",
    critique.revisedAnswer.trim(),
    "",
  ].join("\n");
}

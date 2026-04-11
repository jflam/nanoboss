import typia from "typia";

import { expectData } from "../../src/core/run-result.ts";
import { jsonType, type Procedure } from "../../src/core/types.ts";
import {
  answerIdFromPath,
  appendKnowledgeBaseLog,
  collapseWhitespace,
  needsSourceCompilation,
  normalizeDescriptionWords,
  normalizeWikiPathList,
  readAnswersManifest,
  readSourcesManifest,
  rebuildKnowledgeBaseIndex,
  saveAnswersManifest,
  summarizeList,
  writeDatedKnowledgeMarkdown,
  type AnswerManifestEntry,
  type KnowledgeBaseAnswerData,
} from "./lib/repository.ts";

interface KnowledgeAnswerResult {
  title: string;
  abstract: string;
  descriptionWords: string[];
  citedPages: string[];
  answerMarkdown: string;
}

const KnowledgeAnswerResultType = jsonType<KnowledgeAnswerResult>(
  typia.json.schema<KnowledgeAnswerResult>(),
  typia.createValidate<KnowledgeAnswerResult>(),
);

export default {
  name: "kb/answer",
  description: "Answer a question against the compiled knowledge base",
  inputHint: "Question to answer from wiki/index.md and compiled pages",
  async execute(prompt, ctx) {
    const question = prompt.trim();
    if (!question) {
      return {
        display: "Provide a question for /kb/answer.\n",
        summary: "kb/answer: missing prompt",
      };
    }

    const compiledSources = (await readSourcesManifest(ctx.cwd))
      .filter((entry) => entry.summaryPath && !needsSourceCompilation(entry));
    if (compiledSources.length === 0) {
      return {
        display: "No compiled source pages are available yet. Run /kb/refresh first.\n",
        summary: "kb/answer: missing corpus",
      };
    }

    ctx.ui.text("Answering from the compiled knowledge base...\n");
    const answerResult = await ctx.agent.run(
      buildAnswerPrompt(question),
      KnowledgeAnswerResultType,
      { stream: false },
    );
    const answer = expectData(answerResult, "Knowledge-base answer returned no data");

    if (!answer.answerMarkdown.trim()) {
      throw new Error("Knowledge-base answer markdown was empty");
    }

    if (!answer.title.trim()) {
      throw new Error("Knowledge-base answer title was empty");
    }

    if (!answer.abstract.trim()) {
      throw new Error("Knowledge-base answer abstract was empty");
    }

    const answerPath = await writeDatedKnowledgeMarkdown(
      ctx.cwd,
      "wiki/answers",
      normalizeDescriptionWords(answer.descriptionWords, `${answer.title} ${question}`),
      answer.answerMarkdown,
    );
    const entry: AnswerManifestEntry = {
      answerId: answerIdFromPath(answerPath),
      question: collapseWhitespace(question),
      title: collapseWhitespace(answer.title),
      abstract: collapseWhitespace(answer.abstract),
      answerPath,
      createdAt: new Date().toISOString(),
      citedPages: normalizeWikiPathList(answer.citedPages),
    };

    const existingAnswers = await readAnswersManifest(ctx.cwd);
    await saveAnswersManifest(
      ctx.cwd,
      [entry, ...existingAnswers.filter((answerEntry) => answerEntry.answerPath !== answerPath)],
    );

    const indexPath = await rebuildKnowledgeBaseIndex(ctx.cwd);
    await appendKnowledgeBaseLog(
      ctx.cwd,
      "answer",
      entry.title,
      [
        `question: ${entry.question}`,
        `answer page: \`${answerPath}\``,
        `cited pages: ${entry.citedPages.length > 0 ? summarizeList(entry.citedPages) : "none"}`,
        `index: \`${indexPath}\``,
      ],
    );

    ctx.ui.text(`Wrote ${answerPath}.\n`);

    const data: KnowledgeBaseAnswerData = {
      answerId: entry.answerId,
      answerPath,
      title: entry.title,
      citedPages: entry.citedPages,
    };

    return {
      data,
      display: `${entry.abstract}\n\nWrote answer page to ${answerPath}.\n`,
      summary: `kb/answer: ${truncateQuestion(question)} -> ${answerPath}`,
    };
  },
} satisfies Procedure;

function buildAnswerPrompt(question: string): string {
  return [
    "You are answering a question against a compiled wiki-style knowledge base.",
    "",
    "Workflow requirements:",
    "1. Read `wiki/index.md` first.",
    "2. Use the index to choose relevant pages under `wiki/`.",
    "3. Base the answer on compiled wiki pages, not raw sources, unless a necessary compiled page is missing.",
    "",
    "Return a JSON object with exactly these keys: `title`, `abstract`, `descriptionWords`, `citedPages`, `answerMarkdown`.",
    "",
    "Requirements:",
    "- `title`: concise answer-page title",
    "- `abstract`: short self-contained summary under 240 characters",
    "- `descriptionWords`: exactly 3 short lowercase words suitable for a filename slug",
    "- `citedPages`: repo-relative wiki page paths you actually relied on, e.g. `wiki/sources/foo.md`",
    "- `answerMarkdown`: a complete markdown page with sections `## Question`, `## Answer`, and `## Sources`",
    "- In `## Sources`, link the cited wiki pages and do not invent citations",
    "- If the compiled corpus is insufficient, say so plainly instead of guessing",
    "",
    `Question:\n${question}`,
  ].join("\n");
}

function truncateQuestion(question: string): string {
  const compact = collapseWhitespace(question);
  return compact.length > 60 ? `${compact.slice(0, 57)}...` : compact;
}

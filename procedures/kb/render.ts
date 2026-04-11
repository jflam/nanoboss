import typia from "typia";

import { expectData } from "../../src/core/run-result.ts";
import { jsonType, type Procedure } from "../../src/core/types.ts";
import {
  appendKnowledgeBaseLog,
  collapseWhitespace,
  normalizeDescriptionWords,
  optionalString,
  parseStructuredInput,
  readRendersManifest,
  rebuildKnowledgeBaseIndex,
  renderIdFromPath,
  saveRendersManifest,
  summarizeList,
  writeDatedKnowledgeMarkdown,
  type KnowledgeBaseRenderData,
  type KnowledgeRenderKind,
  type RenderManifestEntry,
} from "./lib/repository.ts";

interface RenderResult {
  title: string;
  abstract: string;
  descriptionWords: string[];
  outputMarkdown: string;
}

interface RenderOptions {
  kind: KnowledgeRenderKind;
  sourcePages: string[];
}

const RenderResultType = jsonType<RenderResult>(
  typia.json.schema<RenderResult>(),
  typia.createValidate<RenderResult>(),
);

export default {
  name: "kb/render",
  description: "Render derived reports or decks from stored KB pages",
  inputHint: "kind=report|deck page=wiki/concepts/foo.md",
  async execute(prompt, ctx) {
    const options = parseRenderOptions(prompt);
    if (options.sourcePages.length === 0) {
      return {
        display: "Provide at least one source page for /kb/render.\n",
        summary: "kb/render: missing source pages",
      };
    }

    for (const sourcePage of options.sourcePages) {
      if (!(await Bun.file(`${ctx.cwd}/${sourcePage}`).exists())) {
        throw new Error(`Render source page does not exist: ${sourcePage}`);
      }
    }

    ctx.ui.text(`Rendering ${options.kind} from ${options.sourcePages.length} page(s)...\n`);
    const result = await ctx.agent.run(
      buildRenderPrompt(options),
      RenderResultType,
      { stream: false },
    );
    const rendered = expectData(result, "Rendered output returned no data");

    if (!rendered.title.trim()) {
      throw new Error("Rendered output title was empty");
    }
    if (!rendered.abstract.trim()) {
      throw new Error("Rendered output abstract was empty");
    }
    if (!rendered.outputMarkdown.trim()) {
      throw new Error("Rendered output markdown was empty");
    }

    const outputPath = await writeDatedKnowledgeMarkdown(
      ctx.cwd,
      options.kind === "deck" ? "derived/slides" : "derived/reports",
      normalizeDescriptionWords(rendered.descriptionWords, `${rendered.title} ${options.kind}`),
      rendered.outputMarkdown,
    );
    const entry: RenderManifestEntry = {
      renderId: renderIdFromPath(outputPath),
      kind: options.kind,
      title: collapseWhitespace(rendered.title),
      abstract: collapseWhitespace(rendered.abstract),
      outputPath,
      createdAt: new Date().toISOString(),
      sourcePages: options.sourcePages,
    };

    const existing = await readRendersManifest(ctx.cwd);
    await saveRendersManifest(
      ctx.cwd,
      [entry, ...existing.filter((render) => render.outputPath !== outputPath)],
    );

    const indexPath = await rebuildKnowledgeBaseIndex(ctx.cwd);
    await appendKnowledgeBaseLog(
      ctx.cwd,
      "render",
      `${entry.kind} | ${entry.title}`,
      [
        `output: \`${outputPath}\``,
        `source pages: ${entry.sourcePages.length > 0 ? summarizeList(entry.sourcePages) : "none"}`,
        `index: \`${indexPath}\``,
      ],
    );

    ctx.ui.text(`Wrote ${outputPath}.\n`);

    const data: KnowledgeBaseRenderData = {
      renderId: entry.renderId,
      kind: entry.kind,
      outputPath,
      title: entry.title,
      sourcePages: entry.sourcePages,
    };

    return {
      data,
      display: `${entry.abstract}\n\nWrote ${entry.kind} output to ${outputPath}.\n`,
      summary: `kb/render: ${entry.kind} -> ${outputPath}`,
    };
  },
} satisfies Procedure;

function parseRenderOptions(prompt: string): RenderOptions {
  const structured = parseStructuredInput(prompt);
  if (!structured) {
    const sourcePage = normalizePagePath(prompt.trim());
    return {
      kind: "report",
      sourcePages: sourcePage ? [sourcePage] : [],
    };
  }

  const kind = normalizeKind(optionalString(structured.kind));
  const pages = collectSourcePages(structured);
  return {
    kind,
    sourcePages: pages.map((page) => normalizePagePath(page)).filter((page): page is string => Boolean(page)),
  };
}

function collectSourcePages(structured: Record<string, unknown>): string[] {
  const page = optionalString(structured.page);
  const pages = structured.pages;
  const values = [
    ...(page ? [page] : []),
    ...(Array.isArray(pages)
      ? pages.filter((value): value is string => typeof value === "string")
      : typeof pages === "string"
      ? pages.split(",")
      : []),
  ];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeKind(kind?: string): KnowledgeRenderKind {
  return kind === "deck" ? "deck" : "report";
}

function normalizePagePath(page: string): string | undefined {
  const trimmed = page.trim().replace(/^\.?\//, "");
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("wiki/")) {
    return trimmed;
  }
  if (trimmed.startsWith("concepts/") || trimmed.startsWith("sources/") || trimmed.startsWith("answers/")) {
    return `wiki/${trimmed}`;
  }
  return undefined;
}

function buildRenderPrompt(options: RenderOptions): string {
  return [
    `You are rendering a stored knowledge-base ${options.kind}.`,
    "",
    "Read these source pages from disk before answering:",
    ...options.sourcePages.map((page) => `- ${page}`),
    "",
    "Return a JSON object with exactly these keys: `title`, `abstract`, `descriptionWords`, `outputMarkdown`.",
    "",
    "Requirements:",
    "- `title`: concise title for the output artifact",
    "- `abstract`: short self-contained summary under 240 characters",
    "- `descriptionWords`: exactly 3 short lowercase words for the output filename slug",
    options.kind === "deck"
      ? "- `outputMarkdown`: a complete Marp-compatible markdown deck with frontmatter and slide separators"
      : "- `outputMarkdown`: a complete markdown report with a `## Source Material` section linking the source pages",
    "- Base the output only on the listed source pages",
    "- Do not invent citations or source material that is not in the listed pages",
    "",
    "Return no prose outside the JSON object.",
  ].join("\n");
}

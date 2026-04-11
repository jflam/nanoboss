import typia from "typia";
import { join } from "node:path";

import { expectData } from "../../src/core/run-result.ts";
import { jsonType, type Procedure } from "../../src/core/types.ts";
import {
  appendKnowledgeBaseLog,
  collapseWhitespace,
  needsSourceCompilation,
  normalizeStringList,
  normalizeTagList,
  optionalBoolean,
  optionalString,
  parseStructuredInput,
  readSourcesManifest,
  rebuildKnowledgeBaseIndex,
  saveSourcesManifest,
  sourceSummaryPath,
  summarizeList,
  type KnowledgeBaseCompileData,
  type SourceManifestEntry,
} from "./lib/repository.ts";

interface CompiledSourceResult {
  title: string;
  sourceType: string;
  abstract: string;
  concepts: string[];
  tags: string[];
  questions: string[];
  pageMarkdown: string;
}

interface CompileOptions {
  sourceId?: string;
  rawPath?: string;
  force: boolean;
  suppressLog: boolean;
  refreshIndex: boolean;
}

const CompiledSourceResultType = jsonType<CompiledSourceResult>(
  typia.json.schema<CompiledSourceResult>(),
  typia.createValidate<CompiledSourceResult>(),
);

export default {
  name: "kb/compile-source",
  description: "Compile one ingested source into a durable wiki page",
  inputHint: "sourceId=<id> or path=raw/article.md",
  async execute(prompt, ctx) {
    const options = parseCompileOptions(prompt);
    const sources = await readSourcesManifest(ctx.cwd);
    if (sources.length === 0) {
      throw new Error("No ingested sources found. Run /kb/ingest first.");
    }

    const target = resolveTargetSource(sources, options);
    if (!target) {
      throw new Error("Could not determine which source to compile. Provide sourceId=<id> or path=raw/file.");
    }

    if (!options.force && !needsSourceCompilation(target) && target.summaryPath) {
      const skippedData: KnowledgeBaseCompileData = {
        sourceId: target.sourceId,
        rawPath: target.rawPath,
        summaryPath: target.summaryPath,
        title: target.title ?? target.sourceId,
        status: "skipped",
      };

      return {
        data: skippedData,
        display: `${target.title ?? target.sourceId} is already compiled at ${target.summaryPath}.\n`,
        summary: `kb/compile-source: skipped ${target.sourceId}`,
      };
    }

    ctx.ui.text(`Compiling ${target.sourceId} from ${target.rawPath}...\n`);
    const result = await ctx.agent.run(
      buildCompilationPrompt(target),
      CompiledSourceResultType,
      { stream: false },
    );
    const compiled = expectData(result, "Source compilation returned no data");

    if (!compiled.pageMarkdown.trim()) {
      throw new Error("Compiled source page was empty");
    }

    if (!compiled.title.trim()) {
      throw new Error("Compiled source title was empty");
    }

    if (!compiled.abstract.trim()) {
      throw new Error("Compiled source abstract was empty");
    }

    const summaryPath = sourceSummaryPath(target.sourceId);
    await Bun.write(join(ctx.cwd, summaryPath), ensureTrailingNewline(compiled.pageMarkdown));

    const updatedEntry: SourceManifestEntry = {
      ...target,
      summaryPath,
      compiledContentHash: target.contentHash,
      compiledAt: new Date().toISOString(),
      title: collapseWhitespace(compiled.title),
      abstract: collapseWhitespace(compiled.abstract),
      sourceType: collapseWhitespace(compiled.sourceType).toLowerCase(),
      concepts: normalizeStringList(compiled.concepts),
      tags: normalizeTagList(compiled.tags),
      questions: normalizeStringList(compiled.questions),
    };

    const nextEntries = sources.map((entry) =>
      entry.sourceId === updatedEntry.sourceId ? updatedEntry : entry
    );
    await saveSourcesManifest(ctx.cwd, nextEntries);

    const indexPath = options.refreshIndex
      ? await rebuildKnowledgeBaseIndex(ctx.cwd)
      : "wiki/index.md";

    if (!options.suppressLog) {
      await appendKnowledgeBaseLog(
        ctx.cwd,
        "compile-source",
        `${updatedEntry.sourceId} -> ${summaryPath}`,
        [
          `raw source: \`${updatedEntry.rawPath}\``,
          `concepts: ${updatedEntry.concepts.length > 0 ? summarizeList(updatedEntry.concepts) : "none"}`,
          `tags: ${updatedEntry.tags.length > 0 ? summarizeList(updatedEntry.tags) : "none"}`,
          `index: \`${indexPath}\``,
        ],
      );
    }

    ctx.ui.text(`Wrote ${summaryPath}.\n`);

    const data: KnowledgeBaseCompileData = {
      sourceId: updatedEntry.sourceId,
      rawPath: updatedEntry.rawPath,
      summaryPath,
      title: updatedEntry.title ?? updatedEntry.sourceId,
      status: "compiled",
    };

    return {
      data,
      display: `${updatedEntry.abstract}\n\nCompiled ${updatedEntry.rawPath} -> ${summaryPath}.\n`,
      summary: `kb/compile-source: ${updatedEntry.sourceId} -> ${summaryPath}`,
    };
  },
} satisfies Procedure;

function buildCompilationPrompt(source: SourceManifestEntry): string {
  return [
    "You are compiling one raw source into a durable knowledge-base page.",
    `Source id: ${source.sourceId}`,
    `Raw path: ${source.rawPath}`,
    `Target page: ${sourceSummaryPath(source.sourceId)}`,
    "",
    "Read the raw source from disk. Use repo tools as needed.",
    "Focus on this source only. Do not modify any files yourself.",
    "Return a JSON object with exactly these keys: `title`, `sourceType`, `abstract`, `concepts`, `tags`, `questions`, `pageMarkdown`.",
    "",
    "Requirements:",
    "- `title`: concise human-readable page title",
    "- `sourceType`: short lowercase label such as article, paper, repo, note, dataset, image-set, or other",
    "- `abstract`: 1-3 sentences, self-contained, under 240 characters",
    "- `concepts`, `tags`, and `questions`: short arrays with no more than 8 items each",
    "- `pageMarkdown` must be a complete markdown page for the target file",
    "- `pageMarkdown` must include sections titled `## Source`, `## Summary`, `## Key Points`, and `## Open Questions`",
    "- In `## Source`, include the source id and raw path exactly",
    "- Ground every claim in the raw source; if something is uncertain or inferred, say so explicitly",
    "- Do not invent facts, citations, or cross-source comparisons you did not verify from this source",
    "",
    "Return no prose outside the JSON object.",
  ].join("\n");
}

function parseCompileOptions(prompt: string): CompileOptions {
  const structured = parseStructuredInput(prompt);
  if (!structured) {
    const trimmed = prompt.trim();
    return {
      sourceId: trimmed && !trimmed.startsWith("raw/") ? trimmed : undefined,
      rawPath: trimmed.startsWith("raw/") ? trimmed : undefined,
      force: false,
      suppressLog: false,
      refreshIndex: true,
    };
  }

  return {
    sourceId: optionalString(structured.sourceId) ?? optionalString(structured.source),
    rawPath: optionalString(structured.path) ?? optionalString(structured.rawPath),
    force: optionalBoolean(structured.force, "force") ?? false,
    suppressLog: optionalBoolean(structured.suppressLog, "suppressLog") ?? false,
    refreshIndex: optionalBoolean(structured.refreshIndex, "refreshIndex") ?? true,
  };
}

function resolveTargetSource(
  sources: SourceManifestEntry[],
  options: CompileOptions,
): SourceManifestEntry | undefined {
  if (options.sourceId) {
    return sources.find((entry) => entry.sourceId === options.sourceId);
  }

  if (options.rawPath) {
    const normalizedRawPath = normalizeRawPath(options.rawPath);
    return sources.find((entry) => entry.rawPath === normalizedRawPath);
  }

  const pending = sources.filter(needsSourceCompilation);
  if (pending.length === 1) {
    return pending[0];
  }

  if (sources.length === 1) {
    return sources[0];
  }

  return undefined;
}

function normalizeRawPath(rawPath: string): string {
  const trimmed = rawPath.trim().replace(/^\.?\//, "");
  return trimmed.startsWith("raw/") ? trimmed : `raw/${trimmed}`;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

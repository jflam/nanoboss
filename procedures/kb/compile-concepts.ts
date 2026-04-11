import { createHash } from "node:crypto";
import { join } from "node:path";

import typia from "typia";

import { expectData } from "../../src/core/run-result.ts";
import { jsonType, type Procedure } from "../../src/core/types.ts";
import {
  appendKnowledgeBaseLog,
  collapseWhitespace,
  conceptPagePath,
  needsSourceCompilation,
  normalizeConceptId,
  normalizeConceptIdList,
  optionalBoolean,
  optionalString,
  parseStructuredInput,
  readConceptsManifest,
  readSourcesManifest,
  rebuildKnowledgeBaseIndex,
  saveConceptsManifest,
  summarizeList,
  type ConceptManifestEntry,
  type KnowledgeBaseCompileConceptsData,
  type SourceManifestEntry,
} from "./lib/repository.ts";

interface CompiledConceptResult {
  title: string;
  abstract: string;
  relatedConcepts: string[];
  pageMarkdown: string;
}

interface CompileConceptOptions {
  concept?: string;
  force: boolean;
  suppressLog: boolean;
  refreshIndex: boolean;
}

interface ConceptTarget {
  conceptId: string;
  conceptName: string;
  sourceEntries: SourceManifestEntry[];
}

const CompiledConceptResultType = jsonType<CompiledConceptResult>(
  typia.json.schema<CompiledConceptResult>(),
  typia.createValidate<CompiledConceptResult>(),
);

export default {
  name: "kb/compile-concepts",
  description: "Compile concept pages from source summaries",
  inputHint: "Optional concept=<id-or-name>",
  async execute(prompt, ctx) {
    const options = parseCompileConceptOptions(prompt);
    const compiledSources = (await readSourcesManifest(ctx.cwd))
      .filter((entry) => entry.summaryPath && !needsSourceCompilation(entry) && entry.concepts.length > 0);
    const targets = buildConceptTargets(compiledSources);

    const selectedTargets = selectTargets(targets, options.concept);
    if (options.concept && selectedTargets.length === 0) {
      throw new Error(`No compiled concept target matched: ${options.concept}`);
    }

    if (targets.length === 0) {
      await saveConceptsManifest(ctx.cwd, []);
      const indexPath = options.refreshIndex
        ? await rebuildKnowledgeBaseIndex(ctx.cwd)
        : "wiki/index.md";
      const emptyData: KnowledgeBaseCompileConceptsData = {
        manifestPath: ".kb/manifests/concepts.json",
        conceptCount: 0,
        touchedConceptIds: [],
        indexPath,
      };
      return {
        data: emptyData,
        display: "No compiled source concepts are available yet.\n",
          summary: "kb/compile-concepts: no concepts",
      };
    }

    const previousEntries = await readConceptsManifest(ctx.cwd);
    const previousById = new Map(previousEntries.map((entry) => [entry.conceptId, entry]));
    const selectedIds = new Set(selectedTargets.map((target) => target.conceptId));
    const nextEntries: ConceptManifestEntry[] = [];
    const touchedConceptIds: string[] = [];

    for (const target of targets) {
      const previous = previousById.get(target.conceptId);
      if (options.concept && !selectedIds.has(target.conceptId)) {
        if (previous) {
          nextEntries.push(previous);
        }
        continue;
      }

      const sourceFingerprint = buildSourceFingerprint(target.sourceEntries);
      const pagePath = conceptPagePath(target.conceptId);
      const pageExists = await Bun.file(join(ctx.cwd, previous?.pagePath ?? pagePath)).exists();
      if (!options.force && previous && previous.sourceFingerprint === sourceFingerprint && pageExists) {
        nextEntries.push({
          ...previous,
          conceptName: target.conceptName,
          sourceIds: target.sourceEntries.map((entry) => entry.sourceId),
          pagePath,
        });
        continue;
      }

      ctx.ui.text(`Compiling concept ${target.conceptId}...\n`);
      const result = await ctx.agent.run(
        buildConceptPrompt(target),
        CompiledConceptResultType,
        { stream: false },
      );
      const compiled = expectData(result, "Concept compilation returned no data");

      if (!compiled.title.trim()) {
        throw new Error(`Concept title was empty for ${target.conceptId}`);
      }
      if (!compiled.abstract.trim()) {
        throw new Error(`Concept abstract was empty for ${target.conceptId}`);
      }
      if (!compiled.pageMarkdown.trim()) {
        throw new Error(`Concept page markdown was empty for ${target.conceptId}`);
      }

      await Bun.write(join(ctx.cwd, pagePath), ensureTrailingNewline(compiled.pageMarkdown));
      ctx.ui.text(`Wrote ${pagePath}.\n`);

      nextEntries.push({
        conceptId: target.conceptId,
        conceptName: target.conceptName,
        title: collapseWhitespace(compiled.title),
        abstract: collapseWhitespace(compiled.abstract),
        pagePath,
        compiledAt: new Date().toISOString(),
        sourceIds: target.sourceEntries.map((entry) => entry.sourceId),
        relatedConceptIds: normalizeConceptIdList(compiled.relatedConcepts),
        sourceFingerprint,
      });
      touchedConceptIds.push(target.conceptId);
    }

    if (!options.concept) {
      nextEntries.sort((left, right) => left.conceptId.localeCompare(right.conceptId));
    }

    await saveConceptsManifest(ctx.cwd, nextEntries);
    const indexPath = options.refreshIndex
      ? await rebuildKnowledgeBaseIndex(ctx.cwd)
      : "wiki/index.md";

    if (!options.suppressLog) {
      await appendKnowledgeBaseLog(
        ctx.cwd,
        "compile-concepts",
        touchedConceptIds.length === 0
          ? "no concept updates"
          : `${touchedConceptIds.length} concept page(s) updated`,
        [
          "manifest: `.kb/manifests/concepts.json`",
          `touched concepts: ${touchedConceptIds.length > 0 ? summarizeList(touchedConceptIds) : "none"}`,
          `total concepts: ${nextEntries.length}`,
          `index: \`${indexPath}\``,
        ],
      );
    }

    const data: KnowledgeBaseCompileConceptsData = {
      manifestPath: ".kb/manifests/concepts.json",
      conceptCount: nextEntries.length,
      touchedConceptIds,
      indexPath,
    };

    return {
      data,
      display: touchedConceptIds.length === 0
        ? `Concept manifest is current with ${nextEntries.length} concept page(s).\n`
        : `Compiled ${touchedConceptIds.length} concept page(s); ${nextEntries.length} total tracked.\n`,
      summary: `kb/compile-concepts: ${touchedConceptIds.length} touched / ${nextEntries.length} total`,
    };
  },
} satisfies Procedure;

function parseCompileConceptOptions(prompt: string): CompileConceptOptions {
  const structured = parseStructuredInput(prompt);
  if (!structured) {
    const concept = prompt.trim() || undefined;
    return {
      concept,
      force: false,
      suppressLog: false,
      refreshIndex: true,
    };
  }

  return {
    concept: optionalString(structured.concept) ?? optionalString(structured.conceptId),
    force: optionalBoolean(structured.force, "force") ?? false,
    suppressLog: optionalBoolean(structured.suppressLog, "suppressLog") ?? false,
    refreshIndex: optionalBoolean(structured.refreshIndex, "refreshIndex") ?? true,
  };
}

function buildConceptTargets(sources: SourceManifestEntry[]): ConceptTarget[] {
  const grouped = new Map<string, { labels: string[]; sourceEntries: SourceManifestEntry[] }>();

  for (const source of sources) {
    for (const label of source.concepts) {
      const conceptId = normalizeConceptId(label);
      const existing = grouped.get(conceptId);
      if (existing) {
        existing.labels.push(label);
        existing.sourceEntries.push(source);
        continue;
      }

      grouped.set(conceptId, {
        labels: [label],
        sourceEntries: [source],
      });
    }
  }

  return [...grouped.entries()]
    .map(([conceptId, group]) => ({
      conceptId,
      conceptName: pickConceptName(group.labels),
      sourceEntries: [...new Map(group.sourceEntries.map((entry) => [entry.sourceId, entry])).values()]
        .sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    }))
    .sort((left, right) => left.conceptId.localeCompare(right.conceptId));
}

function selectTargets(targets: ConceptTarget[], requestedConcept?: string): ConceptTarget[] {
  if (!requestedConcept) {
    return targets;
  }

  const normalizedRequest = normalizeConceptId(requestedConcept);
  const loweredRequest = collapseWhitespace(requestedConcept).toLowerCase();
  return targets.filter((target) =>
    target.conceptId === normalizedRequest || target.conceptName.toLowerCase() === loweredRequest
  );
}

function pickConceptName(labels: string[]): string {
  return [...labels]
    .map((label) => collapseWhitespace(label))
    .filter(Boolean)
    .sort((left, right) =>
      left.toLowerCase().localeCompare(right.toLowerCase()) || left.length - right.length || left.localeCompare(right)
    )[0] ?? "Concept";
}

function buildSourceFingerprint(sourceEntries: SourceManifestEntry[]): string {
  const digest = createHash("sha1");
  for (const source of sourceEntries) {
    digest.update(`${source.sourceId}:${source.contentHash}\n`);
  }
  return digest.digest("hex");
}

function buildConceptPrompt(target: ConceptTarget): string {
  const sourcePages = target.sourceEntries.flatMap((entry) => entry.summaryPath ? [entry.summaryPath] : []);
  return [
    "You are compiling one knowledge-base concept page from existing source summaries.",
    `Concept id: ${target.conceptId}`,
    `Concept label: ${target.conceptName}`,
    `Target page: ${conceptPagePath(target.conceptId)}`,
    "",
    "Read only these compiled source pages from disk before answering:",
    ...sourcePages.map((page) => `- ${page}`),
    "",
    "Return a JSON object with exactly these keys: `title`, `abstract`, `relatedConcepts`, `pageMarkdown`.",
    "",
    "Requirements:",
    "- `title`: concise human-readable concept page title",
    "- `abstract`: 1-3 sentences, self-contained, under 240 characters",
    "- `relatedConcepts`: short array of related concept names or ids, no more than 8 items",
    "- `pageMarkdown`: a complete markdown page for the target file",
    "- `pageMarkdown` must include sections titled `## Overview`, `## Sources`, `## Key Points`, and `## Related Concepts`",
    "- In `## Sources`, link only the listed source pages you actually used",
    "- Ground every claim in the listed source pages and say when the source coverage is incomplete",
    "- Do not introduce facts from raw files or other pages unless they are already present in the listed source pages",
    "",
    "Return no prose outside the JSON object.",
  ].join("\n");
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

import { relative } from "node:path";

import type { Procedure } from "../../src/core/types.ts";
import {
  appendKnowledgeBaseLog,
  collapseWhitespace,
  ensureKnowledgeBaseLayout,
  needsSourceCompilation,
  normalizeConceptId,
  optionalBoolean,
  parseStructuredInput,
  readAnswersManifest,
  readConceptsManifest,
  readRendersManifest,
  readSourcesManifest,
  rebuildKnowledgeBaseIndex,
  summarizeList,
  type KnowledgeBaseLinkData,
  type LinkStateRecord,
} from "./lib/repository.ts";

interface LinkOptions {
  suppressLog: boolean;
}

interface PageRef {
  path: string;
  label: string;
  kind: "source" | "concept" | "answer" | "render";
}

export default {
  name: "kb/link",
  description: "Rebuild KB indexes, backlinks, and structural reports",
  inputHint: "Optional suppressLog=true",
  async execute(prompt, ctx) {
    const options = parseLinkOptions(prompt);
    const paths = await ensureKnowledgeBaseLayout(ctx.cwd);
    const sources = await readSourcesManifest(ctx.cwd);
    const concepts = await readConceptsManifest(ctx.cwd);
    const answers = await readAnswersManifest(ctx.cwd);
    const renders = await readRendersManifest(ctx.cwd);

    ctx.ui.text("Rebuilding knowledge-base links...\n");
    const indexPath = await rebuildKnowledgeBaseIndex(ctx.cwd);

    const pageRefs = collectPageRefs(sources, concepts, answers, renders);
    const backlinks = collectBacklinks(pageRefs, sources, concepts, answers, renders);
    const orphanSourceIds = sources
      .filter((source) => !needsSourceCompilation(source) && source.summaryPath && source.concepts.length === 0)
      .map((source) => source.sourceId);
    const orphanConceptIds = concepts
      .filter((concept) => concept.sourceIds.length === 0)
      .map((concept) => concept.conceptId);
    const duplicateConcepts = findDuplicateConcepts(concepts);

    const conceptIndexPath = "wiki/indexes/concepts.md";
    const backlinksPath = "wiki/indexes/backlinks.md";
    const maintenancePath = "wiki/indexes/maintenance.md";

    await Promise.all([
      Bun.write(
        `${ctx.cwd}/${conceptIndexPath}`,
        ensureTrailingNewline(buildConceptIndexMarkdown(ctx.cwd, conceptIndexPath, concepts, sources)),
      ),
      Bun.write(
        `${ctx.cwd}/${backlinksPath}`,
        ensureTrailingNewline(buildBacklinksMarkdown(ctx.cwd, backlinksPath, pageRefs, backlinks)),
      ),
      Bun.write(
        `${ctx.cwd}/${maintenancePath}`,
        ensureTrailingNewline(buildMaintenanceMarkdown(orphanSourceIds, orphanConceptIds, duplicateConcepts, sources)),
      ),
      Bun.write(
        paths.linkStatePath,
        `${JSON.stringify({
          generatedAt: new Date().toISOString(),
          indexPath,
          conceptIndexPath,
          backlinksPath,
          maintenancePath,
          orphanSourceIds,
          orphanConceptIds,
          duplicateConcepts,
        } satisfies LinkStateRecord, null, 2)}\n`,
      ),
    ]);

    if (!options.suppressLog) {
      await appendKnowledgeBaseLog(
        ctx.cwd,
        "link",
        "rebuilt KB indexes",
        [
          `concept index: \`${conceptIndexPath}\``,
          `backlinks: \`${backlinksPath}\``,
          `maintenance: \`${maintenancePath}\``,
          `orphans: ${orphanSourceIds.length + orphanConceptIds.length}`,
          `duplicate concepts: ${duplicateConcepts.length}`,
        ],
      );
    }

    const data: KnowledgeBaseLinkData = {
      indexPath,
      conceptIndexPath,
      backlinksPath,
      maintenancePath,
      orphanSourceIds,
      orphanConceptIds,
      duplicateConcepts,
    };

    ctx.ui.text("Knowledge-base linking complete.\n");

    return {
      data,
      display: [
        `Rebuilt the main index at ${indexPath}.`,
        `Wrote concept index to ${conceptIndexPath}.`,
        `Wrote backlinks report to ${backlinksPath}.`,
        `Wrote maintenance report to ${maintenancePath}.`,
      ].join("\n"),
      summary: `kb/link: ${concepts.length} concepts / ${answers.length} answers / ${renders.length} renders`,
    };
  },
} satisfies Procedure;

function parseLinkOptions(prompt: string): LinkOptions {
  const structured = parseStructuredInput(prompt);
  if (!structured) {
    return { suppressLog: false };
  }

  return {
    suppressLog: optionalBoolean(structured.suppressLog, "suppressLog") ?? false,
  };
}

function collectPageRefs(
  sources: Awaited<ReturnType<typeof readSourcesManifest>>,
  concepts: Awaited<ReturnType<typeof readConceptsManifest>>,
  answers: Awaited<ReturnType<typeof readAnswersManifest>>,
  renders: Awaited<ReturnType<typeof readRendersManifest>>,
): PageRef[] {
  const refs: PageRef[] = [];

  for (const source of sources) {
    if (!source.summaryPath) {
      continue;
    }
    refs.push({
      path: source.summaryPath,
      label: collapseWhitespace(source.title ?? source.sourceId) || source.sourceId,
      kind: "source",
    });
  }

  for (const concept of concepts) {
    refs.push({
      path: concept.pagePath,
      label: collapseWhitespace(concept.title) || concept.conceptName || concept.conceptId,
      kind: "concept",
    });
  }

  for (const answer of answers) {
    refs.push({
      path: answer.answerPath,
      label: collapseWhitespace(answer.title) || answer.answerId,
      kind: "answer",
    });
  }

  for (const render of renders) {
    refs.push({
      path: render.outputPath,
      label: collapseWhitespace(render.title) || render.renderId,
      kind: "render",
    });
  }

  return refs.sort((left, right) => left.path.localeCompare(right.path));
}

function collectBacklinks(
  pageRefs: PageRef[],
  sources: Awaited<ReturnType<typeof readSourcesManifest>>,
  concepts: Awaited<ReturnType<typeof readConceptsManifest>>,
  answers: Awaited<ReturnType<typeof readAnswersManifest>>,
  renders: Awaited<ReturnType<typeof readRendersManifest>>,
): Map<string, string[]> {
  const backlinks = new Map(pageRefs.map((page) => [page.path, [] as string[]]));
  const sourcePageById = new Map(
    sources.flatMap((source) => source.summaryPath ? [[source.sourceId, source.summaryPath] as const] : []),
  );
  const conceptPageById = new Map(concepts.map((concept) => [concept.conceptId, concept.pagePath]));

  for (const concept of concepts) {
    const sourceLabel = `${concept.title || concept.conceptName} (\`${concept.pagePath}\`)`;
    for (const sourceId of concept.sourceIds) {
      const pagePath = sourcePageById.get(sourceId);
      if (pagePath) {
        backlinks.get(pagePath)?.push(sourceLabel);
      }
    }

    for (const relatedConceptId of concept.relatedConceptIds) {
      const pagePath = conceptPageById.get(relatedConceptId);
      if (pagePath) {
        backlinks.get(pagePath)?.push(sourceLabel);
      }
    }
  }

  for (const answer of answers) {
    const sourceLabel = `${answer.title} (\`${answer.answerPath}\`)`;
    for (const citedPage of answer.citedPages) {
      backlinks.get(citedPage)?.push(sourceLabel);
    }
  }

  for (const render of renders) {
    const sourceLabel = `${render.title} (\`${render.outputPath}\`)`;
    for (const sourcePage of render.sourcePages) {
      backlinks.get(sourcePage)?.push(sourceLabel);
    }
  }

  for (const values of backlinks.values()) {
    values.sort((left, right) => left.localeCompare(right));
  }

  return backlinks;
}

function findDuplicateConcepts(concepts: Awaited<ReturnType<typeof readConceptsManifest>>): string[][] {
  const groups = new Map<string, string[]>();
  for (const concept of concepts) {
    const key = normalizeConceptId(concept.title || concept.conceptName || concept.conceptId);
    const existing = groups.get(key);
    if (existing) {
      existing.push(concept.conceptId);
      continue;
    }
    groups.set(key, [concept.conceptId]);
  }

  return [...groups.values()]
    .filter((group) => new Set(group).size > 1)
    .map((group) => [...new Set(group)].sort());
}

function buildConceptIndexMarkdown(
  cwd: string,
  conceptIndexPath: string,
  concepts: Awaited<ReturnType<typeof readConceptsManifest>>,
  sources: Awaited<ReturnType<typeof readSourcesManifest>>,
): string {
  const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
  const baseDir = `${cwd}/${conceptIndexPath.replace(/\/[^/]+$/, "")}`;
  const lines = [
    "# Concept Index",
    "",
    "Deterministic concept catalog generated by `/kb/link`.",
    "",
  ];

  if (concepts.length === 0) {
    lines.push("_No concept pages yet._", "");
    return lines.join("\n");
  }

  for (const concept of concepts) {
    lines.push(`## [${escapeMarkdownLabel(concept.title || concept.conceptName)}](${relativeLink(baseDir, cwd, concept.pagePath)})`);
    lines.push("");
    lines.push(collapseWhitespace(concept.abstract) || "No abstract recorded.");
    lines.push("");
    lines.push(`- Concept ID: \`${concept.conceptId}\``);
    lines.push(`- Source count: ${concept.sourceIds.length}`);
    if (concept.sourceIds.length > 0) {
      lines.push("- Source pages:");
      for (const sourceId of concept.sourceIds) {
        const source = sourceById.get(sourceId);
        if (!source?.summaryPath) {
          lines.push(`  - \`${sourceId}\``);
          continue;
        }
        const label = source.title ?? sourceId;
        lines.push(`  - [${escapeMarkdownLabel(label)}](${relativeLink(baseDir, cwd, source.summaryPath)})`);
      }
    }
    if (concept.relatedConceptIds.length > 0) {
      lines.push(`- Related concepts: ${concept.relatedConceptIds.map((conceptId) => `\`${conceptId}\``).join(", ")}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildBacklinksMarkdown(
  cwd: string,
  backlinksPath: string,
  pageRefs: PageRef[],
  backlinks: Map<string, string[]>,
): string {
  const baseDir = `${cwd}/${backlinksPath.replace(/\/[^/]+$/, "")}`;
  const lines = [
    "# Backlinks",
    "",
    "Incoming references derived from manifests and stored page relationships.",
    "",
  ];

  for (const page of pageRefs) {
    lines.push(`## [${escapeMarkdownLabel(page.label)}](${relativeLink(baseDir, cwd, page.path)})`);
    lines.push("");
    lines.push(`- Kind: \`${page.kind}\``);
    lines.push(`- Path: \`${page.path}\``);
    const incoming = backlinks.get(page.path) ?? [];
    if (incoming.length === 0) {
      lines.push("- Incoming references: none");
    } else {
      lines.push(`- Incoming references (${incoming.length}):`);
      for (const ref of incoming) {
        lines.push(`  - ${ref}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildMaintenanceMarkdown(
  orphanSourceIds: string[],
  orphanConceptIds: string[],
  duplicateConcepts: string[][],
  sources: Awaited<ReturnType<typeof readSourcesManifest>>,
): string {
  const staleSourceIds = sources.filter(needsSourceCompilation).map((source) => source.sourceId);
  const lines = [
    "# Maintenance Report",
    "",
    "Deterministic structural checks generated by `/kb/link`.",
    "",
    `- Orphan sources: ${orphanSourceIds.length > 0 ? summarizeList(orphanSourceIds, 10) : "none"}`,
    `- Orphan concepts: ${orphanConceptIds.length > 0 ? summarizeList(orphanConceptIds, 10) : "none"}`,
    `- Duplicate concept groups: ${duplicateConcepts.length > 0 ? duplicateConcepts.map((group) => group.join(", ")).join(" | ") : "none"}`,
    `- Stale sources pending compile: ${staleSourceIds.length > 0 ? summarizeList(staleSourceIds, 10) : "none"}`,
    "",
  ];

  return lines.join("\n");
}

function relativeLink(baseDir: string, cwd: string, targetPath: string): string {
  return relative(baseDir, `${cwd}/${targetPath}`).replaceAll("\\", "/");
}

function escapeMarkdownLabel(value: string): string {
  return value.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

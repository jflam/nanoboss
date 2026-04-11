import type { Procedure } from "../../src/core/types.ts";
import {
  appendKnowledgeBaseLog,
  createSourceManifestEntry,
  optionalBoolean,
  optionalString,
  parseStructuredInput,
  readSourcesManifest,
  rebuildKnowledgeBaseIndex,
  saveSourcesManifest,
  scanRawSources,
  summarizeList,
  type KnowledgeBaseIngestData,
} from "./lib/repository.ts";

interface IngestOptions {
  path?: string;
  suppressLog: boolean;
  refreshIndex: boolean;
}

export default {
  name: "kb/ingest",
  description: "Scan raw sources and update knowledge-base manifests",
  inputHint: "Optional raw path or path=raw/article.md",
  async execute(prompt, ctx) {
    const options = parseIngestOptions(prompt);

    ctx.ui.text("Scanning raw sources...\n");
    const previousEntries = await readSourcesManifest(ctx.cwd);
    const previousById = new Map(previousEntries.map((entry) => [entry.sourceId, entry]));
    const discovered = await scanRawSources(ctx.cwd, options.path);
    const nextEntries = discovered.map((rawSource) =>
      createSourceManifestEntry(rawSource, previousById.get(rawSource.sourceId))
    );
    const nextIds = new Set(nextEntries.map((entry) => entry.sourceId));
    const changed = nextEntries.filter((entry) => entry.compiledContentHash !== entry.contentHash || !entry.summaryPath);
    const removed = previousEntries.filter((entry) => !nextIds.has(entry.sourceId));

    await saveSourcesManifest(ctx.cwd, nextEntries);
    const indexPath = options.refreshIndex
      ? await rebuildKnowledgeBaseIndex(ctx.cwd)
      : "wiki/index.md";

    if (!options.suppressLog) {
      await appendKnowledgeBaseLog(
        ctx.cwd,
        "ingest",
        `${changed.length} changed of ${nextEntries.length} source(s)`,
        [
          `manifest: \`.kb/manifests/sources.json\``,
          `pending compile: ${changed.length > 0 ? summarizeList(changed.map((entry) => entry.sourceId)) : "none"}`,
          `removed sources: ${removed.length > 0 ? summarizeList(removed.map((entry) => entry.sourceId)) : "none"}`,
        ],
      );
    }

    const data: KnowledgeBaseIngestData = {
      manifestPath: ".kb/manifests/sources.json",
      indexPath,
      sourceCount: nextEntries.length,
      allSourceIds: nextEntries.map((entry) => entry.sourceId),
      changedSourceIds: changed.map((entry) => entry.sourceId),
      removedSourceIds: removed.map((entry) => entry.sourceId),
    };

    ctx.ui.text(`Indexed ${nextEntries.length} source(s); ${changed.length} need compilation.\n`);

    return {
      data,
      display: [
        `Indexed ${nextEntries.length} raw source(s); ${changed.length} need compilation.`,
        `Manifest updated at ${data.manifestPath}.`,
        `Index updated at ${data.indexPath}.`,
      ].join("\n"),
      summary: `kb/ingest: ${changed.length} changed / ${nextEntries.length} total`,
    };
  },
} satisfies Procedure;

function parseIngestOptions(prompt: string): IngestOptions {
  const structured = parseStructuredInput(prompt);
  if (!structured) {
    const path = prompt.trim() || undefined;
    return {
      path,
      suppressLog: false,
      refreshIndex: true,
    };
  }

  return {
    path: optionalString(structured.path) ?? optionalString(structured.rawPath),
    suppressLog: optionalBoolean(structured.suppressLog, "suppressLog") ?? false,
    refreshIndex: optionalBoolean(structured.refreshIndex, "refreshIndex") ?? true,
  };
}

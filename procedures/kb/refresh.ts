import type { Procedure } from "../../src/core/types.ts";
import {
  appendKnowledgeBaseLog,
  optionalBoolean,
  optionalString,
  parseStructuredInput,
  summarizeList,
  type KnowledgeBaseCompileConceptsData,
  type KnowledgeBaseCompileData,
  type KnowledgeBaseHealthData,
  type KnowledgeBaseIngestData,
  type KnowledgeBaseLinkData,
  type KnowledgeBaseRefreshData,
} from "./lib/repository.ts";

interface RefreshOptions {
  path?: string;
  force: boolean;
  health: boolean;
}

export default {
  name: "kb/refresh",
  description: "Refresh the knowledge base from raw sources",
  inputHint: "Optional raw path or path=raw/article.md",
  async execute(prompt, ctx) {
    const options = parseRefreshOptions(prompt);

    ctx.ui.text("Refreshing knowledge base...\n");
    const ingestResult = await ctx.procedures.run<KnowledgeBaseIngestData>(
      "kb/ingest",
      JSON.stringify({
        ...(options.path ? { path: options.path } : {}),
        suppressLog: true,
        refreshIndex: false,
      }),
    );
    const ingestData = ingestResult.data;
    if (!ingestData) {
      throw new Error("kb/ingest returned no data");
    }

    const targetSourceIds = options.force ? ingestData.allSourceIds : ingestData.changedSourceIds;
    const compiledSourceIds: string[] = [];

    for (const sourceId of targetSourceIds) {
      const compileResult = await ctx.procedures.run<KnowledgeBaseCompileData>(
        "kb/compile-source",
        JSON.stringify({
          sourceId,
          force: options.force,
          suppressLog: true,
          refreshIndex: false,
        }),
      );
      const compiled = compileResult.data;
      if (compiled?.status === "compiled") {
        compiledSourceIds.push(compiled.sourceId);
      }
    }

    const conceptResult = await ctx.procedures.run<KnowledgeBaseCompileConceptsData>(
      "kb/compile-concepts",
      JSON.stringify({
        force: options.force,
        suppressLog: true,
        refreshIndex: false,
      }),
    );
    const conceptData = conceptResult.data;
    if (!conceptData) {
      throw new Error("kb/compile-concepts returned no data");
    }

    const linkResult = await ctx.procedures.run<KnowledgeBaseLinkData>(
      "kb/link",
      JSON.stringify({
        suppressLog: true,
      }),
    );
    const linkData = linkResult.data;
    if (!linkData) {
      throw new Error("kb/link returned no data");
    }

    let healthIssueCount: number | undefined;
    if (options.health) {
      const healthResult = await ctx.procedures.run<KnowledgeBaseHealthData>("kb/health", "");
      const healthData = healthResult.data;
      if (!healthData) {
        throw new Error("kb/health returned no data");
      }
      healthIssueCount = healthData.issueCount;
    }

    const logPath = await appendKnowledgeBaseLog(
      ctx.cwd,
      "refresh",
      targetSourceIds.length === 0
        ? "no source changes"
        : `${compiledSourceIds.length} source(s), ${conceptData.touchedConceptIds.length} concept page(s) updated`,
      [
        `indexed sources: ${ingestData.sourceCount}`,
        `changed sources: ${ingestData.changedSourceIds.length > 0 ? summarizeList(ingestData.changedSourceIds) : "none"}`,
        `compiled sources: ${compiledSourceIds.length > 0 ? summarizeList(compiledSourceIds) : "none"}`,
        `compiled concepts: ${conceptData.touchedConceptIds.length > 0 ? summarizeList(conceptData.touchedConceptIds) : "none"}`,
        `index: \`${linkData.indexPath}\``,
        `concept index: \`${linkData.conceptIndexPath}\``,
        `backlinks: \`${linkData.backlinksPath}\``,
        `maintenance: \`${linkData.maintenancePath}\``,
        ...(healthIssueCount === undefined ? [] : [`health issues: ${healthIssueCount}`]),
      ],
    );

    ctx.ui.text("Knowledge base refresh complete.\n");

    const data: KnowledgeBaseRefreshData = {
      sourceCount: ingestData.sourceCount,
      changedSourceIds: ingestData.changedSourceIds,
      compiledSourceIds,
      conceptCount: conceptData.conceptCount,
      touchedConceptIds: conceptData.touchedConceptIds,
      indexPath: linkData.indexPath,
      conceptIndexPath: linkData.conceptIndexPath,
      backlinksPath: linkData.backlinksPath,
      maintenancePath: linkData.maintenancePath,
      logPath,
      healthIssueCount,
    };

    return {
      data,
      display: [
        `Refreshed ${ingestData.sourceCount} source(s).`,
        compiledSourceIds.length === 0
          ? "No source pages needed recompilation."
          : `Compiled ${compiledSourceIds.length} source page(s).`,
        conceptData.touchedConceptIds.length === 0
          ? `Concept manifest remains at ${conceptData.conceptCount} page(s).`
          : `Compiled ${conceptData.touchedConceptIds.length} concept page(s).`,
        `Index updated at ${linkData.indexPath}.`,
        ...(healthIssueCount === undefined ? [] : [`Health check found ${healthIssueCount} issue(s).`]),
      ].join("\n"),
      summary: `kb/refresh: ${compiledSourceIds.length} compiled`,
    };
  },
} satisfies Procedure;

function parseRefreshOptions(prompt: string): RefreshOptions {
  const structured = parseStructuredInput(prompt);
  if (!structured) {
    const path = prompt.trim() || undefined;
    return {
      path,
      force: false,
      health: false,
    };
  }

  return {
    path: optionalString(structured.path) ?? optionalString(structured.rawPath),
    force: optionalBoolean(structured.force, "force") ?? false,
    health: optionalBoolean(structured.health, "health") ?? false,
  };
}

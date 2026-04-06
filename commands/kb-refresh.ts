import type { Procedure } from "../src/core/types.ts";
import {
  appendKnowledgeBaseLog,
  optionalBoolean,
  optionalString,
  parseStructuredInput,
  rebuildKnowledgeBaseIndex,
  summarizeList,
  type KnowledgeBaseCompileData,
  type KnowledgeBaseIngestData,
  type KnowledgeBaseRefreshData,
} from "../src/knowledge-base/repository.ts";

interface RefreshOptions {
  path?: string;
  force: boolean;
}

export default {
  name: "kb-refresh",
  description: "Refresh the knowledge base from raw sources",
  inputHint: "Optional raw path or path=raw/article.md",
  async execute(prompt, ctx) {
    const options = parseRefreshOptions(prompt);

    ctx.print("Refreshing knowledge base...\n");
    const ingestResult = await ctx.callProcedure<KnowledgeBaseIngestData>(
      "kb-ingest",
      JSON.stringify({
        ...(options.path ? { path: options.path } : {}),
        suppressLog: true,
        refreshIndex: false,
      }),
    );
    const ingestData = ingestResult.data;
    if (!ingestData) {
      throw new Error("kb-ingest returned no data");
    }

    const targetSourceIds = options.force ? ingestData.allSourceIds : ingestData.changedSourceIds;
    const compiledSourceIds: string[] = [];

    for (const sourceId of targetSourceIds) {
      const compileResult = await ctx.callProcedure<KnowledgeBaseCompileData>(
        "kb-compile-source",
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

    const indexPath = await rebuildKnowledgeBaseIndex(ctx.cwd);
    const logPath = await appendKnowledgeBaseLog(
      ctx.cwd,
      "refresh",
      targetSourceIds.length === 0
        ? "no source changes"
        : `${compiledSourceIds.length} source(s) updated`,
      [
        `indexed sources: ${ingestData.sourceCount}`,
        `changed sources: ${ingestData.changedSourceIds.length > 0 ? summarizeList(ingestData.changedSourceIds) : "none"}`,
        `compiled sources: ${compiledSourceIds.length > 0 ? summarizeList(compiledSourceIds) : "none"}`,
        `index: \`${indexPath}\``,
      ],
    );

    ctx.print("Knowledge base refresh complete.\n");

    const data: KnowledgeBaseRefreshData = {
      sourceCount: ingestData.sourceCount,
      changedSourceIds: ingestData.changedSourceIds,
      compiledSourceIds,
      indexPath,
      logPath,
    };

    return {
      data,
      display: [
        `Refreshed ${ingestData.sourceCount} source(s).`,
        compiledSourceIds.length === 0
          ? "No source pages needed recompilation."
          : `Compiled ${compiledSourceIds.length} source page(s).`,
        `Index updated at ${indexPath}.`,
      ].join("\n"),
      summary: `kb-refresh: ${compiledSourceIds.length} compiled`,
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
    };
  }

  return {
    path: optionalString(structured.path) ?? optionalString(structured.rawPath),
    force: optionalBoolean(structured.force, "force") ?? false,
  };
}

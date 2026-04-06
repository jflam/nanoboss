import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import kbAnswerProcedure from "../../commands/kb-answer.ts";
import kbCompileConceptsProcedure from "../../commands/kb-compile-concepts.ts";
import kbCompileSourceProcedure from "../../commands/kb-compile-source.ts";
import kbHealthProcedure from "../../commands/kb-health.ts";
import kbIngestProcedure from "../../commands/kb-ingest.ts";
import kbLinkProcedure from "../../commands/kb-link.ts";
import kbRenderProcedure from "../../commands/kb-render.ts";
import kbRefreshProcedure from "../../commands/kb-refresh.ts";
import type {
  CommandContext,
  DownstreamAgentConfig,
  Procedure,
  ProcedureResult,
  RunResult,
} from "../../src/core/types.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("knowledge-base procedures", () => {
  test("/kb-ingest writes manifests, index, and log entries", async () => {
    const cwd = createWorkspace();
    writeFileSync(join(cwd, "raw", "article.md"), "# Example\n\nA durable note.\n", "utf8");

    const harness = createHarness({ cwd, agentResults: [] });
    const result = await harness.execute("kb-ingest", "");

    if (!result || typeof result === "string") {
      throw new Error("Expected ProcedureResult");
    }

    const data = result.data as {
      sourceCount: number;
      allSourceIds: string[];
      changedSourceIds: string[];
    };

    expect(data.sourceCount).toBe(1);
    expect(data.allSourceIds).toHaveLength(1);
    expect(data.changedSourceIds).toEqual(data.allSourceIds);

    const sourceId = data.allSourceIds[0];
    const sourcesManifest = JSON.parse(
      readFileSync(join(cwd, ".kb", "manifests", "sources.json"), "utf8"),
    ) as Array<{ sourceId: string; rawPath: string }>;
    expect(sourcesManifest[0]).toMatchObject({
      sourceId,
      rawPath: "raw/article.md",
    });

    const index = readFileSync(join(cwd, "wiki", "index.md"), "utf8");
    const log = readFileSync(join(cwd, "wiki", "log.md"), "utf8");
    expect(index).toContain(sourceId);
    expect(log).toContain("ingest | 1 changed of 1 source(s)");
    expect(harness.prints).toContain("Scanning raw sources...\n");
  });

  test("/kb-compile-source writes a source page and updates the manifest", async () => {
    const cwd = createWorkspace();
    writeFileSync(join(cwd, "raw", "article.md"), "# Example\n\nA durable note.\n", "utf8");

    const harness = createHarness({
      cwd,
      agentResults: [
        {
          title: "Example Article",
          sourceType: "article",
          abstract: "A short compiled summary.",
          concepts: ["Durability"],
          tags: ["Example"],
          questions: ["What changed?"],
          pageMarkdown: [
            "# Example Article",
            "",
            "## Source",
            "",
            "- Source ID: placeholder",
            "- Raw path: raw/article.md",
            "",
            "## Summary",
            "",
            "A short compiled summary.",
            "",
            "## Key Points",
            "",
            "- Durable point.",
            "",
            "## Open Questions",
            "",
            "- What changed?",
          ].join("\n"),
        },
      ],
    });

    const ingest = await harness.execute("kb-ingest", "");
    if (!ingest || typeof ingest === "string") {
      throw new Error("Expected ingest ProcedureResult");
    }
    const sourceId = (ingest.data as { allSourceIds: string[] }).allSourceIds[0];

    const compiled = await harness.execute("kb-compile-source", `sourceId=${sourceId}`);
    if (!compiled || typeof compiled === "string") {
      throw new Error("Expected compile ProcedureResult");
    }

    const data = compiled.data as { summaryPath: string; status: string };
    expect(data.status).toBe("compiled");
    expect(data.summaryPath).toBe(`wiki/sources/${sourceId}.md`);
    expect(existsSync(join(cwd, data.summaryPath))).toBe(true);
    expect(readFileSync(join(cwd, data.summaryPath), "utf8")).toContain("# Example Article");

    const sourcesManifest = JSON.parse(
      readFileSync(join(cwd, ".kb", "manifests", "sources.json"), "utf8"),
    ) as Array<{ sourceId: string; summaryPath?: string; title?: string; compiledAt?: string }>;
    expect(sourcesManifest[0]).toMatchObject({
      sourceId,
      summaryPath: data.summaryPath,
      title: "Example Article",
    });
    expect(typeof sourcesManifest[0]?.compiledAt).toBe("string");
  });

  test("/kb-compile-concepts writes concept pages and updates the manifest", async () => {
    const cwd = createWorkspace();
    writeFileSync(join(cwd, "raw", "article.md"), "# Article\n\nContext for retrieval.\n", "utf8");

    const harness = createHarness({
      cwd,
      agentResults: [
        {
          title: "Article Summary",
          sourceType: "article",
          abstract: "Compiled article summary.",
          concepts: ["Index-first retrieval"],
          tags: ["Knowledge"],
          questions: ["What next?"],
          pageMarkdown: [
            "# Article Summary",
            "",
            "## Source",
            "",
            "- Raw path: raw/article.md",
            "",
            "## Summary",
            "",
            "Compiled article summary.",
            "",
            "## Key Points",
            "",
            "- Index-first retrieval helps.",
            "",
            "## Open Questions",
            "",
            "- What next?",
          ].join("\n"),
        },
        {
          title: "Index-First Retrieval",
          abstract: "It narrows the search surface by routing the agent through a maintained index before deep reads.",
          relatedConcepts: ["Knowledge base"],
          pageMarkdown: [
            "# Index-First Retrieval",
            "",
            "## Overview",
            "",
            "Index-first retrieval narrows the search surface before deep reads.",
            "",
            "## Sources",
            "",
            "- [Article Summary](../sources/article-c52728b3.md)",
            "",
            "## Key Points",
            "",
            "- Start from the maintained index.",
            "",
            "## Related Concepts",
            "",
            "- Knowledge base",
          ].join("\n"),
        },
      ],
    });

    const ingest = await harness.execute("kb-ingest", "");
    if (!ingest || typeof ingest === "string") {
      throw new Error("Expected ingest ProcedureResult");
    }
    const sourceId = (ingest.data as { allSourceIds: string[] }).allSourceIds[0];
    await harness.execute("kb-compile-source", `sourceId=${sourceId}`);
    const result = await harness.execute("kb-compile-concepts", "");
    if (!result || typeof result === "string") {
      throw new Error("Expected concept compile ProcedureResult");
    }

    const data = result.data as { conceptCount: number; touchedConceptIds: string[] };
    expect(data.conceptCount).toBe(1);
    expect(data.touchedConceptIds).toEqual(["index-first-retrieval"]);
    expect(existsSync(join(cwd, "wiki", "concepts", "index-first-retrieval.md"))).toBe(true);

    const conceptsManifest = JSON.parse(
      readFileSync(join(cwd, ".kb", "manifests", "concepts.json"), "utf8"),
    ) as Array<{ conceptId: string; sourceIds: string[]; pagePath: string }>;
    expect(conceptsManifest[0]).toMatchObject({
      conceptId: "index-first-retrieval",
      sourceIds: [sourceId],
      pagePath: "wiki/concepts/index-first-retrieval.md",
    });
  });

  test("/kb-link writes supporting KB indexes and maintenance state", async () => {
    const cwd = createWorkspace();
    writeFileSync(join(cwd, "raw", "paper.md"), "# Paper\n\nInteresting result.\n", "utf8");

    const harness = createHarness({
      cwd,
      agentResults: [
        {
          title: "Paper Summary",
          sourceType: "paper",
          abstract: "Compiled from one source.",
          concepts: ["Transformers"],
          tags: ["Research"],
          questions: ["What is missing?"],
          pageMarkdown: [
            "# Paper Summary",
            "",
            "## Source",
            "",
            "- Raw path: raw/paper.md",
            "",
            "## Summary",
            "",
            "Compiled from one source.",
            "",
            "## Key Points",
            "",
            "- One useful point.",
            "",
            "## Open Questions",
            "",
            "- What is missing?",
          ].join("\n"),
        },
        {
          title: "Transformers",
          abstract: "Concept page compiled from one paper summary.",
          relatedConcepts: ["Research"],
          pageMarkdown: [
            "# Transformers",
            "",
            "## Overview",
            "",
            "Transformers are central to the paper summary.",
            "",
            "## Sources",
            "",
            "- [Paper Summary](../sources/paper-413b8f02.md)",
            "",
            "## Key Points",
            "",
            "- One useful point.",
            "",
            "## Related Concepts",
            "",
            "- Research",
          ].join("\n"),
        },
      ],
    });

    const refresh = await harness.execute("kb-refresh", "");
    if (!refresh || typeof refresh === "string") {
      throw new Error("Expected refresh ProcedureResult");
    }

    const result = await harness.execute("kb-link", "");
    if (!result || typeof result === "string") {
      throw new Error("Expected link ProcedureResult");
    }

    const data = result.data as { conceptIndexPath: string; backlinksPath: string; maintenancePath: string };
    expect(data.conceptIndexPath).toBe("wiki/indexes/concepts.md");
    expect(data.backlinksPath).toBe("wiki/indexes/backlinks.md");
    expect(data.maintenancePath).toBe("wiki/indexes/maintenance.md");
    expect(existsSync(join(cwd, data.conceptIndexPath))).toBe(true);
    expect(existsSync(join(cwd, data.backlinksPath))).toBe(true);
    expect(existsSync(join(cwd, data.maintenancePath))).toBe(true);
    expect(readFileSync(join(cwd, "wiki", "index.md"), "utf8")).toContain("## Concepts (1)");
  });

  test("/kb-refresh composes ingest, source compilation, concept compilation, and linking", async () => {
    const cwd = createWorkspace();
    writeFileSync(join(cwd, "raw", "paper.md"), "# Paper\n\nInteresting result.\n", "utf8");

    const harness = createHarness({
      cwd,
      agentResults: [
        {
          title: "Paper Summary",
          sourceType: "paper",
          abstract: "Compiled from one source.",
          concepts: ["Transformers"],
          tags: ["Research"],
          questions: ["What is missing?"],
          pageMarkdown: [
            "# Paper Summary",
            "",
            "## Source",
            "",
            "- Raw path: raw/paper.md",
            "",
            "## Summary",
            "",
            "Compiled from one source.",
            "",
            "## Key Points",
            "",
            "- One useful point.",
            "",
            "## Open Questions",
            "",
            "- What is missing?",
          ].join("\n"),
        },
        {
          title: "Transformers",
          abstract: "Concept page compiled from one paper summary.",
          relatedConcepts: ["Research"],
          pageMarkdown: [
            "# Transformers",
            "",
            "## Overview",
            "",
            "Transformers are central to the paper summary.",
            "",
            "## Sources",
            "",
            "- [Paper Summary](../sources/paper-413b8f02.md)",
            "",
            "## Key Points",
            "",
            "- One useful point.",
            "",
            "## Related Concepts",
            "",
            "- Research",
          ].join("\n"),
        },
      ],
    });

    const result = await harness.execute("kb-refresh", "");
    if (!result || typeof result === "string") {
      throw new Error("Expected refresh ProcedureResult");
    }

    const data = result.data as {
      compiledSourceIds: string[];
      touchedConceptIds: string[];
      sourceCount: number;
      conceptIndexPath: string;
      backlinksPath: string;
    };
    expect(data.sourceCount).toBe(1);
    expect(data.compiledSourceIds).toHaveLength(1);
    expect(data.touchedConceptIds).toEqual(["transformers"]);

    const sourceId = data.compiledSourceIds[0];
    expect(existsSync(join(cwd, "wiki", "sources", `${sourceId}.md`))).toBe(true);
    expect(existsSync(join(cwd, "wiki", "concepts", "transformers.md"))).toBe(true);
    expect(existsSync(join(cwd, data.conceptIndexPath))).toBe(true);
    expect(existsSync(join(cwd, data.backlinksPath))).toBe(true);
    expect(readFileSync(join(cwd, "wiki", "log.md"), "utf8")).toContain("refresh | 1 source(s), 1 concept page(s) updated");
    expect(harness.prints).toContain("Refreshing knowledge base...\n");
    expect(harness.prints).toContain("Knowledge base refresh complete.\n");
  });

  test("/kb-answer writes a durable answer page and updates answer manifests", async () => {
    const cwd = createWorkspace();
    writeFileSync(join(cwd, "raw", "article.md"), "# Article\n\nContext for answering.\n", "utf8");

    const agentResults: unknown[] = [
      {
        title: "Article Summary",
        sourceType: "article",
        abstract: "Compiled article summary.",
        concepts: ["Index-first retrieval"],
        tags: ["Knowledge"],
        questions: ["What next?"],
        pageMarkdown: [
          "# Article Summary",
          "",
          "## Source",
          "",
          "- Raw path: raw/article.md",
          "",
          "## Summary",
          "",
          "Compiled article summary.",
          "",
          "## Key Points",
          "",
          "- Index-first retrieval helps.",
          "",
          "## Open Questions",
          "",
          "- What next?",
        ].join("\n"),
      },
      {
        title: "Index-First Retrieval",
        abstract: "Concept page compiled from the article summary.",
        relatedConcepts: ["Knowledge base"],
        pageMarkdown: [
          "# Index-First Retrieval",
          "",
          "## Overview",
          "",
          "Index-first retrieval narrows the search surface before reading deeply.",
          "",
          "## Sources",
          "",
          "- [Article Summary](../sources/article-c52728b3.md)",
          "",
          "## Key Points",
          "",
          "- Start from the maintained index.",
          "",
          "## Related Concepts",
          "",
          "- Knowledge base",
        ].join("\n"),
      },
    ];
    const harness = createHarness({ cwd, agentResults });

    const refresh = await harness.execute("kb-refresh", "");
    if (!refresh || typeof refresh === "string") {
      throw new Error("Expected refresh ProcedureResult");
    }

    const compiledSourceId = (refresh.data as { compiledSourceIds: string[] }).compiledSourceIds[0];
    agentResults.push({
      title: "Why Index-First Retrieval Helps",
      abstract: "It helps the agent find relevant compiled pages before reading deeply.",
      descriptionWords: ["index", "first", "retrieval"],
      citedPages: [`wiki/sources/${compiledSourceId}.md`],
      answerMarkdown: [
        "# Why Index-First Retrieval Helps",
        "",
        "## Question",
        "",
        "Why does index-first retrieval help?",
        "",
        "## Answer",
        "",
        "It narrows the search surface before reading individual pages.",
        "",
        "## Sources",
        "",
        `- [Article Summary](../sources/${compiledSourceId}.md)`,
      ].join("\n"),
    });
    const answer = await harness.execute("kb-answer", "Why does index-first retrieval help?");
    if (!answer || typeof answer === "string") {
      throw new Error("Expected answer ProcedureResult");
    }

    const answerData = answer.data as { answerPath: string; citedPages: string[] };
    expect(existsSync(join(cwd, answerData.answerPath))).toBe(true);
    expect(answerData.citedPages).toEqual([`wiki/sources/${compiledSourceId}.md`]);

    const answersManifest = JSON.parse(
      readFileSync(join(cwd, ".kb", "manifests", "answers.json"), "utf8"),
    ) as Array<{ answerPath: string; title: string }>;
    expect(answersManifest).toHaveLength(1);
    expect(answersManifest[0]?.answerPath).toBe(answerData.answerPath);

    const index = readFileSync(join(cwd, "wiki", "index.md"), "utf8");
    expect(index).toContain("## Answers (1)");
    expect(index).toContain("Why Index-First Retrieval Helps");
  });

  test("/kb-render writes a derived report and updates render manifests", async () => {
    const cwd = createWorkspace();
    writeFileSync(join(cwd, "raw", "article.md"), "# Article\n\nContext for rendering.\n", "utf8");

    const agentResults: unknown[] = [
      {
        title: "Article Summary",
        sourceType: "article",
        abstract: "Compiled article summary.",
        concepts: ["Index-first retrieval"],
        tags: ["Knowledge"],
        questions: ["What next?"],
        pageMarkdown: [
          "# Article Summary",
          "",
          "## Source",
          "",
          "- Raw path: raw/article.md",
          "",
          "## Summary",
          "",
          "Compiled article summary.",
          "",
          "## Key Points",
          "",
          "- Index-first retrieval helps.",
          "",
          "## Open Questions",
          "",
          "- What next?",
        ].join("\n"),
      },
      {
        title: "Index-First Retrieval",
        abstract: "Concept page compiled from the article summary.",
        relatedConcepts: ["Knowledge base"],
        pageMarkdown: [
          "# Index-First Retrieval",
          "",
          "## Overview",
          "",
          "Index-first retrieval narrows the search surface before reading deeply.",
          "",
          "## Sources",
          "",
          "- [Article Summary](../sources/article-c52728b3.md)",
          "",
          "## Key Points",
          "",
          "- Start from the maintained index.",
          "",
          "## Related Concepts",
          "",
          "- Knowledge base",
        ].join("\n"),
      },
    ];
    const harness = createHarness({ cwd, agentResults });

    const refresh = await harness.execute("kb-refresh", "");
    if (!refresh || typeof refresh === "string") {
      throw new Error("Expected refresh ProcedureResult");
    }

    agentResults.push({
      title: "Index-First Retrieval Briefing",
      abstract: "A derived report for the concept page.",
      descriptionWords: ["index", "first", "briefing"],
      outputMarkdown: [
        "# Index-First Retrieval Briefing",
        "",
        "## Source Material",
        "",
        "- [Index-First Retrieval](../../wiki/concepts/index-first-retrieval.md)",
      ].join("\n"),
    });

    const render = await harness.execute(
      "kb-render",
      "kind=report page=wiki/concepts/index-first-retrieval.md",
    );
    if (!render || typeof render === "string") {
      throw new Error("Expected render ProcedureResult");
    }

    const renderData = render.data as { outputPath: string; sourcePages: string[] };
    expect(renderData.outputPath.startsWith("derived/reports/")).toBe(true);
    expect(existsSync(join(cwd, renderData.outputPath))).toBe(true);
    expect(renderData.sourcePages).toEqual(["wiki/concepts/index-first-retrieval.md"]);

    const rendersManifest = JSON.parse(
      readFileSync(join(cwd, ".kb", "manifests", "renders.json"), "utf8"),
    ) as Array<{ outputPath: string }>;
    expect(rendersManifest).toHaveLength(1);
    expect(rendersManifest[0]?.outputPath).toBe(renderData.outputPath);
    expect(readFileSync(join(cwd, "wiki", "index.md"), "utf8")).toContain("## Derived Outputs (1)");
  });

  test("/kb-health writes a report and deterministic repair queue", async () => {
    const cwd = createWorkspace();
    writeFileSync(join(cwd, "raw", "article.md"), "# Article\n\nNeeds compilation.\n", "utf8");

    const harness = createHarness({ cwd, agentResults: [] });
    await harness.execute("kb-ingest", "");
    const health = await harness.execute("kb-health", "");
    if (!health || typeof health === "string") {
      throw new Error("Expected health ProcedureResult");
    }

    const data = health.data as { issueCount: number; queuePath: string; reportPath: string };
    expect(data.issueCount).toBeGreaterThan(0);
    expect(existsSync(join(cwd, data.reportPath))).toBe(true);
    expect(existsSync(join(cwd, data.queuePath))).toBe(true);
    expect(readFileSync(join(cwd, data.queuePath), "utf8")).toContain("\"source-needs-compile\"");
  });
});

function createWorkspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), "nab-kb-"));
  tempDirs.push(cwd);
  mkdirSync(join(cwd, "raw"), { recursive: true });
  return cwd;
}

function createHarness(params: {
  cwd: string;
  agentResults: unknown[];
}): {
  prints: string[];
  execute(name: string, prompt: string): Promise<ProcedureResult | string | void>;
} {
  const procedures = new Map<string, Procedure>([
    ["kb-ingest", kbIngestProcedure],
    ["kb-compile-source", kbCompileSourceProcedure],
    ["kb-compile-concepts", kbCompileConceptsProcedure],
    ["kb-link", kbLinkProcedure],
    ["kb-render", kbRenderProcedure],
    ["kb-health", kbHealthProcedure],
    ["kb-refresh", kbRefreshProcedure],
    ["kb-answer", kbAnswerProcedure],
  ]);
  const prints: string[] = [];
  let cellCounter = 0;
  const defaultAgentConfig: DownstreamAgentConfig = {
    provider: "copilot",
    command: "bun",
    args: [],
    cwd: params.cwd,
  };

  async function invoke(name: string, prompt: string): Promise<ProcedureResult | string | void> {
    const procedure = procedures.get(name);
    if (!procedure) {
      throw new Error(`Unknown procedure in test harness: ${name}`);
    }

    const context = createMockContext({
      cwd: params.cwd,
      print: (text) => {
        prints.push(text);
      },
      getNextAgentResult: () => {
        const next = params.agentResults.shift();
        if (next === undefined) {
          throw new Error("Unexpected callAgent in test harness");
        }
        return next;
      },
      callProcedure: async (procedureName, procedurePrompt) => {
        const nested = await invoke(procedureName, procedurePrompt);
        const normalized = normalizeProcedureOutput(nested);
        cellCounter += 1;
        return {
          cell: {
            sessionId: "test-session",
            cellId: `proc-${cellCounter}`,
          },
          data: normalized.data,
        } as RunResult<unknown>;
      },
      defaultAgentConfig,
    });

    return await procedure.execute(prompt, context);
  }

  return {
    prints,
    async execute(name, prompt) {
      return await invoke(name, prompt);
    },
  };
}

function createMockContext(params: {
  cwd: string;
  print(text: string): void;
  getNextAgentResult(): unknown;
  callProcedure(name: string, prompt: string): Promise<RunResult<unknown>>;
  defaultAgentConfig: DownstreamAgentConfig;
}): CommandContext {
  let agentCounter = 0;

  const callAgent = async () => {
    agentCounter += 1;
    return {
      cell: {
        sessionId: "test-session",
        cellId: `agent-${agentCounter}`,
      },
      data: params.getNextAgentResult(),
    } as RunResult<unknown>;
  };

  return {
    cwd: params.cwd,
    sessionId: "test-session",
    refs: {
      async read() {
        throw new Error("Not implemented in test");
      },
      async stat() {
        throw new Error("Not implemented in test");
      },
      async writeToFile() {
        throw new Error("Not implemented in test");
      },
    },
    session: {
      async recent() {
        return [];
      },
      async topLevelRuns() {
        return [];
      },
      async get() {
        throw new Error("Not implemented in test");
      },
      async ancestors() {
        return [];
      },
      async descendants() {
        return [];
      },
    },
    getDefaultAgentConfig() {
      return params.defaultAgentConfig;
    },
    setDefaultAgentSelection() {
      return params.defaultAgentConfig;
    },
    async getDefaultAgentTokenSnapshot() {
      return undefined;
    },
    async getDefaultAgentTokenUsage() {
      return undefined;
    },
    callAgent: callAgent as CommandContext["callAgent"],
    callProcedure: params.callProcedure as CommandContext["callProcedure"],
    async continueDefaultSession() {
      throw new Error("Not implemented in test");
    },
    print: params.print,
  };
}

function normalizeProcedureOutput(
  value: ProcedureResult | string | void,
): ProcedureResult {
  if (!value) {
    return {};
  }

  if (typeof value === "string") {
    return { display: value };
  }

  return value;
}

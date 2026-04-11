import type { Procedure } from "../../src/core/types.ts";
import {
  appendKnowledgeBaseLog,
  ensureKnowledgeBaseLayout,
  needsSourceCompilation,
  normalizeConceptId,
  readAnswersManifest,
  readConceptsManifest,
  readRendersManifest,
  readSourcesManifest,
  writeDatedKnowledgeMarkdown,
  type HealthRepairIssue,
  type KnowledgeBaseHealthData,
} from "./lib/repository.ts";

export default {
  name: "kb/health",
  description: "Check KB consistency and write a deterministic repair queue",
  async execute(_prompt, ctx) {
    const paths = await ensureKnowledgeBaseLayout(ctx.cwd);
    const [sources, concepts, answers, renders] = await Promise.all([
      readSourcesManifest(ctx.cwd),
      readConceptsManifest(ctx.cwd),
      readAnswersManifest(ctx.cwd),
      readRendersManifest(ctx.cwd),
    ]);

    ctx.ui.text("Checking knowledge-base health...\n");
    const issues = await collectIssues(ctx.cwd, sources, concepts, answers, renders);
    const errorCount = issues.filter((issue) => issue.severity === "error").length;
    const warningCount = issues.length - errorCount;

    const reportPath = await writeDatedKnowledgeMarkdown(
      ctx.cwd,
      "derived/reports",
      ["kb", "health", "report"],
      buildHealthReportMarkdown(issues),
    );
    await Bun.write(paths.healthQueuePath, `${JSON.stringify(issues, null, 2)}\n`);

    await appendKnowledgeBaseLog(
      ctx.cwd,
      "health",
      `${issues.length} issue(s)`,
      [
        `errors: ${errorCount}`,
        `warnings: ${warningCount}`,
        `report: \`${reportPath}\``,
        `queue: \`${paths.healthQueuePath.replace(`${ctx.cwd}/`, "")}\``,
      ],
    );

    ctx.ui.text(`Wrote ${reportPath}.\n`);

    const data: KnowledgeBaseHealthData = {
      issueCount: issues.length,
      errorCount,
      warningCount,
      reportPath,
      queuePath: paths.healthQueuePath.replace(`${ctx.cwd}/`, ""),
    };

    return {
      data,
      display: issues.length === 0
        ? `Health check passed. Queue refreshed at ${data.queuePath}.\n`
        : `Health check found ${issues.length} issue(s): ${errorCount} error(s), ${warningCount} warning(s).\nReport written to ${reportPath}.\n`,
      summary: `kb/health: ${issues.length} issues`,
    };
  },
} satisfies Procedure;

async function collectIssues(
  cwd: string,
  sources: Awaited<ReturnType<typeof readSourcesManifest>>,
  concepts: Awaited<ReturnType<typeof readConceptsManifest>>,
  answers: Awaited<ReturnType<typeof readAnswersManifest>>,
  renders: Awaited<ReturnType<typeof readRendersManifest>>,
): Promise<HealthRepairIssue[]> {
  const issues: HealthRepairIssue[] = [];
  const sourceIds = new Set(sources.map((source) => source.sourceId));
  const conceptIds = new Set(concepts.map((concept) => concept.conceptId));

  for (const source of sources) {
    if (needsSourceCompilation(source)) {
      issues.push({
        severity: "warning",
        code: "source-needs-compile",
        message: `Source ${source.sourceId} needs source compilation.`,
        sourceId: source.sourceId,
      });
    }

    if (source.summaryPath && !(await Bun.file(`${cwd}/${source.summaryPath}`).exists())) {
      issues.push({
        severity: "error",
        code: "source-summary-missing",
        message: `Compiled source page is missing: ${source.summaryPath}`,
        sourceId: source.sourceId,
        pagePath: source.summaryPath,
      });
    }

    if (source.summaryPath && (!source.title || !source.abstract || !source.sourceType)) {
      issues.push({
        severity: "warning",
        code: "source-metadata-missing",
        message: `Compiled source metadata is incomplete for ${source.sourceId}.`,
        sourceId: source.sourceId,
        pagePath: source.summaryPath,
      });
    }

    if (source.summaryPath && source.concepts.length === 0) {
      issues.push({
        severity: "warning",
        code: "source-no-concepts",
        message: `Compiled source ${source.sourceId} has no concept routing metadata.`,
        sourceId: source.sourceId,
        pagePath: source.summaryPath,
      });
    }
  }

  for (const concept of concepts) {
    if (!(await Bun.file(`${cwd}/${concept.pagePath}`).exists())) {
      issues.push({
        severity: "error",
        code: "concept-page-missing",
        message: `Concept page is missing: ${concept.pagePath}`,
        conceptId: concept.conceptId,
        pagePath: concept.pagePath,
      });
    }

    if (concept.sourceIds.length === 0) {
      issues.push({
        severity: "warning",
        code: "concept-orphaned",
        message: `Concept ${concept.conceptId} has no source summaries.`,
        conceptId: concept.conceptId,
        pagePath: concept.pagePath,
      });
    }

    for (const sourceId of concept.sourceIds) {
      if (!sourceIds.has(sourceId)) {
        issues.push({
          severity: "error",
          code: "concept-source-missing",
          message: `Concept ${concept.conceptId} references missing source ${sourceId}.`,
          conceptId: concept.conceptId,
          sourceId,
          pagePath: concept.pagePath,
        });
      }
    }

    for (const relatedConceptId of concept.relatedConceptIds) {
      if (!conceptIds.has(relatedConceptId)) {
        issues.push({
          severity: "warning",
          code: "concept-related-missing",
          message: `Concept ${concept.conceptId} references missing related concept ${relatedConceptId}.`,
          conceptId: concept.conceptId,
          pagePath: concept.pagePath,
        });
      }
    }
  }

  for (const answer of answers) {
    if (!(await Bun.file(`${cwd}/${answer.answerPath}`).exists())) {
      issues.push({
        severity: "error",
        code: "answer-page-missing",
        message: `Answer page is missing: ${answer.answerPath}`,
        pagePath: answer.answerPath,
      });
    }

    for (const citedPage of answer.citedPages) {
      if (!(await Bun.file(`${cwd}/${citedPage}`).exists())) {
        issues.push({
          severity: "error",
          code: "answer-citation-missing",
          message: `Answer ${answer.answerId} cites missing page ${citedPage}.`,
          pagePath: answer.answerPath,
        });
      }
    }
  }

  for (const render of renders) {
    if (!(await Bun.file(`${cwd}/${render.outputPath}`).exists())) {
      issues.push({
        severity: "error",
        code: "render-output-missing",
        message: `Rendered output is missing: ${render.outputPath}`,
        pagePath: render.outputPath,
      });
    }

    for (const sourcePage of render.sourcePages) {
      if (!(await Bun.file(`${cwd}/${sourcePage}`).exists())) {
        issues.push({
          severity: "error",
          code: "render-source-missing",
          message: `Render ${render.renderId} references missing source page ${sourcePage}.`,
          pagePath: render.outputPath,
        });
      }
    }
  }

  const duplicateConcepts = findDuplicateConcepts(concepts);
  for (const group of duplicateConcepts) {
    issues.push({
      severity: "warning",
      code: "concept-duplicate",
      message: `Duplicate concept ids share the same normalized title: ${group.join(", ")}.`,
      conceptId: group[0],
    });
  }

  return issues.sort((left, right) =>
    severityRank(left.severity) - severityRank(right.severity) ||
    left.code.localeCompare(right.code) ||
    (left.pagePath ?? "").localeCompare(right.pagePath ?? "") ||
    (left.sourceId ?? "").localeCompare(right.sourceId ?? "") ||
    (left.conceptId ?? "").localeCompare(right.conceptId ?? "")
  );
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

  return [...groups.values()].filter((group) => new Set(group).size > 1);
}

function buildHealthReportMarkdown(issues: HealthRepairIssue[]): string {
  const lines = [
    "# Knowledge Base Health Report",
    "",
    issues.length === 0
      ? "No KB consistency issues were found."
      : `Found ${issues.length} issue(s): ${summarizeIssueCounts(issues)}.`,
    "",
  ];

  if (issues.length === 0) {
    return lines.join("\n");
  }

  const grouped = new Map<HealthRepairIssue["severity"], HealthRepairIssue[]>();
  for (const issue of issues) {
    const existing = grouped.get(issue.severity);
    if (existing) {
      existing.push(issue);
      continue;
    }
    grouped.set(issue.severity, [issue]);
  }

  for (const severity of ["error", "warning"] as const) {
    const sectionIssues = grouped.get(severity) ?? [];
    lines.push(`## ${severity === "error" ? "Errors" : "Warnings"} (${sectionIssues.length})`);
    lines.push("");
    if (sectionIssues.length === 0) {
      lines.push("_None._", "");
      continue;
    }

    for (const issue of sectionIssues) {
      lines.push(`- \`${issue.code}\` — ${issue.message}`);
      if (issue.pagePath) {
        lines.push(`  - page: \`${issue.pagePath}\``);
      }
      if (issue.sourceId) {
        lines.push(`  - source: \`${issue.sourceId}\``);
      }
      if (issue.conceptId) {
        lines.push(`  - concept: \`${issue.conceptId}\``);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

function summarizeIssueCounts(issues: HealthRepairIssue[]): string {
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.length - errors;
  return `${errors} error(s), ${warnings} warning(s)`;
}

function severityRank(severity: HealthRepairIssue["severity"]): number {
  return severity === "error" ? 0 : 1;
}

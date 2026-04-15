import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { summarizeText } from "@nanoboss/procedure-sdk";

import { resolveRepoArtifactDir, writeTextFileAtomicSync } from "../lib/repo-artifacts.ts";

import { ensureGitLocalExclude, resolveGitRepoRoot } from "./git.ts";
import type {
  AutoresearchExperimentRecord,
  AutoresearchPaths,
  AutoresearchState,
} from "./types.ts";

const AUTORESEARCH_STORAGE_SUBDIR = [".nanoboss", "autoresearch"] as const;
const AUTORESEARCH_LOCAL_EXCLUDE_PATTERN = "/.nanoboss/";

export function resolveAutoresearchPaths(cwd: string): AutoresearchPaths {
  const repoRoot = resolveGitRepoRoot(cwd);
  ensureGitLocalExclude(repoRoot, AUTORESEARCH_LOCAL_EXCLUDE_PATTERN);
  const storageDir = resolveRepoArtifactDir(repoRoot, ...AUTORESEARCH_STORAGE_SUBDIR);
  return {
    repoRoot,
    storageDir,
    statePath: join(storageDir, "autoresearch.state.json"),
    logPath: join(storageDir, "autoresearch.jsonl"),
    summaryPath: join(storageDir, "autoresearch.md"),
  };
}

export function readAutoresearchState(paths: AutoresearchPaths): AutoresearchState | undefined {
  if (!existsSync(paths.statePath)) {
    return undefined;
  }

  return JSON.parse(readFileSync(paths.statePath, "utf8")) as AutoresearchState;
}

export function writeAutoresearchState(paths: AutoresearchPaths, state: AutoresearchState): AutoresearchState {
  const nextState: AutoresearchState = {
    ...state,
    updatedAt: new Date().toISOString(),
    pendingContextNotes: normalizeNotes(state.pendingContextNotes),
  };
  writeTextFileAtomicSync(paths.statePath, `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

export function writeAutoresearchSummary(
  paths: AutoresearchPaths,
  state: AutoresearchState,
  records: AutoresearchExperimentRecord[],
): void {
  writeTextFileAtomicSync(paths.summaryPath, renderAutoresearchSummary(paths, state, records));
}

export function clearAutoresearchArtifacts(paths: AutoresearchPaths): void {
  rmSync(paths.storageDir, { recursive: true, force: true });
}

export function renderAutoresearchSummary(
  paths: AutoresearchPaths,
  state: AutoresearchState,
  records: AutoresearchExperimentRecord[],
): string {
  const recentRecords = records.slice(-8).reverse();
  const lines = [
    "# Autoresearch session",
    "",
    `- Goal: ${state.goalSummary}`,
    `- Status: ${state.status}`,
    `- Branch: ${state.branchName}`,
    `- Base branch: ${state.baseBranch}`,
    `- Iterations completed: ${state.iterationCount}/${state.maxIterations}`,
    `- Files in scope: ${state.filesInScope.length > 0 ? state.filesInScope.join(", ") : "(not specified)"}`,
    `- Best metric: ${formatMetricValue(state.currentBestMetric, state.benchmark.metric.unit)}`,
    state.currentBestRunId ? `- Best run: ${state.currentBestRunId}` : undefined,
    state.currentBestCommit ? `- Best commit: ${state.currentBestCommit}` : undefined,
    `- State file: ${paths.statePath}`,
    `- Log file: ${paths.logPath}`,
    "",
    "## Objective",
    "",
    state.goal,
    "",
    state.summary ? "## Session summary" : undefined,
    state.summary ? "" : undefined,
    state.summary,
    state.summary ? "" : undefined,
    "## Recent runs",
    "",
  ].filter((line): line is string => typeof line === "string");

  if (recentRecords.length === 0) {
    lines.push("_No runs recorded yet._");
  } else {
    for (const record of recentRecords) {
      const metric = formatMetricValue(record.benchmark.metric, state.benchmark.metric.unit);
      lines.push(
        `- ${record.id}: ${record.decision.status}; metric=${metric}; reason=${summarizeText(record.decision.reason, 160)}`,
      );
    }
  }

  lines.push("", "## Pending continuation notes", "");
  if (state.pendingContextNotes.length === 0) {
    lines.push("_None_");
  } else {
    for (const note of state.pendingContextNotes) {
      lines.push(`- ${note}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function formatMetricValue(value: number | undefined, unit?: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }

  const rounded = Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/u, "").replace(/\.$/u, "");
  return unit ? `${rounded} ${unit}` : rounded;
}

function normalizeNotes(notes: string[]): string[] {
  return [...new Set(notes.map((note) => note.trim()).filter((note) => note.length > 0))];
}

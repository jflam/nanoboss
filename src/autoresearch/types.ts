export type AutoresearchDirection = "lower" | "higher";

export interface AutoresearchCommandSpec {
  argv: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export type AutoresearchMetricSource =
  | "stdout-regex"
  | "stderr-regex"
  | "exit-code"
  | "json-path";

export interface AutoresearchMetricConfig {
  name: string;
  direction: AutoresearchDirection;
  unit?: string;
  betterDelta?: number;
  source: AutoresearchMetricSource;
  pattern?: string;
  flags?: string;
  captureGroup?: number;
  jsonStream?: "stdout" | "stderr";
  path?: string;
}

export interface AutoresearchBenchmarkConfig extends AutoresearchCommandSpec {
  metric: AutoresearchMetricConfig;
  samples?: number;
}

export interface AutoresearchCheckConfig extends AutoresearchCommandSpec {
  name: string;
  allowExitCodes?: number[];
}

export interface AutoresearchConfidenceSummary {
  sampleCount: number;
  mean: number;
  min: number;
  max: number;
  stddev: number;
  latest: number;
}

export interface AutoresearchBenchmarkResult {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  samples: number[];
  metric?: number;
}

export interface AutoresearchCheckResult {
  name: string;
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  passed: boolean;
}

export type AutoresearchDecisionStatus =
  | "baseline"
  | "kept"
  | "rejected"
  | "failed"
  | "stopped";

export interface AutoresearchDecision {
  status: AutoresearchDecisionStatus;
  kept: boolean;
  reason: string;
  improvement?: number;
}

export interface AutoresearchExperimentRecord {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  kind: "baseline" | "iteration";
  iteration: number;
  idea: string;
  rationale?: string;
  editInstructions?: string;
  expectedMetricEffect?: string;
  filesInScope: string[];
  promptContext: string[];
  agentSummary?: string;
  beforeBestMetric?: number;
  benchmark: AutoresearchBenchmarkResult;
  checks: AutoresearchCheckResult[];
  decision: AutoresearchDecision;
  changedFiles: string[];
  keptCommit?: string;
  confidence?: AutoresearchConfidenceSummary;
}

export interface AutoresearchState {
  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
  sessionId: string;
  goal: string;
  goalSummary: string;
  summary?: string;
  status: "active" | "inactive";
  repoRoot: string;
  branchName: string;
  baseBranch: string;
  baseCommit: string;
  mergeBaseCommit: string;
  iterationCount: number;
  maxIterations: number;
  filesInScope: string[];
  benchmark: AutoresearchBenchmarkConfig;
  checks: AutoresearchCheckConfig[];
  currentBestRunId?: string;
  currentBestMetric?: number;
  currentBestCommit?: string;
  baselineRunId?: string;
  lastRunId?: string;
  pendingContextNotes: string[];
}

export interface AutoresearchPaths {
  repoRoot: string;
  storageDir: string;
  statePath: string;
  logPath: string;
  summaryPath: string;
}

export interface AutoresearchInitPlan {
  goalSummary: string;
  summary?: string;
  branchName?: string;
  maxIterations?: number;
  filesInScope: string[];
  benchmark: AutoresearchBenchmarkConfig;
  checks?: AutoresearchCheckConfig[];
}

export interface AutoresearchExperimentSpec {
  stop?: boolean;
  stopReason?: string;
  idea: string;
  rationale: string;
  filesInScope: string[];
  editInstructions: string;
  expectedMetricEffect?: string;
  commitMessage?: string;
}

export interface AutoresearchApplyResult {
  summary: string;
  touchedFiles: string[];
}

export interface AutoresearchChangedFiles {
  tracked: string[];
  untracked: string[];
  all: string[];
}

export interface AutoresearchFinalizeBranch {
  runId: string;
  sourceCommit: string;
  branchName: string;
  cherryPickedCommit: string;
  idea: string;
}

import typia from "typia";

import { normalizeRunCancelledError } from "../../src/core/cancellation.ts";
import { getSessionDir } from "../../src/core/config.ts";
import { formatErrorMessage } from "../../src/core/error-format.ts";
import { ProcedureDispatchJobManager } from "../../src/procedure/dispatch-jobs.ts";
import { expectData } from "../../src/core/run-result.ts";
import {
  jsonType,
  type CommandContext,
  type ProcedureResult,
} from "../../src/core/types.ts";
import { summarizeText } from "../../src/util/text.ts";

import { runBenchmark, runChecks } from "./benchmark.ts";
import {
  branchExists,
  cherryPickCommit,
  commitPaths,
  createAndSwitchBranch,
  ensureCleanWorktree,
  getChangedFiles,
  getCurrentBranch,
  getHeadCommit,
  getMergeBase,
  makeUniqueBranchName,
  revertWorkingTreeChanges,
  switchToBranch,
} from "./git.ts";
import { appendExperimentRecord, computeConfidenceSummary, readExperimentLog } from "./log.ts";
import {
  clearAutoresearchArtifacts,
  formatMetricValue,
  readAutoresearchState,
  resolveAutoresearchPaths,
  writeAutoresearchState,
  writeAutoresearchSummary,
} from "./state.ts";
import type {
  AutoresearchApplyResult,
  AutoresearchBenchmarkResult,
  AutoresearchChangedFiles,
  AutoresearchDecision,
  AutoresearchExperimentRecord,
  AutoresearchExperimentSpec,
  AutoresearchFinalizeBranch,
  AutoresearchInitPlan,
  AutoresearchPaths,
  AutoresearchState,
} from "./types.ts";

const DEFAULT_MAX_ITERATIONS = 10;

const AutoresearchInitPlanType = jsonType<AutoresearchInitPlan>(
  typia.json.schema<AutoresearchInitPlan>(),
  typia.createValidate<AutoresearchInitPlan>(),
);

const AutoresearchExperimentSpecType = jsonType<AutoresearchExperimentSpec>(
  typia.json.schema<AutoresearchExperimentSpec>(),
  typia.createValidate<AutoresearchExperimentSpec>(),
);

const AutoresearchApplyResultType = jsonType<AutoresearchApplyResult>(
  typia.json.schema<AutoresearchApplyResult>(),
  typia.createValidate<AutoresearchApplyResult>(),
);

type AutoresearchIterationResult =
  | {
      kind: "recorded";
      state: AutoresearchState;
      record: AutoresearchExperimentRecord;
    }
  | {
      kind: "stopped";
      state: AutoresearchState;
      stopReason: string;
    };

export async function executeAutoresearchCommand(
  prompt: string,
  _ctx: CommandContext,
): Promise<ProcedureResult> {
  const trimmed = prompt.trim();
  const lines = [
    "Autoresearch v1 uses explicit commands:",
    "- /autoresearch/start <goal>",
    "- /autoresearch/continue [note]",
    "- /autoresearch/status",
    "- /autoresearch/finalize",
    "- /autoresearch/clear",
  ];

  if (trimmed.length > 0) {
    lines.push("", `Use /autoresearch/start or /autoresearch/continue instead of \`/autoresearch ${trimmed}\`.`);
  }

  return {
    display: `${lines.join("\n")}\n`,
    summary: "autoresearch: overview",
  };
}

export async function executeAutoresearchStartCommand(
  prompt: string,
  ctx: CommandContext,
): Promise<ProcedureResult> {
  const goal = prompt.trim();
  if (!goal) {
    return {
      display: "Provide an optimization goal for /autoresearch/start.\n",
      summary: "autoresearch/start: missing goal",
    };
  }

  const paths = resolveAutoresearchPaths(ctx.cwd);
  const state = readAutoresearchState(paths);
  if (state) {
    return {
      data: {
        branchName: state.branchName,
        statePath: paths.statePath,
      },
      display: [
        `Autoresearch state already exists on ${state.branchName}.`,
        "Use /autoresearch/continue [note] to keep going, or /autoresearch/clear to reset the session.",
      ].join("\n") + "\n",
      summary: "autoresearch/start: existing session",
    };
  }

  return await runAutoresearchWithCancellationRecovery(
    paths,
    () => initializeAutoresearch(paths, goal, ctx),
  );
}

export async function executeAutoresearchContinueCommand(
  prompt: string,
  ctx: CommandContext,
): Promise<ProcedureResult> {
  const note = prompt.trim() || undefined;
  const paths = resolveAutoresearchPaths(ctx.cwd);
  const state = readAutoresearchState(paths);
  if (!state) {
    return {
      display: formatMissingAutoresearchDisplay("continue"),
      summary: "autoresearch/continue: missing state",
    };
  }

  if (state.iterationCount >= state.maxIterations) {
    return {
      data: {
        branchName: state.branchName,
        iterationCount: state.iterationCount,
        maxIterations: state.maxIterations,
      },
      display: [
        `Autoresearch has already reached its iteration budget on ${state.branchName}.`,
        "Use /autoresearch/finalize to review kept wins, or /autoresearch/clear to start over.",
      ].join("\n") + "\n",
      summary: "autoresearch/continue: iteration budget exhausted",
    };
  }

  if (typeof state.currentBestMetric !== "number") {
    return {
      data: {
        branchName: state.branchName,
        statePath: paths.statePath,
      },
      display: [
        `Cannot continue autoresearch on ${state.branchName} because the baseline never completed successfully.`,
        "Run /autoresearch/clear and start a new session with /autoresearch/start <goal>.",
      ].join("\n") + "\n",
      summary: "autoresearch/continue: baseline unavailable",
    };
  }

  const prepared = prepareAutoresearchBranch(paths, state);
  if ("pausedResult" in prepared) {
    return prepared.pausedResult;
  }

  printAutoresearchProgress(ctx, `Continuing autoresearch on ${state.branchName}...`);

  const records = readExperimentLog(paths);
  const nextState = writeAutoresearchState(paths, {
    ...state,
    status: "active",
    pendingContextNotes: note ? [...state.pendingContextNotes, note] : state.pendingContextNotes,
  });

  return await runAutoresearchWithCancellationRecovery(
    paths,
    () => runForegroundAutoresearchLoop({
      paths,
      state: nextState,
      records,
      ctx,
    }),
  );
}

export async function executeAutoresearchStatusCommand(
  prompt: string,
  ctx: CommandContext,
): Promise<ProcedureResult> {
  void prompt;
  const paths = resolveAutoresearchPaths(ctx.cwd);
  return buildStatusResult(paths, readAutoresearchState(paths), readExperimentLog(paths));
}

export async function executeAutoresearchClearCommand(
  prompt: string,
  ctx: CommandContext,
): Promise<ProcedureResult> {
  void prompt;
  const paths = resolveAutoresearchPaths(ctx.cwd);
  const state = readAutoresearchState(paths);
  if (!state) {
    return {
      display: formatMissingAutoresearchDisplay("clear"),
      summary: "autoresearch/clear: missing state",
    };
  }

  const cancelledDispatchCount = state.status === "active"
    ? cancelActiveAutoresearchDispatches(ctx)
    : 0;
  if (state.status !== "active") {
    ensureCleanWorktree(paths.repoRoot, "clear autoresearch state");
  }
  clearAutoresearchArtifacts(paths);

  return {
    data: {
      cleared: true,
      cancelledDispatchCount,
      storageDir: paths.storageDir,
    },
    display: cancelledDispatchCount > 0
      ? `Cancelled ${cancelledDispatchCount} active autoresearch dispatch${cancelledDispatchCount === 1 ? "" : "es"} and cleared state from ${paths.storageDir}.\n`
      : `Cleared autoresearch state from ${paths.storageDir}.\n`,
    summary: "autoresearch/clear: cleared state",
  };
}

export async function executeAutoresearchFinalizeCommand(
  prompt: string,
  ctx: CommandContext,
): Promise<ProcedureResult> {
  void prompt;
  const paths = resolveAutoresearchPaths(ctx.cwd);
  const state = readAutoresearchState(paths);
  if (!state) {
    return {
      display: formatMissingAutoresearchDisplay("finalize"),
      summary: "autoresearch/finalize: missing state",
    };
  }

  ensureCleanWorktree(paths.repoRoot, "finalize autoresearch");
  const records = readExperimentLog(paths);
  const keptRecords = records.filter(isKeptAutoresearchRecord);
  if (keptRecords.length === 0) {
    return {
      data: {
        branches: [],
      },
      display: "No kept experiment commits were logged, so there is nothing to finalize.\n",
      summary: "autoresearch/finalize: no kept commits",
    };
  }

  const originalBranch = getCurrentBranch(paths.repoRoot);
  const createdBranches: AutoresearchFinalizeBranch[] = [];
  const commitChain: string[] = [];

  try {
    for (const record of keptRecords) {
      commitChain.push(record.keptCommit);
      const baseName = sanitizeBranchName(`autoresearch-review/${record.iteration}-${record.idea}`);
      const branchName = makeUniqueBranchName(paths.repoRoot, baseName);
      createAndSwitchBranch(paths.repoRoot, branchName, state.mergeBaseCommit);
      let cherryPickedCommit = state.mergeBaseCommit;
      for (const commitSha of commitChain) {
        cherryPickedCommit = cherryPickCommit(paths.repoRoot, commitSha);
      }
      createdBranches.push({
        runId: record.id,
        sourceCommit: record.keptCommit,
        branchName,
        cherryPickedCommit,
        idea: record.idea,
      });
      switchToBranch(paths.repoRoot, originalBranch);
    }
  } catch (error) {
    if (branchExists(paths.repoRoot, originalBranch)) {
      switchToBranch(paths.repoRoot, originalBranch);
    }
    throw error;
  }

  return {
    data: {
      branches: createdBranches,
    },
    display: [
      `Created ${createdBranches.length} review branch${createdBranches.length === 1 ? "" : "es"} from ${state.mergeBaseCommit.slice(0, 12)}:`,
      ...createdBranches.map((branch) => `- ${branch.branchName}: ${branch.cherryPickedCommit.slice(0, 12)} (${branch.runId})`),
    ].join("\n") + "\n",
    summary: `autoresearch/finalize: ${createdBranches.length} branches`,
  };
}

function isKeptAutoresearchRecord(
  record: AutoresearchExperimentRecord,
): record is AutoresearchExperimentRecord & { keptCommit: string } {
  return record.decision.status === "kept"
    && typeof record.keptCommit === "string"
    && record.keptCommit.length > 0;
}

async function initializeAutoresearch(
  paths: AutoresearchPaths,
  goal: string,
  ctx: CommandContext,
): Promise<ProcedureResult> {
  ensureCleanWorktree(paths.repoRoot, "start autoresearch");
  printAutoresearchProgress(ctx, "Configuring autoresearch session...");

  const initPlan = await buildInitializationPlan(goal, ctx);
  const baseBranch = getCurrentBranch(paths.repoRoot) || "HEAD";
  const baseCommit = getHeadCommit(paths.repoRoot);
  const desiredBranchName = sanitizeBranchName(initPlan.branchName ?? `autoresearch/${initPlan.goalSummary}`);
  const branchName = makeUniqueBranchName(paths.repoRoot, desiredBranchName);
  createAndSwitchBranch(paths.repoRoot, branchName, baseCommit);

  let state = writeAutoresearchState(paths, {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionId: ctx.sessionId,
    goal,
    goalSummary: initPlan.goalSummary.trim(),
    summary: initPlan.summary?.trim() || undefined,
    status: "active",
    repoRoot: paths.repoRoot,
    branchName,
    baseBranch,
    baseCommit,
    mergeBaseCommit: getMergeBase(paths.repoRoot, baseCommit, "HEAD"),
    iterationCount: 0,
    maxIterations: initPlan.maxIterations && initPlan.maxIterations > 0 ? initPlan.maxIterations : DEFAULT_MAX_ITERATIONS,
    filesInScope: [...new Set(initPlan.filesInScope)].sort(),
    benchmark: initPlan.benchmark,
    checks: initPlan.checks ?? [],
    pendingContextNotes: [],
  });

  printAutoresearchProgress(
    ctx,
    `Running baseline benchmark (${summarizeText(state.benchmark.argv.join(" "), 80)})...`,
  );

  const baseline = runBenchmark(state.benchmark, paths.repoRoot);
  const baselineChecks = baseline.exitCode === 0 ? runChecks(state.checks, paths.repoRoot) : [];
  assertAutoresearchNotCancelled(ctx);
  const baselineDecision = evaluateBaselineDecision(state, baseline, baselineChecks);

  const baselineRecord: AutoresearchExperimentRecord = {
    schemaVersion: 1,
    id: "baseline",
    createdAt: new Date().toISOString(),
    kind: "baseline",
    iteration: 0,
    idea: "baseline benchmark",
    filesInScope: state.filesInScope,
    promptContext: [],
    benchmark: baseline,
    checks: baselineChecks,
    decision: {
      ...baselineDecision,
      status: baselineDecision.status === "failed" ? "failed" : "baseline",
      kept: baselineDecision.status !== "failed",
    },
    changedFiles: [],
    confidence: computeConfidenceSummary([], baseline.metric),
  };

  appendExperimentRecord(paths, baselineRecord);
  state = writeAutoresearchState(paths, updateStateAfterRecord(state, baselineRecord));
  writeAutoresearchSummary(paths, state, [baselineRecord]);

  printAutoresearchProgress(
    ctx,
    baselineRecord.decision.status === "failed"
      ? `Baseline failed: ${baselineRecord.decision.reason}.`
      : `Baseline: ${state.benchmark.metric.name} -> ${formatMetricValue(baselineRecord.benchmark.metric, state.benchmark.metric.unit)}.`,
  );

  if (baselineRecord.decision.status === "failed") {
    state = writeAutoresearchState(paths, {
      ...state,
      status: "inactive",
    });
    writeAutoresearchSummary(paths, state, [baselineRecord]);
    printAutoresearchProgress(
      ctx,
      `Autoresearch finished after ${state.iterationCount} iteration${state.iterationCount === 1 ? "" : "s"}. Best ${state.benchmark.metric.name}: ${formatMetricValue(state.currentBestMetric, state.benchmark.metric.unit)}. Reason: ${baselineRecord.decision.reason}.`,
    );
    return buildForegroundCompletionResult(paths, state, [baselineRecord], baselineRecord.decision.reason);
  }

  return await runForegroundAutoresearchLoop({
    paths,
    state,
    records: [baselineRecord],
    ctx,
  });
}

async function runForegroundAutoresearchLoop(params: {
  paths: AutoresearchPaths;
  state: AutoresearchState;
  records: AutoresearchExperimentRecord[];
  ctx: CommandContext;
}): Promise<ProcedureResult> {
  let state = params.state;
  let records = params.records;
  let completionReason: string | undefined;

  while (state.iterationCount < state.maxIterations) {
    assertAutoresearchNotCancelled(params.ctx);
    printAutoresearchProgress(
      params.ctx,
      `Iteration ${state.iterationCount + 1}/${state.maxIterations}: selecting the next experiment.`,
    );

    const iteration = await runAutoresearchIteration({
      paths: params.paths,
      state,
      records,
      ctx: params.ctx,
    });

    state = iteration.state;
    if (iteration.kind === "stopped") {
      completionReason = iteration.stopReason;
      break;
    }

    records = [...records, iteration.record];

    if (iteration.record.decision.reason.startsWith("Check failed: ")) {
      printAutoresearchProgress(
        params.ctx,
        `Checks failed: ${iteration.record.decision.reason.slice("Check failed: ".length)}. Reverting candidate.`,
      );
    }

    switch (iteration.record.decision.status) {
      case "kept":
        printAutoresearchProgress(
          params.ctx,
          `Result: ${formatMetricValue(iteration.record.benchmark.metric, state.benchmark.metric.unit)}, improvement kept.`,
        );
        break;
      case "rejected":
        printAutoresearchProgress(
          params.ctx,
          `Result: ${formatMetricValue(iteration.record.benchmark.metric, state.benchmark.metric.unit)}, reverted.`,
        );
        break;
      case "failed":
        if (!iteration.record.decision.reason.startsWith("Check failed: ")) {
          printAutoresearchProgress(params.ctx, `Experiment failed: ${iteration.record.decision.reason}.`);
        }
        break;
    }
  }

  state = writeAutoresearchState(params.paths, {
    ...state,
    status: "inactive",
  });
  writeAutoresearchSummary(params.paths, state, records);

  printAutoresearchProgress(
    params.ctx,
    completionReason
      ? `Autoresearch finished after ${state.iterationCount} iteration${state.iterationCount === 1 ? "" : "s"}. Best ${state.benchmark.metric.name}: ${formatMetricValue(state.currentBestMetric, state.benchmark.metric.unit)}. Reason: ${completionReason}.`
      : `Autoresearch finished after ${state.iterationCount} iteration${state.iterationCount === 1 ? "" : "s"}. Best ${state.benchmark.metric.name}: ${formatMetricValue(state.currentBestMetric, state.benchmark.metric.unit)}.`,
  );

  return buildForegroundCompletionResult(params.paths, state, records, completionReason);
}

async function runAutoresearchIteration(params: {
  paths: AutoresearchPaths;
  state: AutoresearchState;
  records: AutoresearchExperimentRecord[];
  ctx: CommandContext;
}): Promise<AutoresearchIterationResult> {
  const experiment = await proposeExperiment(params.ctx, params.state, params.records);
  if (experiment.stop) {
    const stoppedState = writeAutoresearchState(params.paths, {
      ...params.state,
      pendingContextNotes: [],
    });
    return {
      kind: "stopped",
      state: stoppedState,
      stopReason: experiment.stopReason ?? "agent requested stop",
    };
  }

  const stateBeforeIteration = writeAutoresearchState(params.paths, {
    ...params.state,
    pendingContextNotes: [],
  });

  printAutoresearchProgress(params.ctx, `Candidate: ${summarizeText(experiment.idea, 120)}.`);

  const applied = await applyExperiment(params.ctx, stateBeforeIteration, experiment, params.records);
  assertAutoresearchNotCancelled(params.ctx);
  printAutoresearchProgress(
    params.ctx,
    applied.summary.trim().length > 0
      ? `Applied candidate: ${summarizeText(applied.summary.trim(), 120)}.`
      : "Applied candidate.",
  );
  printAutoresearchProgress(
    params.ctx,
    `Benchmarking candidate (${summarizeText(stateBeforeIteration.benchmark.argv.join(" "), 80)})...`,
  );

  const iteration = stateBeforeIteration.iterationCount + 1;
  const runId = `run-${String(iteration).padStart(4, "0")}`;
  const record = await executeExperimentRun({
    runId,
    iteration,
    paths: params.paths,
    state: params.state,
    priorRecords: params.records,
    experiment,
    applied,
    ctx: params.ctx,
  });
  appendExperimentRecord(params.paths, record);

  const nextState = writeAutoresearchState(params.paths, updateStateAfterRecord(stateBeforeIteration, record));
  writeAutoresearchSummary(params.paths, nextState, [...params.records, record]);

  return {
    kind: "recorded",
    state: nextState,
    record,
  };
}

function buildForegroundCompletionResult(
  paths: AutoresearchPaths,
  state: AutoresearchState,
  records: AutoresearchExperimentRecord[],
  reason?: string,
): ProcedureResult {
  const lastRecord = records.at(-1);
  return {
    data: {
      status: state.status,
      branchName: state.branchName,
      bestMetric: state.currentBestMetric,
      iterationCount: state.iterationCount,
      maxIterations: state.maxIterations,
      statePath: paths.statePath,
      logPath: paths.logPath,
      summaryPath: paths.summaryPath,
    },
    display: [
      `Autoresearch finished on ${state.branchName}.`,
      `Best ${state.benchmark.metric.name}: ${formatMetricValue(state.currentBestMetric, state.benchmark.metric.unit)}.`,
      `Iterations: ${state.iterationCount}/${state.maxIterations}.`,
      lastRecord ? `Last run: ${lastRecord.id} (${lastRecord.decision.status}).` : "Last run: none.",
      reason ? `Reason: ${reason}.` : undefined,
      `State: ${paths.statePath}.`,
    ].filter((line): line is string => typeof line === "string").join("\n") + "\n",
    summary: `autoresearch: completed ${state.branchName}`,
    memory: `Autoresearch state for ${state.branchName} lives at ${paths.statePath}.`,
  };
}

function assertAutoresearchNotCancelled(ctx: Pick<CommandContext, "assertNotCancelled">): void {
  ctx.assertNotCancelled();
}

function cancelActiveAutoresearchDispatches(ctx: CommandContext): number {
  const manager = new ProcedureDispatchJobManager({
    cwd: ctx.cwd,
    sessionId: ctx.sessionId,
    rootDir: getSessionDir(ctx.sessionId),
    getRegistry: async () => {
      throw new Error("Procedure registry is unavailable during autoresearch clear.");
    },
  });
  return manager.cancelMatchingProcedures([
    "autoresearch/start",
    "autoresearch/continue",
  ]);
}

async function buildInitializationPlan(prompt: string, ctx: CommandContext): Promise<AutoresearchInitPlan> {
  const result = await ctx.callAgent(
    [
      "You are configuring a deterministic autoresearch optimization session for NanoBoss.",
      "Inspect the repository and the user's goal, then return a JSON object matching this schema exactly.",
      "Include `maxIterations` explicitly in the JSON response as a positive integer.",
      "The benchmark and checks must use explicit argv arrays instead of shell pipelines.",
      "The metric must be deterministic and machine-readable using one of: stdout-regex, stderr-regex, exit-code, json-path.",
      "Choose a short, descriptive goalSummary and a safe branchName if helpful.",
      "Prefer a narrow filesInScope list.",
      "Do not include prose outside the JSON object.",
      "",
      `User goal:\n${prompt.trim()}`,
    ].join("\n"),
    AutoresearchInitPlanType,
    { stream: false },
  );
  return expectData(result, "Autoresearch initialization returned no data");
}

async function proposeExperiment(
  ctx: CommandContext,
  state: AutoresearchState,
  records: AutoresearchExperimentRecord[],
): Promise<AutoresearchExperimentSpec> {
  const recentRecords = records
    .slice(-5)
    .map((record) => `- ${record.id}: ${record.decision.status}; reason=${record.decision.reason}`);
  const result = await ctx.callAgent(
    [
      "You are choosing the next experiment for a deterministic autoresearch loop.",
      "Return a JSON object only.",
      "If no worthwhile next step remains, set `stop=true` and explain why in `stopReason`.",
      "Otherwise provide a single scoped experiment with idea, rationale, filesInScope, and editInstructions.",
      "The experiment must stay within the declared files in scope unless there is a compelling reason.",
      "",
      `Goal: ${state.goal}`,
      `Goal summary: ${state.goalSummary}`,
      `Current best ${state.benchmark.metric.name}: ${formatMetricValue(state.currentBestMetric, state.benchmark.metric.unit)}`,
      `Direction: ${state.benchmark.metric.direction}`,
      `Files in scope: ${state.filesInScope.join(", ") || "(not specified)"}`,
      state.pendingContextNotes.length > 0 ? `Pending notes:\n- ${state.pendingContextNotes.join("\n- ")}` : "Pending notes: (none)",
      recentRecords.length > 0 ? `Recent runs:\n${recentRecords.join("\n")}` : "Recent runs: none",
    ].join("\n"),
    AutoresearchExperimentSpecType,
    { stream: false },
  );
  return expectData(result, "Autoresearch experiment selection returned no data");
}

async function applyExperiment(
  ctx: CommandContext,
  state: AutoresearchState,
  experiment: AutoresearchExperimentSpec,
  records: AutoresearchExperimentRecord[],
): Promise<AutoresearchApplyResult> {
  const recentFailures = records
    .filter((record) => record.decision.status === "rejected" || record.decision.status === "failed")
    .slice(-3)
    .map((record) => `- ${record.idea}: ${record.decision.reason}`);
  const result = await ctx.callAgent(
    [
      "Apply the following autoresearch experiment directly in the repository.",
      "Edit the code; do not run git commands and do not commit anything.",
      "Stay scoped to the requested files whenever possible.",
      "Return a JSON object with `summary` and `touchedFiles` only after the edits are complete.",
      "",
      `Goal: ${state.goal}`,
      `Files in scope: ${state.filesInScope.join(", ") || "(not specified)"}`,
      `Experiment idea: ${experiment.idea}`,
      `Rationale: ${experiment.rationale}`,
      `Expected metric effect: ${experiment.expectedMetricEffect ?? "not specified"}`,
      `Edit instructions:\n${experiment.editInstructions}`,
      recentFailures.length > 0 ? `Recent failed ideas:\n${recentFailures.join("\n")}` : "Recent failed ideas: none",
    ].join("\n"),
    AutoresearchApplyResultType,
    { stream: false },
  );
  return expectData(result, "Autoresearch experiment application returned no data");
}

async function executeExperimentRun(params: {
  runId: string;
  iteration: number;
  paths: AutoresearchPaths;
  state: AutoresearchState;
  priorRecords: AutoresearchExperimentRecord[];
  experiment: AutoresearchExperimentSpec;
  applied: AutoresearchApplyResult;
  ctx: CommandContext;
}): Promise<AutoresearchExperimentRecord> {
  const promptContext = params.state.pendingContextNotes;
  const changedBeforeEvaluation = getChangedFiles(params.paths.repoRoot);
  let changedAfterEvaluation = changedBeforeEvaluation;
  let benchmark = emptyBenchmarkResult(params.state, params.paths.repoRoot);
  let checks: ReturnType<typeof runChecks> = [];
  let decision: AutoresearchDecision;
  let keptCommit: string | undefined;

  try {
    if (changedBeforeEvaluation.all.length === 0) {
      decision = {
        status: "failed",
        kept: false,
        reason: "Experiment produced no file changes",
      };
    } else {
      benchmark = runBenchmark(params.state.benchmark, params.paths.repoRoot);
      assertAutoresearchNotCancelled(params.ctx);
      checks = benchmark.exitCode === 0 ? runChecks(params.state.checks, params.paths.repoRoot) : [];
      assertAutoresearchNotCancelled(params.ctx);
      changedAfterEvaluation = getChangedFiles(params.paths.repoRoot);
      decision = evaluateRecordDecision(
        params.state,
        benchmark,
        checks,
        changedBeforeEvaluation,
        changedAfterEvaluation,
      );
    }
  } catch (error) {
    changedAfterEvaluation = getChangedFiles(params.paths.repoRoot);
    const cancelled = normalizeRunCancelledError(error, "soft_stop");
    if (cancelled) {
      if (changedAfterEvaluation.all.length > 0) {
        revertWorkingTreeChanges(params.paths.repoRoot, changedAfterEvaluation);
      }
      throw cancelled;
    }
    decision = {
      status: "failed",
      kept: false,
      reason: formatErrorMessage(error),
    };
  }

  if (decision.kept) {
    keptCommit = commitPaths(
      params.paths.repoRoot,
      changedAfterEvaluation.all,
      params.experiment.commitMessage ?? `autoresearch: ${params.experiment.idea}`,
    );
  } else if (changedAfterEvaluation.all.length > 0) {
    revertWorkingTreeChanges(params.paths.repoRoot, changedAfterEvaluation);
  }

  return {
    schemaVersion: 1,
    id: params.runId,
    createdAt: new Date().toISOString(),
    kind: "iteration",
    iteration: params.iteration,
    idea: params.experiment.idea,
    rationale: params.experiment.rationale,
    editInstructions: params.experiment.editInstructions,
    expectedMetricEffect: params.experiment.expectedMetricEffect,
    filesInScope: params.experiment.filesInScope,
    promptContext,
    agentSummary: params.applied.summary,
    beforeBestMetric: params.state.currentBestMetric,
    benchmark,
    checks,
    decision,
    changedFiles: changedAfterEvaluation.all,
    keptCommit,
    confidence: computeConfidenceSummary(params.priorRecords, benchmark.metric),
  };
}

function evaluateRecordDecision(
  state: AutoresearchState,
  benchmark: AutoresearchBenchmarkResult,
  checks: ReturnType<typeof runChecks>,
  changedBeforeEvaluation: AutoresearchChangedFiles,
  changedAfterEvaluation: AutoresearchChangedFiles,
): AutoresearchDecision {
  if (changedBeforeEvaluation.all.length === 0) {
    return {
      status: "failed",
      kept: false,
      reason: "Experiment produced no file changes",
    };
  }

  const unexpectedDirtyPaths = changedAfterEvaluation.all.filter((path) => !changedBeforeEvaluation.all.includes(path));
  if (unexpectedDirtyPaths.length > 0) {
    return {
      status: "failed",
      kept: false,
      reason: `Benchmark or checks dirtied unexpected files: ${unexpectedDirtyPaths.join(", ")}`,
    };
  }

  if (benchmark.timedOut) {
    return {
      status: "failed",
      kept: false,
      reason: "Benchmark timed out",
    };
  }

  if (benchmark.exitCode !== 0) {
    return {
      status: "failed",
      kept: false,
      reason: `Benchmark failed with exit code ${benchmark.exitCode}`,
    };
  }

  const failingCheck = checks.find((check) => !check.passed);
  if (failingCheck) {
    return {
      status: "failed",
      kept: false,
      reason: `Check failed: ${failingCheck.name}`,
    };
  }

  if (typeof benchmark.metric !== "number") {
    return {
      status: "failed",
      kept: false,
      reason: `Metric ${state.benchmark.metric.name} was not extracted`,
    };
  }

  if (typeof state.currentBestMetric !== "number") {
    return {
      status: "baseline",
      kept: true,
      reason: "Baseline recorded",
    };
  }

  const betterDelta = state.benchmark.metric.betterDelta ?? 0;
  const improvement = state.benchmark.metric.direction === "lower"
    ? state.currentBestMetric - benchmark.metric
    : benchmark.metric - state.currentBestMetric;
  const improved = improvement > betterDelta;

  return {
    status: improved ? "kept" : "rejected",
    kept: improved,
    reason: improved
      ? `Improved ${state.benchmark.metric.name} by ${formatMetricValue(improvement, state.benchmark.metric.unit)}`
      : `Did not beat the current best ${state.benchmark.metric.name}`,
    improvement,
  };
}

function evaluateBaselineDecision(
  state: AutoresearchState,
  benchmark: AutoresearchBenchmarkResult,
  checks: ReturnType<typeof runChecks>,
): AutoresearchDecision {
  if (benchmark.timedOut) {
    return {
      status: "failed",
      kept: false,
      reason: "Baseline benchmark timed out",
    };
  }

  if (benchmark.exitCode !== 0) {
    return {
      status: "failed",
      kept: false,
      reason: `Baseline benchmark failed with exit code ${benchmark.exitCode}`,
    };
  }

  const failingCheck = checks.find((check) => !check.passed);
  if (failingCheck) {
    return {
      status: "failed",
      kept: false,
      reason: `Baseline check failed: ${failingCheck.name}`,
    };
  }

  if (typeof benchmark.metric !== "number") {
    return {
      status: "failed",
      kept: false,
      reason: `Baseline metric ${state.benchmark.metric.name} was not extracted`,
    };
  }

  return {
    status: "baseline",
    kept: true,
    reason: "Baseline recorded",
  };
}

function updateStateAfterRecord(state: AutoresearchState, record: AutoresearchExperimentRecord): AutoresearchState {
  const nextState: AutoresearchState = {
    ...state,
    baselineRunId: state.baselineRunId ?? (record.kind === "baseline" ? record.id : state.baselineRunId),
    iterationCount: record.kind === "baseline" ? state.iterationCount : record.iteration,
    lastRunId: record.id,
    currentBestRunId: state.currentBestRunId,
    currentBestMetric: state.currentBestMetric,
    currentBestCommit: state.currentBestCommit,
  };

  if (record.kind === "baseline" && typeof record.benchmark.metric === "number" && record.decision.status !== "failed") {
    nextState.currentBestRunId = record.id;
    nextState.currentBestMetric = record.benchmark.metric;
  }

  if (record.decision.status === "kept" && typeof record.benchmark.metric === "number") {
    nextState.currentBestRunId = record.id;
    nextState.currentBestMetric = record.benchmark.metric;
    nextState.currentBestCommit = record.keptCommit;
  }

  return nextState;
}

function buildStatusResult(
  paths: AutoresearchPaths,
  state: AutoresearchState | undefined,
  records: AutoresearchExperimentRecord[],
): ProcedureResult {
  if (!state) {
    return {
      display: formatMissingAutoresearchDisplay("status"),
      summary: "autoresearch/status: no state",
    };
  }

  const lastRecord = records.at(-1);
  return {
    data: {
      status: state.status,
      branchName: state.branchName,
      bestMetric: state.currentBestMetric,
      iterationCount: state.iterationCount,
      maxIterations: state.maxIterations,
      statePath: paths.statePath,
      logPath: paths.logPath,
      summaryPath: paths.summaryPath,
    },
    display: [
      `Autoresearch is ${state.status} on ${state.branchName}.`,
      `Best ${state.benchmark.metric.name}: ${formatMetricValue(state.currentBestMetric, state.benchmark.metric.unit)}.`,
      `Iterations: ${state.iterationCount}/${state.maxIterations}.`,
      lastRecord ? `Last run: ${lastRecord.id} (${lastRecord.decision.status}).` : "Last run: none.",
      `State: ${paths.statePath}.`,
    ].join("\n") + "\n",
    summary: `autoresearch/status: ${state.status} ${state.branchName}`,
  };
}

function formatMissingAutoresearchDisplay(
  action: "status" | "continue" | "clear" | "finalize",
): string {
  switch (action) {
    case "status":
      return "No autoresearch session exists in this repository yet. Run /autoresearch/start <goal> to create one.\n";
    case "continue":
      return "Cannot continue autoresearch: no session exists in this repository yet. Run /autoresearch/start <goal> to create one.\n";
    case "clear":
      return "Cannot clear autoresearch: no session exists in this repository yet.\n";
    case "finalize":
      return "Cannot finalize autoresearch: no session exists in this repository yet.\n";
  }
}

function prepareAutoresearchBranch(
  paths: AutoresearchPaths,
  state: AutoresearchState,
): { pausedResult: ProcedureResult } | { ok: true } {
  const currentBranch = getCurrentBranch(paths.repoRoot);
  if (currentBranch !== state.branchName) {
    ensureCleanWorktree(paths.repoRoot, "switch to the autoresearch branch");
    switchToBranch(paths.repoRoot, state.branchName);
  }

  try {
    ensureCleanWorktree(paths.repoRoot, "continue autoresearch");
    return { ok: true };
  } catch (error) {
    const nextState = writeAutoresearchState(paths, {
      ...state,
      status: "inactive",
    });
    const records = readExperimentLog(paths);
    writeAutoresearchSummary(paths, nextState, records);
    return {
      pausedResult: {
        data: {
          status: nextState.status,
          branchName: nextState.branchName,
        },
        display: `Autoresearch paused: ${formatErrorMessage(error)}\n`,
        summary: "autoresearch/continue: paused on dirty worktree",
      },
    };
  }
}

function printAutoresearchProgress(ctx: CommandContext, message: string): void {
  ctx.print(`${message}\n`);
}

async function runAutoresearchWithCancellationRecovery(
  paths: AutoresearchPaths,
  run: () => Promise<ProcedureResult>,
): Promise<ProcedureResult> {
  try {
    return await run();
  } catch (error) {
    recoverAutoresearchCancellation(paths, error);
    throw error;
  }
}

function recoverAutoresearchCancellation(paths: AutoresearchPaths, error: unknown): void {
  const cancelled = normalizeRunCancelledError(error);
  if (!cancelled) {
    return;
  }

  const state = readAutoresearchState(paths);
  if (!state || state.status !== "active") {
    return;
  }

  const nextState = writeAutoresearchState(paths, {
    ...state,
    status: "inactive",
  });
  writeAutoresearchSummary(paths, nextState, readExperimentLog(paths));
}

function sanitizeBranchName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/\/{2,}/gu, "/")
    .replace(/^[-/]+|[-/]+$/gu, "")
    .slice(0, 60);
  return slug.length > 0 ? slug : `autoresearch/${crypto.randomUUID().slice(0, 8)}`;
}

function emptyBenchmarkResult(state: AutoresearchState, repoRoot: string): AutoresearchBenchmarkResult {
  return {
    command: summarizeText(state.benchmark.argv.join(" "), 200),
    cwd: repoRoot,
    exitCode: 1,
    stdout: "",
    stderr: "",
    durationMs: 0,
    timedOut: false,
    samples: [],
    metric: undefined,
  };
}

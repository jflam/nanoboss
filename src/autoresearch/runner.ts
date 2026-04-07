import { join } from "node:path";

import typia from "typia";

import { expectData } from "../core/run-result.ts";
import { getSessionDir } from "../core/config.ts";
import { formatErrorMessage } from "../core/error-format.ts";
import {
  jsonType,
  type CommandContext,
  type ProcedureResult,
} from "../core/types.ts";
import { summarizeText } from "../util/text.ts";
import {
  ProcedureDispatchJobManager,
  type ProcedureDispatchStartResult,
  type ProcedureDispatchStatusResult,
} from "../procedure/dispatch-jobs.ts";
import { ProcedureRegistry } from "../procedure/registry.ts";

import { runBenchmark, runChecks } from "./benchmark.ts";
import {
  branchExists,
  commitPaths,
  createAndSwitchBranch,
  ensureCleanWorktree,
  getChangedFiles,
  getCurrentBranch,
  getHeadCommit,
  getMergeBase,
  makeUniqueBranchName,
  cherryPickCommit,
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

export interface AutoresearchRuntime {
  startLoopDispatch(params: {
    cwd: string;
    sessionId: string;
    correlationId: string;
  }): Promise<ProcedureDispatchStartResult>;
  getLoopDispatchStatus(params: {
    cwd: string;
    sessionId: string;
    dispatchId: string;
  }): Promise<ProcedureDispatchStatusResult | undefined>;
  cancelLoopDispatch(params: {
    cwd: string;
    sessionId: string;
    correlationId: string;
  }): void;
}

export async function executeAutoresearchCommand(
  prompt: string,
  ctx: CommandContext,
  runtime: AutoresearchRuntime = defaultAutoresearchRuntime,
): Promise<ProcedureResult> {
  const trimmed = prompt.trim();
  const paths = resolveAutoresearchPaths(ctx.cwd);
  const state = readAutoresearchState(paths);
  const records = readExperimentLog(paths);
  const mode = parseAutoresearchPrompt(trimmed);

  if (mode.kind === "status") {
    return buildStatusResult(paths, state, records, undefined);
  }

  if (!state) {
    if (!trimmed) {
      return {
        display: "Provide an optimization goal for /autoresearch.\n",
        summary: "autoresearch: missing prompt",
      };
    }
    return await initializeAutoresearch(paths, prompt, ctx, runtime);
  }

  const nextState = writeAutoresearchState(paths, {
    ...state,
    status: "active",
    pendingContextNotes: mode.note ? [...state.pendingContextNotes, mode.note] : state.pendingContextNotes,
  });
  const existingStatus = nextState.lastDispatchId
    ? await runtime.getLoopDispatchStatus({
      cwd: paths.repoRoot,
      sessionId: ctx.sessionId,
      dispatchId: nextState.lastDispatchId,
    })
    : undefined;
  if (existingStatus && (existingStatus.status === "queued" || existingStatus.status === "running")) {
    writeAutoresearchSummary(paths, nextState, records);
    return buildStatusResult(paths, nextState, records, existingStatus);
  }

  const launched = await launchNextLoopDispatch(paths, nextState, ctx, runtime);
  const launchedState = writeAutoresearchState(paths, {
    ...nextState,
    lastDispatchId: launched.dispatchId,
    activeDispatchCorrelationId: launched.correlationId,
  });
  writeAutoresearchSummary(paths, launchedState, records);

  return {
    data: {
      status: launchedState.status,
      branchName: launchedState.branchName,
      dispatchId: launched.dispatchId,
      bestMetric: launchedState.currentBestMetric,
      statePath: paths.statePath,
      logPath: paths.logPath,
      summaryPath: paths.summaryPath,
    },
    display: [
      `Autoresearch resumed on ${launchedState.branchName}.`,
      `Best ${launchedState.benchmark.metric.name}: ${formatMetricValue(launchedState.currentBestMetric, launchedState.benchmark.metric.unit)}.`,
      `Loop dispatch: ${launched.dispatchId} (${launched.status}).`,
      `State: ${paths.statePath}.`,
    ].join("\n") + "\n",
    summary: `autoresearch: resumed ${launchedState.branchName}`,
    memory: `Autoresearch is active on ${launchedState.branchName}; state lives at ${paths.statePath}.`,
  };
}

export async function executeAutoresearchLoopCommand(
  prompt: string,
  ctx: CommandContext,
  runtime: AutoresearchRuntime = defaultAutoresearchRuntime,
): Promise<ProcedureResult> {
  void prompt;
  const paths = resolveAutoresearchPaths(ctx.cwd);
  const state = readAutoresearchState(paths);
  if (!state) {
    return {
      display: "No autoresearch state exists in this repository.\n",
      summary: "autoresearch-loop: missing state",
    };
  }

  if (state.status !== "active") {
    const records = readExperimentLog(paths);
    return buildStatusResult(paths, state, records, undefined);
  }

  const prepared = prepareAutoresearchBranch(paths, state);
  if ("pausedResult" in prepared) {
    return prepared.pausedResult;
  }

  const records = readExperimentLog(paths);
  const stateBeforeIteration = writeAutoresearchState(paths, {
    ...state,
    pendingContextNotes: [],
  });

  if (stateBeforeIteration.iterationCount >= stateBeforeIteration.maxIterations) {
    const stoppedState = writeAutoresearchState(paths, {
      ...stateBeforeIteration,
      status: "inactive",
      activeDispatchCorrelationId: undefined,
    });
    writeAutoresearchSummary(paths, stoppedState, records);
    return {
      data: {
        status: stoppedState.status,
        branchName: stoppedState.branchName,
      },
      display: `Autoresearch stopped: reached ${stoppedState.maxIterations} iterations.\n`,
      summary: `autoresearch-loop: max iterations reached`,
    };
  }

  ctx.print(`Autoresearch iteration ${stateBeforeIteration.iterationCount + 1}/${stateBeforeIteration.maxIterations}...\n`);

  const experiment = await proposeExperiment(ctx, stateBeforeIteration, records);
  if (experiment.stop) {
    const stoppedState = writeAutoresearchState(paths, {
      ...stateBeforeIteration,
      status: "inactive",
      activeDispatchCorrelationId: undefined,
    });
    writeAutoresearchSummary(paths, stoppedState, records);
    return {
      data: {
        status: stoppedState.status,
        branchName: stoppedState.branchName,
        reason: experiment.stopReason ?? "agent requested stop",
      },
      display: `Autoresearch stopped: ${experiment.stopReason ?? "agent requested stop"}.\n`,
      summary: `autoresearch-loop: stopped`,
    };
  }

  const iteration = stateBeforeIteration.iterationCount + 1;
  const runId = `run-${String(iteration).padStart(4, "0")}`;
  const applied = await applyExperiment(ctx, stateBeforeIteration, experiment, records);

  const record = await executeExperimentRun({
    runId,
    iteration,
    paths,
    state: stateBeforeIteration,
    priorRecords: records,
    experiment,
    applied,
  });
  appendExperimentRecord(paths, record);

  let nextState = updateStateAfterRecord(stateBeforeIteration, record);
  nextState = writeAutoresearchState(paths, nextState);

  let nextDispatch: ProcedureDispatchStartResult | undefined;
  if (nextState.status === "active" && nextState.iterationCount < nextState.maxIterations) {
    const launched = await launchNextLoopDispatch(paths, nextState, ctx, runtime);
    nextState = writeAutoresearchState(paths, {
      ...nextState,
      lastDispatchId: launched.dispatchId,
      activeDispatchCorrelationId: launched.correlationId,
    });
    nextDispatch = launched;
  } else {
    nextState = writeAutoresearchState(paths, {
      ...nextState,
      status: "inactive",
      activeDispatchCorrelationId: undefined,
    });
  }

  writeAutoresearchSummary(paths, nextState, [...records, record]);

  return {
    data: {
      runId: record.id,
      status: record.decision.status,
      branchName: nextState.branchName,
      metric: record.benchmark.metric,
      bestMetric: nextState.currentBestMetric,
      keptCommit: record.keptCommit,
      nextDispatchId: nextDispatch?.dispatchId,
    },
    display: [
      `Recorded ${record.id}: ${record.decision.status}.`,
      `Metric: ${formatMetricValue(record.benchmark.metric, nextState.benchmark.metric.unit)}.`,
      `Reason: ${record.decision.reason}.`,
      nextDispatch ? `Queued next iteration: ${nextDispatch.dispatchId}.` : "Loop is now inactive.",
    ].join("\n") + "\n",
    summary: `autoresearch-loop: ${record.id} ${record.decision.status}`,
  };
}

export async function executeAutoresearchStopCommand(
  prompt: string,
  ctx: CommandContext,
  runtime: AutoresearchRuntime = defaultAutoresearchRuntime,
): Promise<ProcedureResult> {
  void prompt;
  const paths = resolveAutoresearchPaths(ctx.cwd);
  const state = readAutoresearchState(paths);
  const records = readExperimentLog(paths);
  if (!state) {
    return {
      display: "No autoresearch session exists in this repository.\n",
      summary: "autoresearch-stop: missing state",
    };
  }

  if (state.activeDispatchCorrelationId) {
    runtime.cancelLoopDispatch({
      cwd: paths.repoRoot,
      sessionId: ctx.sessionId,
      correlationId: state.activeDispatchCorrelationId,
    });
  }

  const stoppedState = writeAutoresearchState(paths, {
    ...state,
    status: "inactive",
    activeDispatchCorrelationId: undefined,
  });
  writeAutoresearchSummary(paths, stoppedState, records);

  return {
    data: {
      status: stoppedState.status,
      branchName: stoppedState.branchName,
    },
    display: `Autoresearch stopped for ${stoppedState.branchName}. History was preserved.\n`,
    summary: `autoresearch-stop: ${stoppedState.branchName}`,
  };
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
      display: "No autoresearch session exists in this repository.\n",
      summary: "autoresearch-clear: missing state",
    };
  }

  if (state.status === "active") {
    return {
      display: "Autoresearch is still active. Run /autoresearch-stop before clearing state.\n",
      summary: "autoresearch-clear: active session",
    };
  }

  ensureCleanWorktree(paths.repoRoot, "clear autoresearch state");
  clearAutoresearchArtifacts(paths);

  return {
    data: {
      cleared: true,
      storageDir: paths.storageDir,
    },
    display: `Cleared autoresearch state from ${paths.storageDir}.\n`,
    summary: "autoresearch-clear: cleared state",
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
      display: "No autoresearch session exists in this repository.\n",
      summary: "autoresearch-finalize: missing state",
    };
  }

  ensureCleanWorktree(paths.repoRoot, "finalize autoresearch");
  const records = readExperimentLog(paths);
  const keptRecords = records.filter((record) => record.decision.status === "kept" && record.keptCommit);
  if (keptRecords.length === 0) {
    return {
      data: {
        branches: [],
      },
      display: "No kept experiment commits were logged, so there is nothing to finalize.\n",
      summary: "autoresearch-finalize: no kept commits",
    };
  }

  const originalBranch = getCurrentBranch(paths.repoRoot);
  const createdBranches: AutoresearchFinalizeBranch[] = [];

  try {
    for (const record of keptRecords) {
      const baseName = sanitizeBranchName(`autoresearch-review/${record.iteration}-${record.idea}`);
      const branchName = makeUniqueBranchName(paths.repoRoot, baseName);
      createAndSwitchBranch(paths.repoRoot, branchName, state.mergeBaseCommit);
      const cherryPickedCommit = cherryPickCommit(paths.repoRoot, record.keptCommit as string);
      createdBranches.push({
        runId: record.id,
        sourceCommit: record.keptCommit as string,
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
    summary: `autoresearch-finalize: ${createdBranches.length} branches`,
  };
}

async function initializeAutoresearch(
  paths: AutoresearchPaths,
  prompt: string,
  ctx: CommandContext,
  runtime: AutoresearchRuntime,
): Promise<ProcedureResult> {
  ensureCleanWorktree(paths.repoRoot, "start autoresearch");
  ctx.print("Configuring autoresearch session...\n");

  const initPlan = await buildInitializationPlan(prompt, ctx);
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
    goal: prompt.trim(),
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

  const baseline = runBenchmark(state.benchmark, paths.repoRoot);
  const baselineChecks = baseline.exitCode === 0 ? runChecks(state.checks, paths.repoRoot) : [];
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

  if (baselineRecord.decision.status === "failed") {
    state = writeAutoresearchState(paths, {
      ...state,
      status: "inactive",
    });
    writeAutoresearchSummary(paths, state, [baselineRecord]);
    return {
      data: {
        status: state.status,
        branchName: state.branchName,
        statePath: paths.statePath,
        logPath: paths.logPath,
      },
      display: [
        `Autoresearch initialized on ${state.branchName}, but the baseline failed.`,
        `Reason: ${baselineRecord.decision.reason}.`,
        `State: ${paths.statePath}.`,
      ].join("\n") + "\n",
      summary: "autoresearch: baseline failed",
    };
  }

  const launched = await launchNextLoopDispatch(paths, state, ctx, runtime);
  state = writeAutoresearchState(paths, {
    ...state,
    lastDispatchId: launched.dispatchId,
    activeDispatchCorrelationId: launched.correlationId,
  });
  writeAutoresearchSummary(paths, state, [baselineRecord]);

  return {
    data: {
      status: state.status,
      branchName: state.branchName,
      dispatchId: launched.dispatchId,
      bestMetric: state.currentBestMetric,
      statePath: paths.statePath,
      logPath: paths.logPath,
      summaryPath: paths.summaryPath,
    },
    display: [
      `Autoresearch initialized on ${state.branchName}.`,
      `Baseline ${state.benchmark.metric.name}: ${formatMetricValue(state.currentBestMetric, state.benchmark.metric.unit)}.`,
      `Loop dispatch: ${launched.dispatchId} (${launched.status}).`,
      `State: ${paths.statePath}.`,
    ].join("\n") + "\n",
    summary: `autoresearch: initialized ${state.branchName}`,
    memory: `Autoresearch baseline is ready on ${state.branchName}; state lives at ${paths.statePath}.`,
  };
}

async function buildInitializationPlan(prompt: string, ctx: CommandContext): Promise<AutoresearchInitPlan> {
  const result = await ctx.callAgent(
    [
      "You are configuring a deterministic autoresearch optimization session for NanoBoss.",
      "Inspect the repository and the user's goal, then return a JSON object matching this schema exactly.",
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
      checks = benchmark.exitCode === 0 ? runChecks(params.state.checks, params.paths.repoRoot) : [];
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
  dispatchStatus: ProcedureDispatchStatusResult | undefined,
): ProcedureResult {
  if (!state) {
    return {
      display: "No autoresearch session exists in this repository.\n",
      summary: "autoresearch: no state",
    };
  }

  const lastRecord = records.at(-1);
  return {
    data: {
      status: state.status,
      branchName: state.branchName,
      bestMetric: state.currentBestMetric,
      iterationCount: state.iterationCount,
      dispatchStatus: dispatchStatus?.status,
      statePath: paths.statePath,
      logPath: paths.logPath,
      summaryPath: paths.summaryPath,
    },
    display: [
      `Autoresearch is ${state.status} on ${state.branchName}.`,
      `Best ${state.benchmark.metric.name}: ${formatMetricValue(state.currentBestMetric, state.benchmark.metric.unit)}.`,
      `Iterations: ${state.iterationCount}/${state.maxIterations}.`,
      dispatchStatus ? `Loop dispatch: ${dispatchStatus.dispatchId} (${dispatchStatus.status}).` : "Loop dispatch: idle.",
      lastRecord ? `Last run: ${lastRecord.id} (${lastRecord.decision.status}).` : "Last run: none.",
      `State: ${paths.statePath}.`,
    ].join("\n") + "\n",
    summary: `autoresearch: ${state.status} ${state.branchName}`,
  };
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
      activeDispatchCorrelationId: undefined,
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
        summary: "autoresearch-loop: paused on dirty worktree",
      },
    };
  }
}

async function launchNextLoopDispatch(
  paths: AutoresearchPaths,
  state: AutoresearchState,
  ctx: CommandContext,
  runtime: AutoresearchRuntime,
): Promise<ProcedureDispatchStartResult & { correlationId: string }> {
  const correlationId = buildDispatchCorrelationId(state);
  const started = await runtime.startLoopDispatch({
    cwd: paths.repoRoot,
    sessionId: ctx.sessionId,
    correlationId,
  });
  return {
    ...started,
    correlationId,
  };
}

function buildDispatchCorrelationId(state: AutoresearchState): string {
  const slug = sanitizeBranchName(state.branchName).replace(/\//gu, "-");
  return `${slug}-${state.iterationCount + 1}-${crypto.randomUUID().slice(0, 8)}`;
}

function parseAutoresearchPrompt(trimmedPrompt: string): { kind: "status" | "resume"; note?: string } {
  if (/^status(?:\s+|$)/iu.test(trimmedPrompt)) {
    return { kind: "status" };
  }

  const resumeMatch = /^(?:resume|continue)(?:\s+(.+))?$/iu.exec(trimmedPrompt);
  if (resumeMatch) {
    return {
      kind: "resume",
      note: resumeMatch[1]?.trim() || undefined,
    };
  }

  return {
    kind: "resume",
    note: trimmedPrompt || undefined,
  };
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

const defaultAutoresearchRuntime: AutoresearchRuntime = {
  async startLoopDispatch(params) {
    const manager = createDispatchManager(params.cwd, params.sessionId);
    return await manager.start({
      name: "autoresearch-loop",
      prompt: "",
      dispatchCorrelationId: params.correlationId,
    });
  },
  async getLoopDispatchStatus(params) {
    const manager = createDispatchManager(params.cwd, params.sessionId);
    try {
      return await manager.status(params.dispatchId);
    } catch {
      return undefined;
    }
  },
  cancelLoopDispatch(params) {
    const manager = createDispatchManager(params.cwd, params.sessionId);
    manager.cancelByCorrelationId(params.correlationId);
  },
};

function createDispatchManager(cwd: string, sessionId: string): ProcedureDispatchJobManager {
  return new ProcedureDispatchJobManager({
    cwd,
    sessionId,
    rootDir: getSessionDir(sessionId),
    getRegistry: async () => {
      const registry = new ProcedureRegistry({
        commandsDir: join(cwd, "commands"),
      });
      registry.loadBuiltins();
      await registry.loadFromDisk();
      return registry;
    },
  });
}
